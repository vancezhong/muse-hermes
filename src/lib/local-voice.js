function websocketUrl(path) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}`
}

function concatBytes(left, right) {
  if (!left.length) return right
  if (!right.length) return left
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left)
  joined.set(right, left.length)
  return joined
}

export class LocalVoiceSession {
  static async connect({ onEvent, onSpeechStart, onError }) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前页面无法访问麦克风。请使用 localhost 或 HTTPS。')
    if (!window.AudioContext || !window.AudioWorkletNode) throw new Error('当前浏览器缺少实时音频支持，请使用新版 Edge、Chrome 或 Safari。')

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const context = new AudioContext({ latencyHint: 'interactive' })
    let socket
    let source
    let processor
    let muteGain
    try {
      await context.audioWorklet.addModule('/pcm-capture-worklet.js')
      socket = new WebSocket(websocketUrl('/api/voice/asr'))
      socket.binaryType = 'arraybuffer'
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('FunASR 连接超时。')), 9000)
        socket.addEventListener('message', function onReady(event) {
          let message
          try { message = JSON.parse(event.data) } catch { return }
          if (message.type === 'ready') {
            clearTimeout(timeout)
            socket.removeEventListener('message', onReady)
            resolve()
          } else if (message.type === 'error') {
            clearTimeout(timeout)
            socket.removeEventListener('message', onReady)
            reject(new Error(message.message || 'FunASR 连接失败。'))
          }
        })
        socket.addEventListener('error', () => {
          clearTimeout(timeout)
          reject(new Error('连接不到 FunASR。请确认本机识别服务已经启动。'))
        }, { once: true })
        socket.addEventListener('close', () => {
          clearTimeout(timeout)
          reject(new Error('FunASR 已关闭连接。'))
        }, { once: true })
      })

      source = context.createMediaStreamSource(stream)
      processor = new AudioWorkletNode(context, 'muse-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { targetRate: 16000, frameSamples: 960 },
      })
      muteGain = context.createGain()
      muteGain.gain.value = 0
      source.connect(processor)
      processor.connect(muteGain)
      muteGain.connect(context.destination)

      socket.addEventListener('message', (event) => {
        let message
        try { message = JSON.parse(event.data) } catch { return }
        if (message.type === 'transcript') onEvent?.(message)
        else if (message.type === 'error') onError?.(new Error(message.message || '语音服务发生错误。'))
      })
      socket.addEventListener('close', () => onError?.(new Error('FunASR 语音连接已断开。')))
      socket.addEventListener('error', () => onError?.(new Error('FunASR 语音连接发生错误。')))
      processor.port.onmessage = (event) => {
        const item = event.data || {}
        if (item.type === 'speech-start') onSpeechStart?.()
        if (item.type === 'pcm' && socket.readyState === WebSocket.OPEN) {
          if (socket.bufferedAmount >= 1024 * 1024) {
            onError?.(new Error('FunASR 本地服务处理音频较慢，语音连接已暂停。'))
            socket.close(1013, 'ASR audio backpressure')
            return
          }
          socket.send(item.buffer)
        }
      }
      await context.resume()
      return new LocalVoiceSession({ stream, context, socket, source, processor, muteGain })
    } catch (error) {
      try { socket?.close() } catch { /* Ignore close race. */ }
      stream.getTracks().forEach((track) => track.stop())
      try { await context.close() } catch { /* Ignore audio context cleanup. */ }
      throw error
    }
  }

  constructor({ stream, context, socket, source, processor, muteGain }) {
    this.stream = stream
    this.context = context
    this.socket = socket
    this.source = source
    this.processor = processor
    this.muteGain = muteGain
    this.sources = new Set()
    this.nextAudioTime = context.currentTime + 0.045
    this.stopped = false
  }

  setMuted(muted) {
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted
    if (muted) this.processor.port.postMessage({ type: 'reset-vad' })
  }

  async speak(text, { signal, onStart } = {}) {
    if (this.stopped) throw new Error('语音会话已结束。')
    const response = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || `CosyVoice 返回 ${response.status}`)
    }
    if (!response.body) throw new Error('CosyVoice 没有返回音频流。')

    const sampleRate = Number(response.headers.get('x-muse-sample-rate') || 22050)
    const frameSamples = Math.max(1024, Math.round(sampleRate * 0.12))
    const reader = response.body.getReader()
    let byteCarry = new Uint8Array(0)
    let sampleBuffer = new Float32Array(0)
    let started = false

    const schedule = (samples) => {
      if (signal?.aborted || this.stopped || !samples.length) return
      const buffer = this.context.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      const node = this.context.createBufferSource()
      node.buffer = buffer
      node.connect(this.context.destination)
      const startAt = Math.max(this.nextAudioTime, this.context.currentTime + 0.035)
      this.nextAudioTime = startAt + buffer.duration
      this.sources.add(node)
      node.onended = () => this.sources.delete(node)
      if (!started) {
        started = true
        onStart?.()
      }
      node.start(startAt)
    }

    const addSamples = (bytes) => {
      const completeLength = bytes.length - (bytes.length % 2)
      byteCarry = bytes.slice(completeLength)
      if (!completeLength) return
      const view = new DataView(bytes.buffer, bytes.byteOffset, completeLength)
      const added = new Float32Array(completeLength / 2)
      for (let index = 0; index < added.length; index += 1) added[index] = view.getInt16(index * 2, true) / 32768
      const combined = new Float32Array(sampleBuffer.length + added.length)
      combined.set(sampleBuffer)
      combined.set(added, sampleBuffer.length)
      let offset = 0
      while (combined.length - offset >= frameSamples) {
        schedule(combined.slice(offset, offset + frameSamples))
        offset += frameSamples
      }
      sampleBuffer = combined.slice(offset)
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value?.length) addSamples(concatBytes(byteCarry, value))
      }
      if (sampleBuffer.length) schedule(sampleBuffer)
    } finally {
      reader.releaseLock()
    }
  }

  stopPlayback() {
    for (const source of this.sources) {
      try { source.stop() } catch { /* Already ended. */ }
    }
    this.sources.clear()
    this.nextAudioTime = this.context.currentTime + 0.045
  }

  get hasQueuedAudio() {
    return this.sources.size > 0
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.stopPlayback()
    try { this.source.disconnect() } catch { /* Already disconnected. */ }
    try { this.processor.disconnect() } catch { /* Already disconnected. */ }
    try { this.muteGain.disconnect() } catch { /* Already disconnected. */ }
    try { this.socket.close(1000, 'Voice session ended') } catch { /* Already closed. */ }
    this.stream.getTracks().forEach((track) => track.stop())
    this.context.close().catch(() => {})
  }
}
