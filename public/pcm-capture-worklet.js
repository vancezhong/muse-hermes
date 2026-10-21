class MusePcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const targetRate = options.processorOptions?.targetRate || 16000
    this.inputPerOutput = sampleRate / targetRate
    this.binWeight = 0
    this.binSum = 0
    this.outputSamples = []
    this.frameSamples = options.processorOptions?.frameSamples || 960
    this.levelSamples = 320
    this.levelSum = 0
    this.levelCount = 0
    this.noiseFloor = 0.004
    this.loudFrames = 0
    this.quietFrames = 0
    this.inSpeech = false
    this.port.onmessage = (event) => {
      if (event.data?.type === 'reset-vad') {
        this.inSpeech = false
        this.loudFrames = 0
        this.quietFrames = 0
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    for (const channel of outputs[0] || []) channel.fill(0)
    if (!input?.length) return true

    for (let index = 0; index < input.length; index += 1) {
      let remaining = 1
      const sample = input[index]
      while (remaining > 1e-6) {
        const take = Math.min(remaining, this.inputPerOutput - this.binWeight)
        this.binSum += sample * take
        this.binWeight += take
        remaining -= take
        if (this.binWeight >= this.inputPerOutput - 1e-6) {
          const normalized = Math.max(-1, Math.min(1, this.binSum / this.inputPerOutput))
          const pcm = normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff
          this.outputSamples.push(pcm | 0)
          this.levelSum += normalized * normalized
          this.levelCount += 1
          this.binWeight = 0
          this.binSum = 0

          if (this.levelCount >= this.levelSamples) this.updateVoiceActivity()
          if (this.outputSamples.length >= this.frameSamples) this.flushAudio()
        }
      }
    }
    return true
  }

  updateVoiceActivity() {
    const rms = Math.sqrt(this.levelSum / Math.max(1, this.levelCount))
    this.levelSum = 0
    this.levelCount = 0

    const threshold = Math.max(0.012, this.noiseFloor * 3.4)
    if (rms >= threshold) {
      this.loudFrames += 1
      this.quietFrames = 0
      if (!this.inSpeech && this.loudFrames >= 2) {
        this.inSpeech = true
        this.port.postMessage({ type: 'speech-start', level: rms })
      }
    } else {
      this.loudFrames = 0
      if (this.inSpeech) {
        this.quietFrames += 1
        if (this.quietFrames >= 28) {
          this.inSpeech = false
          this.quietFrames = 0
        }
      } else {
        this.noiseFloor = Math.max(0.002, Math.min(0.035, this.noiseFloor * 0.96 + rms * 0.04))
      }
    }
  }

  flushAudio() {
    const samples = Int16Array.from(this.outputSamples)
    this.outputSamples = []
    this.port.postMessage({ type: 'pcm', buffer: samples.buffer }, [samples.buffer])
  }
}

registerProcessor('muse-pcm-capture', MusePcmCapture)
