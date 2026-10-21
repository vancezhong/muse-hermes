import { WebSocket, WebSocketServer } from 'ws'

const FUNASR_URL = process.env.FUNASR_URL || 'ws://127.0.0.1:10095'
const COSYVOICE_URL = (process.env.COSYVOICE_URL || 'http://127.0.0.1:50000').replace(/\/$/, '')
const COSYVOICE_PATH = process.env.COSYVOICE_TTS_PATH || '/stream/inference_sft'
const COSYVOICE_SAMPLE_RATE = Number(process.env.COSYVOICE_SAMPLE_RATE || 22050)
const COSYVOICE_SPEAKER = process.env.COSYVOICE_SPEAKER || '中文女'
const MAX_TTS_TEXT = 3000

const attachedServers = new WeakSet()
const voiceSockets = new Set()

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

function parseUrl(value) {
  try { return new URL(value) } catch { return null }
}

function isLoopback(url) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url?.hostname || '')
}

function originMatches(request) {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === request.headers.host && ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function sendSocketJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function upstreamError(error) {
  const code = error?.code || error?.cause?.code
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'FunASR 本地服务未连接。'
  if (error?.message?.includes('Unexpected server response: 404')) return 'FunASR 地址不正确，或服务端没有启用 WebSocket 接口。'
  return 'FunASR 连接中断，请检查本地识别服务。'
}

function attachAsrConnection(browser) {
  const upstreamUrl = parseUrl(FUNASR_URL)
  if (!upstreamUrl || !['ws:', 'wss:'].includes(upstreamUrl.protocol)) {
    sendSocketJson(browser, { type: 'error', message: 'FUNASR_URL 必须是 ws:// 或 wss:// 地址。' })
    browser.close(1011, 'Invalid FunASR URL')
    return
  }

  const asr = new WebSocket(FUNASR_URL, ['binary'], {
    handshakeTimeout: 5000,
    maxPayload: 1024 * 1024,
  })
  let isReady = false
  let closeRequested = false
  voiceSockets.add(browser)
  voiceSockets.add(asr)

  const closeUpstream = () => {
    if (closeRequested) return
    closeRequested = true
    if (asr.readyState === WebSocket.OPEN || asr.readyState === WebSocket.CONNECTING) asr.close()
  }

  asr.once('open', () => {
    isReady = true
    asr.send(JSON.stringify({
      mode: '2pass',
      audio_fs: 16000,
      chunk_size: [5, 10, 5],
      chunk_interval: 10,
      encoder_chunk_look_back: 4,
      decoder_chunk_look_back: 1,
      wav_name: 'muse-microphone',
    }))
    sendSocketJson(browser, { type: 'ready', engine: 'FunASR', sampleRate: 16000 })
  })

  asr.on('message', (data, isBinary) => {
    if (isBinary) return
    let result
    try { result = JSON.parse(data.toString()) } catch { return }
    if (result.error) {
      sendSocketJson(browser, { type: 'error', message: `FunASR 识别失败：${String(result.error).slice(0, 400)}` })
      return
    }
    if (typeof result.text !== 'string') return
    const mode = String(result.mode || '')
    const isFinal = Boolean(result.is_final) || mode.includes('offline')
    sendSocketJson(browser, {
      type: 'transcript',
      text: result.text,
      isFinal,
      mode,
    })
  })

  asr.on('error', (error) => {
    if (browser.readyState === WebSocket.OPEN) {
      sendSocketJson(browser, { type: 'error', message: upstreamError(error) })
      browser.close(1011, 'FunASR connection failed')
    }
  })
  asr.on('close', () => {
    voiceSockets.delete(asr)
    if (!closeRequested && browser.readyState === WebSocket.OPEN) {
      sendSocketJson(browser, { type: 'error', message: 'FunASR 识别连接已关闭。' })
      browser.close(1011, 'FunASR connection closed')
    }
  })

  browser.on('message', (data, isBinary) => {
    if (!isReady || asr.readyState !== WebSocket.OPEN) return
    if (isBinary) {
      if (data.byteLength > 24 * 1024) {
        sendSocketJson(browser, { type: 'error', message: '音频帧过大，已断开语音连接。' })
        browser.close(1009, 'Audio frame too large')
        return
      }
      if (asr.bufferedAmount >= 1024 * 1024) {
        sendSocketJson(browser, { type: 'error', message: '本地识别服务处理音频较慢，语音连接已暂停。请重新进入语音聊天。' })
        browser.close(1013, 'FunASR audio backpressure')
        closeUpstream()
        return
      }
      asr.send(data, { binary: true })
      return
    }
    try {
      const command = JSON.parse(data.toString())
      if (command.type === 'finish') {
        asr.send(JSON.stringify({ is_speaking: false, is_end: true }))
      }
    } catch { /* Unknown control frames are ignored. */ }
  })

  browser.once('close', () => {
    voiceSockets.delete(browser)
    closeUpstream()
  })
  browser.once('error', closeUpstream)
}

export function attachVoiceWebSocket(server) {
  if (attachedServers.has(server)) return
  attachedServers.add(server)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

  server.on('upgrade', (request, socket, head) => {
    let pathname
    try { pathname = new URL(request.url || '/', 'http://localhost').pathname } catch { return }
    if (pathname !== '/api/voice/asr') return
    if (!originMatches(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request)
    })
  })

  wss.on('connection', attachAsrConnection)
  server.once('close', () => {
    for (const socket of voiceSockets) {
      try { socket.close(1001, 'Muse server shutting down') } catch { /* Already closed. */ }
    }
    voiceSockets.clear()
    wss.close()
    attachedServers.delete(server)
  })
}

function probeFunAsr() {
  return new Promise((resolve) => {
    const url = parseUrl(FUNASR_URL)
    if (!url || !['ws:', 'wss:'].includes(url.protocol)) return resolve(false)
    let done = false
    const finish = (available) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { socket.close() } catch { /* Ignore probe cleanup. */ }
      resolve(available)
    }
    const socket = new WebSocket(FUNASR_URL, ['binary'], { handshakeTimeout: 1600, maxPayload: 1024 })
    const timer = setTimeout(() => finish(false), 1800)
    socket.once('open', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function probeCosyVoice() {
  const base = parseUrl(COSYVOICE_URL)
  if (!base || !['http:', 'https:'].includes(base.protocol)) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1600)
  try {
    const response = await fetch(`${COSYVOICE_URL}/health`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function getVoiceHealth() {
  const [asrAvailable, ttsAvailable] = await Promise.all([probeFunAsr(), probeCosyVoice()])
  const asrUrl = parseUrl(FUNASR_URL)
  const ttsUrl = parseUrl(COSYVOICE_URL)
  return {
    asr: { name: 'FunASR', available: asrAvailable, local: isLoopback(asrUrl) },
    tts: {
      name: 'CosyVoice',
      available: ttsAvailable,
      local: isLoopback(ttsUrl),
      streaming: COSYVOICE_PATH.startsWith('/stream/'),
    },
  }
}

async function readJson(request) {
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > 12 * 1024) throw Object.assign(new Error('合成文本过长。'), { status: 413 })
  }
  try { return text ? JSON.parse(text) : {} } catch { throw Object.assign(new Error('请求内容不是有效 JSON。'), { status: 400 }) }
}

async function tts(request, response) {
  const payload = await readJson(request)
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) return json(response, 400, { error: '没有可合成的文本。' })
  if (text.length > MAX_TTS_TEXT) return json(response, 413, { error: `单次语音合成最多 ${MAX_TTS_TEXT} 个字符。` })

  const controller = new AbortController()
  let ended = false
  response.on('close', () => {
    ended = true
    controller.abort()
  })

  const paths = [COSYVOICE_PATH]
  if (COSYVOICE_PATH.startsWith('/stream/')) paths.push(COSYVOICE_PATH.replace('/stream/', '/'))
  let upstream
  let usedPath = paths[0]
  try {
    for (const path of paths) {
      usedPath = path
      const form = new FormData()
      form.set('tts_text', text)
      form.set('spk_id', COSYVOICE_SPEAKER)
      upstream = await fetch(new URL(path, `${COSYVOICE_URL}/`), {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
      if (upstream.status !== 404 && upstream.status !== 405) break
      await upstream.body?.cancel()
    }
    if (!upstream?.ok || !upstream.body) {
      const status = upstream?.status || 502
      if (!response.headersSent && !ended) json(response, 502, {
        error: status === 404
          ? 'CosyVoice 未提供流式合成接口。请启动 Muse 附带的流式服务，或检查 COSYVOICE_TTS_PATH。'
          : `CosyVoice 返回 HTTP ${status}。`,
      })
      return
    }

    const sampleRate = Number(upstream.headers.get('x-custom-header-samplerate') || upstream.headers.get('x-sample-rate') || COSYVOICE_SAMPLE_RATE)
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Muse-Sample-Rate': String(sampleRate),
      'X-Muse-Sample-Format': 'pcm_s16le',
      'X-Muse-TTS-Mode': usedPath.startsWith('/stream/') ? 'stream' : 'buffered',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    })

    const reader = upstream.body.getReader()
    while (!ended) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(value)) await new Promise((resolve) => response.once('drain', resolve))
    }
    if (!ended) response.end()
  } catch (error) {
    if (controller.signal.aborted || ended) return
    if (!response.headersSent) {
      const message = error.cause?.code === 'ECONNREFUSED'
        ? 'CosyVoice 本地服务未连接。'
        : 'CosyVoice 流式合成失败，请检查本地服务。'
      json(response, 502, { error: message })
    } else {
      response.destroy(error)
    }
  }
}

export async function handleVoiceHttp(request, response, pathname) {
  const method = request.method || 'GET'
  if (pathname === '/api/voice/health' && method === 'GET') {
    json(response, 200, await getVoiceHealth())
    return true
  }
  if (pathname === '/api/voice/tts' && method === 'POST') {
    await tts(request, response)
    return true
  }
  return false
}
