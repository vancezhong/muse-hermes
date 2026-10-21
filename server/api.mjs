import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { HermesAcpClient } from './acp-client.mjs'
import { handleVoiceHttp } from './voice.mjs'

const profile = process.env.HERMES_PROFILE || 'default'
let client = null
let clientPromise = null
const sessions = new Map()
const permissions = new Map()
const MAX_BODY = 64 * 1024

class SessionChannel extends EventEmitter {
  constructor(id) {
    super()
    this.id = id
    this.seq = 0
    this.events = []
    this.listeners = new Set()
    this.busy = false
    this.cancelRequested = false
    this.queue = []
    this.loaded = true
    this.loading = null
    this.replaying = false
    this.replayBuffer = []
  }

  publish(payload) {
    const event = { id: ++this.seq, data: { sessionId: this.id, ...payload } }
    this.events.push(event)
    if (this.events.length > 240) this.events.shift()
    for (const response of this.listeners) writeEvent(response, event)
  }
}

function writeEvent(response, event) {
  response.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`)
}

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

function localOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === request.headers.host && ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

async function readJson(request) {
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > MAX_BODY) throw Object.assign(new Error('请求内容过大。'), { status: 413 })
  }
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求内容不是有效 JSON。'), { status: 400 })
  }
}

async function ensureClient() {
  if (client && client.child && client.child.exitCode === null) return client
  if (clientPromise) return clientPromise

  const instance = new HermesAcpClient(profile)
  client = instance
  instance.on('notification', (frame) => {
    if (frame.method !== 'session/update') return
    const { sessionId, update } = frame.params || {}
    const channel = sessions.get(sessionId)
    if (!channel || !update) return
    if (channel.replaying) {
      channel.replayBuffer.push(update)
      return
    }
    channel.publish(convertUpdate(update))
  })
  instance.on('serverRequest', (frame) => handleServerRequest(instance, frame))
  instance.on('exit', () => {
    if (client === instance) client = null
    for (const [requestId, permission] of permissions) {
      if (permission.instance === instance) permissions.delete(requestId)
    }
    for (const channel of sessions.values()) {
      channel.busy = false
      channel.publish({ type: 'connection_lost', message: 'Hermes 连接已断开，请重新连接。' })
    }
  })

  clientPromise = instance.start().then(() => instance).catch((error) => {
    if (client === instance) client = null
    const message = error.code === 'ENOENT'
      ? '找不到 hermes 命令。请确认 Hermes 已安装，或设置 HERMES_BIN。'
      : `无法连接本地 Hermes profile「${profile}」。请检查 Hermes ACP 状态。`
    throw Object.assign(new Error(message), { cause: error })
  }).finally(() => {
    clientPromise = null
  })
  return clientPromise
}

function updateTag(update) {
  return update.sessionUpdate || update.session_update || update.type || ''
}

function convertUpdate(update) {
  const tag = updateTag(update)
  if (tag === 'agent_message_chunk') {
    return { type: 'assistant_delta', text: update.content?.text || '' }
  }
  if (tag === 'agent_thought_chunk') {
    return { type: 'thought_delta', text: update.content?.text || '' }
  }
  if (tag === 'tool_call' || tag === 'tool_call_update') {
    const tool = update.toolCall || update.tool_call || update
    return {
      type: 'tool_update',
      tool: {
        id: tool.toolCallId || tool.tool_call_id || tool.id || randomUUID(),
        title: tool.title || tool.name || 'Hermes 工具',
        kind: tool.kind || 'other',
        status: tool.status === 'in_progress' ? 'running' : (tool.status || 'running'),
        content: (tool.content || []).map((part) => part?.content?.text || part?.text || '').filter(Boolean).join('\n'),
      },
    }
  }
  if (tag === 'agent_plan') {
    return { type: 'plan_update', entries: update.entries || [] }
  }
  if (tag === 'current_mode_update') {
    return { type: 'mode_update', mode: update.currentModeId || update.current_mode_id || '' }
  }
  if (tag === 'session_info_update') {
    return { type: 'session_info', title: update.title || '' }
  }
  if (tag === 'available_commands_update') {
    return { type: 'commands_update', commands: update.availableCommands || [] }
  }
  return { type: 'agent_update', tag }
}

function handleServerRequest(instance, frame) {
  if (frame.method !== 'session/request_permission') {
    instance.respondError(frame.id, -32601, 'This client does not support that Hermes request.')
    return
  }
  const params = frame.params || {}
  const channel = sessions.get(params.sessionId)
  if (!channel) {
    instance.respond(frame.id, { outcome: { outcome: 'cancelled' } })
    return
  }
  permissions.set(String(frame.id), { instance, rpcId: frame.id, channel, options: params.options || [] })
  channel.publish({
    type: 'permission_required',
    requestId: String(frame.id),
    toolCall: params.toolCall || {},
    options: params.options || [],
  })
}

async function createSession(request, response) {
  const hermes = await ensureClient()
  const payload = await readJson(request)
  const cwd = typeof payload.cwd === 'string' && payload.cwd.startsWith('/') ? payload.cwd : process.cwd()
  const result = await hermes.request('session/new', { cwd, mcpServers: [] }, 45000)
  if (!result.sessionId) throw new Error('Hermes 没有返回会话 ID。')
  const channel = new SessionChannel(result.sessionId)
  sessions.set(channel.id, channel)
  json(response, 201, { id: channel.id, profile, title: '' })
}

async function ensureSessionLoaded(hermes, id, channel) {
  if (!channel) {
    channel = new SessionChannel(id)
    channel.loaded = false
    sessions.set(id, channel)
  }
  if (channel.loaded) return
  if (!channel.loading) {
    channel.replaying = true
    channel.replayBuffer = []
    channel.loading = hermes.request('session/load', {
      sessionId: id,
      cwd: process.cwd(),
      mcpServers: [],
    }, 45000).then((result) => {
      if (!result) throw new Error('Hermes session not found.')
      channel.loaded = true
      channel.replaying = false
      const updates = channel.replayBuffer.splice(0)
      channel.publish({ type: 'history_loaded', updates, title: result.title || '' })
    }).catch((error) => {
      channel.replaying = false
      channel.loaded = false
      channel.replayBuffer = []
      throw error
    }).finally(() => {
      channel.loading = null
    })
  }
  await channel.loading
}

async function loadSession(request, response, id) {
  const hermes = await ensureClient()
  let channel = sessions.get(id)
  if (!channel) {
    channel = new SessionChannel(id)
    channel.loaded = false
    sessions.set(id, channel)
  }
  await ensureSessionLoaded(hermes, id, channel)
  json(response, 200, { id, loaded: true })
}

function runPrompt(channel, text) {
  const hermes = client
  if (!hermes) throw new Error('Hermes 尚未连接。')
  channel.busy = true
  channel.cancelRequested = false
  channel.publish({ type: 'turn_started' })
  hermes.request('session/prompt', {
    sessionId: channel.id,
    prompt: [{ type: 'text', text }],
  }).then((result) => {
    channel.busy = false
    channel.cancelRequested = false
    channel.publish({ type: 'turn_completed', stopReason: result.stopReason || 'end_turn' })
    const next = channel.queue.shift()
    if (next) runPrompt(channel, next)
  }).catch((error) => {
    channel.busy = false
    channel.cancelRequested = false
    channel.publish({ type: 'turn_error', message: error.message || 'Hermes 请求失败。' })
    const next = channel.queue.shift()
    if (next) runPrompt(channel, next)
  })
}

async function submitPrompt(request, response, id) {
  const payload = await readJson(request)
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) return json(response, 400, { error: '请输入要发送的内容。' })
  if (text.length > 12000) return json(response, 413, { error: '单条消息不能超过 12,000 个字符。' })

  const hermes = await ensureClient()
  let channel = sessions.get(id)
  if (!channel) {
    channel = new SessionChannel(id)
    channel.loaded = false
    sessions.set(id, channel)
  }
  if (!channel.loaded) {
    await ensureSessionLoaded(hermes, id, channel)
  }
  if (channel.busy) {
    if (!channel.cancelRequested) return json(response, 409, { error: 'Hermes 正在回复。' })
    channel.queue.push(text)
    channel.publish({ type: 'prompt_queued' })
    return json(response, 202, { accepted: true, queued: true })
  }
  runPrompt(channel, text)
  json(response, 202, { accepted: true, queued: false, profile: hermes.profile })
}

function sendEventStream(request, response, id) {
  let channel = sessions.get(id)
  if (!channel) {
    channel = new SessionChannel(id)
    channel.loaded = false
    sessions.set(id, channel)
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write(': connected\n\n')
  const lastId = Number(request.headers['last-event-id'] || 0)
  for (const event of channel.events) {
    if (event.id > lastId) writeEvent(response, event)
  }
  channel.listeners.add(response)
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20000)
  request.on('close', () => {
    clearInterval(heartbeat)
    channel.listeners.delete(response)
  })
}

async function resolvePermission(request, response, id, requestId) {
  const item = permissions.get(requestId)
  if (!item || item.channel.id !== id) return json(response, 404, { error: '这个授权请求已过期。' })
  const payload = await readJson(request)
  const optionId = typeof payload.optionId === 'string' ? payload.optionId : ''
  const selected = item.options.find((option) => (option.optionId || option.option_id) === optionId)
  if (!selected) return json(response, 400, { error: '请选择列表中的一个授权选项。' })
  permissions.delete(requestId)
  item.instance.respond(item.rpcId, { outcome: { outcome: 'selected', optionId } })
  item.channel.publish({ type: 'permission_resolved', requestId, optionId })
  json(response, 200, { accepted: true })
}

async function handle(request, response) {
  const url = new URL(request.url || '/', 'http://localhost')
  const method = request.method || 'GET'
  if (!url.pathname.startsWith('/api/')) return false
  if (!localOrigin(request)) return json(response, 403, { error: '跨站请求被拒绝。' })

  if (await handleVoiceHttp(request, response, url.pathname)) return true

  if (url.pathname === '/api/health' && method === 'GET') {
    try {
      await ensureClient()
      json(response, 200, { connected: true, profile, transport: 'ACP' })
    } catch (error) {
      json(response, 503, { connected: false, profile, error: error.message })
    }
    return true
  }
  if (url.pathname === '/api/sessions' && method === 'POST') {
    await createSession(request, response)
    return true
  }

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/)
  if (!match) {
    json(response, 404, { error: '找不到这个 API。' })
    return true
  }
  const id = decodeURIComponent(match[1])
  const action = match[2] || ''

  if (action === 'events' && method === 'GET') {
    sendEventStream(request, response, id)
    return true
  }
  if (action === 'load' && method === 'POST') {
    await loadSession(request, response, id)
    return true
  }
  if (action === 'prompt' && method === 'POST') {
    await submitPrompt(request, response, id)
    return true
  }
  if (action === 'cancel' && method === 'POST') {
    const channel = sessions.get(id)
    if (!channel?.busy) return json(response, 200, { accepted: false })
    channel.cancelRequested = true
    client?.notify('session/cancel', { sessionId: id })
    channel.publish({ type: 'turn_cancelling' })
    json(response, 202, { accepted: true })
    return true
  }
  const permissionMatch = action.match(/^permissions\/([^/]+)$/)
  if (permissionMatch && method === 'POST') {
    await resolvePermission(request, response, id, permissionMatch[1])
    return true
  }
  json(response, 404, { error: '找不到这个 API。' })
  return true
}

export function backendMiddleware(request, response, next) {
  if (!request.url?.startsWith('/api/')) return next()
  handle(request, response).catch((error) => {
    if (response.headersSent) {
      response.end()
      return
    }
    json(response, error.status || 500, { error: error.message || '本地服务发生错误。' })
  })
}

export function shutdownBackend() {
  for (const item of permissions.values()) {
    try { item.instance.respond(item.rpcId, { outcome: { outcome: 'cancelled' } }) } catch { /* Process already stopped. */ }
  }
  permissions.clear()
  client?.stop()
  client = null
}
