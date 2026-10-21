<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Activity,
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  Clock3,
  Copy,
  Keyboard,
  LoaderCircle,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ShieldAlert,
  Sparkles,
  Square,
  Volume2,
  Wrench,
  X,
} from 'lucide-vue-next'
import { renderMarkdown } from './lib/markdown.js'
import { LocalVoiceSession } from './lib/local-voice.js'

const STORAGE_KEY = 'muse-hermes-conversations-v1'
const conversations = ref(readSavedConversations())
const activeId = ref(conversations.value[0]?.id || null)
const messageInput = ref('')
const connection = ref({ state: 'connecting', profile: 'default', error: '' })
const busy = ref(false)
const creating = ref(false)
const sending = ref(false)
const sidebarOpen = ref(false)
const sidebarCollapsed = ref(false)
const voiceVisible = ref(false)
const voiceEnabled = ref(false)
const voiceMuted = ref(false)
const voiceState = ref('listening')
const voiceTranscript = ref('')
const voiceInterim = ref('')
const voiceError = ref('')
const voiceServices = ref({ asr: { available: false }, tts: { available: false } })
const permissionRequest = ref(null)
const installPrompt = ref(null)
const copiedId = ref('')

let eventSource = null
let voiceSession = null
let persistenceTimer = null
let reconnectTimer = null
let speechBuffer = ''
let speechQueue = []
let speechWorkerRunning = false
let speechGeneration = 0
let ttsAbortController = null
let playbackSettleTimer = null
let shouldReloadSession = false

const activeConversation = computed(() => conversations.value.find((item) => item.id === activeId.value) || null)
const messages = computed(() => activeConversation.value?.messages || [])
const connected = computed(() => connection.value.state === 'connected')
const voiceLabel = computed(() => {
  if (!voiceEnabled.value) return '点击开始说话'
  if (voiceMuted.value) return '麦克风已静音'
  if (voiceState.value === 'thinking') return 'Hermes 正在思考'
  if (voiceState.value === 'speaking') return 'Muse 正在回答'
  if (voiceState.value === 'error') return '语音暂不可用'
  return '正在聆听'
})

function formatDate(value) {
  const date = new Date(value || Date.now())
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function readSavedConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.id === 'string' && Array.isArray(item.messages))
  } catch {
    return []
  }
}

function saveConversations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.value.slice(0, 40)))
  } catch {
    connection.value.error = '浏览器存储空间不足，最近对话暂未保存。'
  }
}

watch(conversations, () => {
  clearTimeout(persistenceTimer)
  persistenceTimer = setTimeout(saveConversations, 180)
}, { deep: true })

function orderedConversations() {
  return [...conversations.value].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

const recentConversations = computed(orderedConversations)

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `本地服务返回 ${response.status}`)
  return data
}

async function checkConnection() {
  connection.value = { ...connection.value, state: 'connecting', error: '' }
  try {
    const data = await api('/api/health')
    connection.value = { state: 'connected', profile: data.profile || 'default', error: '' }
  } catch (error) {
    connection.value = { ...connection.value, state: 'error', error: error.message }
  }
}

function setActive(id) {
  if (id === activeId.value) {
    sidebarOpen.value = false
    return
  }
  stopVoice({ closePanel: false })
  activeId.value = id
  busy.value = Boolean(activeConversation.value?.messages.some((message) => message.streaming))
  permissionRequest.value = null
  connectEvents(id)
  sidebarOpen.value = false
  nextTick(scrollToBottom)
}

async function createConversation() {
  if (creating.value) return null
  creating.value = true
  try {
    const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify({}) })
    const item = {
      id: result.id,
      title: '新对话',
      updatedAt: Date.now(),
      messages: [],
    }
    conversations.value.unshift(item)
    activeId.value = item.id
    shouldReloadSession = false
    connectEvents(item.id)
    sidebarOpen.value = false
    return item
  } catch (error) {
    connection.value.error = error.message
    return null
  } finally {
    creating.value = false
  }
}

async function newConversation() {
  if (!connected.value) await checkConnection()
  if (!connected.value) return
  await createConversation()
}

async function restoreConversation(id) {
  connectEvents(id)
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/load`, { method: 'POST', body: JSON.stringify({}) })
    connection.value.state = 'connected'
    connection.value.error = ''
    shouldReloadSession = false
  } catch (error) {
    connection.value.error = `无法恢复这段 Hermes 会话：${error.message}`
    shouldReloadSession = true
  }
}

function connectEvents(id) {
  eventSource?.close()
  eventSource = null
  if (!id) return
  const stream = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`)
  eventSource = stream
  stream.onmessage = (event) => {
    let data
    try { data = JSON.parse(event.data) } catch { return }
    if (data.sessionId !== activeId.value) return
    handleAgentEvent(data)
  }
  stream.onerror = () => {
    if (eventSource !== stream) return
    connection.value = { ...connection.value, state: 'error', error: '实时连接暂时断开，正在重连…' }
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      if (activeId.value === id && stream.readyState === EventSource.CLOSED) connectEvents(id)
    }, 1800)
  }
  stream.onopen = () => {
    connection.value = { ...connection.value, state: 'connected', error: '' }
  }
}

function activeMessages() {
  return activeConversation.value?.messages || []
}

function lastAssistant() {
  const list = activeMessages()
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].role === 'assistant') return list[index]
  }
  return null
}

function beginAssistantIfNeeded() {
  const current = lastAssistant()
  if (current?.streaming) return current
  const message = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    tools: [],
    streaming: true,
    createdAt: Date.now(),
  }
  activeMessages().push(message)
  return message
}

function handleAgentEvent(event) {
  const conversation = activeConversation.value
  if (!conversation) return

  if (event.type === 'turn_started') {
    busy.value = true
    const assistant = beginAssistantIfNeeded()
    assistant.streaming = true
    if (voiceEnabled.value) {
      voiceState.value = 'thinking'
      speechBuffer = ''
      speechQueue = []
      cancelVoiceOutput()
    }
  } else if (event.type === 'assistant_delta') {
    const assistant = beginAssistantIfNeeded()
    assistant.content += event.text || ''
    if (voiceEnabled.value) queueSpeech(event.text || '')
  } else if (event.type === 'tool_update') {
    const assistant = beginAssistantIfNeeded()
    const next = event.tool || {}
    const existing = assistant.tools.find((tool) => tool.id === next.id)
    if (existing) Object.assign(existing, next)
    else assistant.tools.push({ ...next })
  } else if (event.type === 'plan_update') {
    const assistant = beginAssistantIfNeeded()
    assistant.plan = event.entries || []
  } else if (event.type === 'turn_completed') {
    busy.value = false
    const assistant = lastAssistant()
    if (assistant) assistant.streaming = false
    if (voiceEnabled.value) {
      queueSpeech('', true)
      settleVoiceStateWhenIdle()
    }
    conversation.updatedAt = Date.now()
    nextTick(scrollToBottom)
  } else if (event.type === 'turn_cancelling') {
    if (voiceEnabled.value) {
      cancelVoiceOutput()
      voiceState.value = 'listening'
    }
  } else if (event.type === 'turn_error' || event.type === 'connection_lost') {
    busy.value = false
    const assistant = beginAssistantIfNeeded()
    if (!assistant.content) assistant.content = event.message || 'Hermes 连接中断。'
    assistant.streaming = false
    if (voiceEnabled.value) {
      cancelVoiceOutput()
      voiceState.value = 'error'
    }
    connection.value.error = event.message || ''
  } else if (event.type === 'history_loaded') {
    if (!conversation.messages.length && Array.isArray(event.updates)) {
      replayHistory(event.updates, conversation)
      if (event.title) conversation.title = event.title
    }
  } else if (event.type === 'permission_required') {
    permissionRequest.value = event
  } else if (event.type === 'permission_resolved') {
    if (permissionRequest.value?.requestId === event.requestId) permissionRequest.value = null
  } else if (event.type === 'session_info' && event.title) {
    conversation.title = event.title
  }

  nextTick(scrollToBottom)
}

function replayHistory(updates, conversation) {
  const rebuilt = []
  for (const update of updates) {
    const tag = update.sessionUpdate || update.session_update || ''
    if (tag === 'user_message_chunk') {
      const text = update.content?.text || ''
      if (text) rebuilt.push({ id: crypto.randomUUID(), role: 'user', content: text, tools: [], createdAt: Date.now() })
    } else if (tag === 'agent_message_chunk') {
      const text = update.content?.text || ''
      if (!text) continue
      const previous = rebuilt[rebuilt.length - 1]
      if (previous?.role === 'assistant') previous.content += text
      else rebuilt.push({ id: crypto.randomUUID(), role: 'assistant', content: text, tools: [], createdAt: Date.now() })
    }
  }
  conversation.messages = rebuilt
}

async function sendMessage(value = messageInput.value) {
  const text = String(value || '').trim()
  if (!text || sending.value) return
  if (!connected.value) await checkConnection()
  if (!connected.value) return

  let conversation = activeConversation.value
  if (!conversation) conversation = await createConversation()
  if (!conversation) return

  if (shouldReloadSession) {
    await restoreConversation(conversation.id)
    if (shouldReloadSession) return
  }

  messageInput.value = value === messageInput.value ? '' : messageInput.value
  voiceInterim.value = ''
  conversation.messages.push({ id: crypto.randomUUID(), role: 'user', content: text, tools: [], createdAt: Date.now() })
  if (conversation.title === '新对话') conversation.title = text.slice(0, 28) + (text.length > 28 ? '…' : '')
  conversation.updatedAt = Date.now()
  busy.value = true
  if (voiceEnabled.value) voiceState.value = 'thinking'
  sending.value = true
  await nextTick(() => {
    resizeComposer()
    scrollToBottom()
  })
  try {
    await api(`/api/sessions/${encodeURIComponent(conversation.id)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  } catch (error) {
    busy.value = false
    conversation.messages.push({
      id: crypto.randomUUID(), role: 'assistant', content: `暂时无法发送：${error.message}`,
      tools: [], streaming: false, createdAt: Date.now(),
    })
  } finally {
    sending.value = false
  }
}

async function stopCurrentTurn() {
  const id = activeConversation.value?.id
  if (!id || !busy.value) return
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) })
  } catch (error) {
    connection.value.error = error.message
  }
}

function onComposerKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    sendMessage()
  }
}

function resizeComposer(event) {
  const textarea = event?.target || document.querySelector('.composer textarea')
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
}

function onGlobalKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    newConversation()
  } else if (event.key === 'Escape') {
    if (voiceVisible.value) dismissVoice()
    else if (sidebarOpen.value) sidebarOpen.value = false
  }
}

const scrollContainer = ref(null)
function scrollToBottom() {
  if (!scrollContainer.value) return
  scrollContainer.value.scrollTo({ top: scrollContainer.value.scrollHeight, behavior: 'smooth' })
}

async function copyMessage(message) {
  try {
    await navigator.clipboard.writeText(message.content || '')
    copiedId.value = message.id
    setTimeout(() => { copiedId.value = '' }, 1300)
  } catch {
    connection.value.error = '无法访问剪贴板。'
  }
}

function promptFromChip(text) {
  messageInput.value = text
  nextTick(() => document.querySelector('.composer textarea')?.focus())
}

function optionLabel(option) {
  const kind = option.kind || ''
  if (kind.includes('allow_once')) return '本次允许'
  if (kind.includes('allow_always')) return '始终允许'
  if (kind.includes('reject_always')) return '始终拒绝'
  if (kind.includes('reject')) return '拒绝'
  return option.name || option.optionId || '确认'
}

async function answerPermission(option) {
  const pending = permissionRequest.value
  if (!pending) return
  try {
    await api(`/api/sessions/${encodeURIComponent(activeId.value)}/permissions/${encodeURIComponent(pending.requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ optionId: option.optionId || option.option_id }),
    })
    permissionRequest.value = null
  } catch (error) {
    connection.value.error = error.message
  }
}

async function startVoice() {
  voiceVisible.value = true
  voiceError.value = ''
  voiceTranscript.value = ''
  voiceInterim.value = ''
  voiceState.value = 'thinking'
  try {
    const services = await api('/api/voice/health')
    voiceServices.value = services
    if (!services.asr?.available || !services.tts?.available) {
      const missing = [
        !services.asr?.available ? 'FunASR 流式识别服务' : '',
        !services.tts?.available ? 'CosyVoice 流式合成服务' : '',
      ].filter(Boolean).join('、')
      throw new Error(`${missing}尚未启动。请先按 README 配置并启动本地语音服务。`)
    }

    voiceSession = await LocalVoiceSession.connect({
      onSpeechStart: () => {
        voiceTranscript.value = ''
        voiceInterim.value = ''
        if (voiceState.value === 'speaking' || voiceState.value === 'thinking') interruptForSpeech()
      },
      onEvent: (event) => {
        if (!event.isFinal) {
          const fragment = String(event.text || '')
          if (event.mode?.includes('online')) voiceInterim.value += fragment
          else voiceInterim.value = fragment
          return
        }
        const text = String(event.text || '').trim()
        voiceInterim.value = ''
        if (!text) return
        voiceTranscript.value = text
        sendMessage(text)
      },
      onError: (error) => {
        if (!voiceEnabled.value) return
        voiceError.value = error.message || '本地语音连接中断。'
        voiceState.value = 'error'
      },
    })
    voiceEnabled.value = true
    voiceMuted.value = false
    voiceState.value = 'listening'
  } catch (error) {
    voiceEnabled.value = false
    voiceState.value = 'error'
    voiceError.value = error.name === 'NotAllowedError'
      ? '麦克风权限被拒绝，请在浏览器设置中允许使用麦克风。'
      : error.message || '无法启动本地语音服务。'
    voiceSession?.stop()
    voiceSession = null
  }
}

function toggleMicrophone() {
  voiceMuted.value = !voiceMuted.value
  voiceSession?.setMuted(voiceMuted.value)
  if (voiceMuted.value) voiceState.value = 'listening'
}

function voiceReadyText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/[>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
}

function queueSpeech(delta, flush = false) {
  speechBuffer += voiceReadyText(delta)
  if (flush) {
    const remaining = speechBuffer.trim()
    speechBuffer = ''
    if (remaining) speechQueue.push(remaining)
  } else {
    const boundary = /[。！？!?；;，,\n]/g
    let splitAt = -1
    let match
    while ((match = boundary.exec(speechBuffer))) {
      if (match.index + match[0].length >= 12) {
        splitAt = match.index + match[0].length
        break
      }
    }
    if (splitAt < 0 && speechBuffer.length >= 54) {
      const soft = Math.max(speechBuffer.lastIndexOf(' ', 54), speechBuffer.lastIndexOf('，', 54), speechBuffer.lastIndexOf(',', 54))
      splitAt = soft > 16 ? soft + 1 : 54
    }
    if (splitAt > 0) {
      const next = speechBuffer.slice(0, splitAt).trim()
      speechBuffer = speechBuffer.slice(splitAt)
      if (next) speechQueue.push(next)
    }
  }
  playSpeechQueue()
}

async function playSpeechQueue() {
  if (speechWorkerRunning || !voiceEnabled.value || !voiceSession || speechQueue.length === 0) return
  speechWorkerRunning = true
  const generation = speechGeneration
  try {
    while (speechQueue.length && generation === speechGeneration && voiceEnabled.value && voiceSession) {
      const text = speechQueue.shift()
      const controller = new AbortController()
      ttsAbortController = controller
      await voiceSession.speak(text, {
        signal: controller.signal,
        onStart: () => {
          if (generation === speechGeneration && voiceEnabled.value) voiceState.value = 'speaking'
        },
      })
      if (ttsAbortController === controller) ttsAbortController = null
    }
  } catch (error) {
    if (error.name !== 'AbortError' && generation === speechGeneration && voiceEnabled.value) {
      voiceError.value = error.message || 'CosyVoice 合成失败。'
      voiceState.value = 'error'
      speechQueue = []
      speechBuffer = ''
    }
  } finally {
    ttsAbortController = null
    speechWorkerRunning = false
    if (generation === speechGeneration && voiceEnabled.value) settleVoiceStateWhenIdle()
    else if (voiceEnabled.value && speechQueue.length) playSpeechQueue()
  }
}

function settleVoiceStateWhenIdle() {
  clearTimeout(playbackSettleTimer)
  const generation = speechGeneration
  const check = () => {
    if (!voiceEnabled.value || generation !== speechGeneration) return
    if (busy.value || speechWorkerRunning || speechQueue.length || voiceSession?.hasQueuedAudio) {
      playbackSettleTimer = setTimeout(check, 120)
      return
    }
    voiceState.value = 'listening'
  }
  playbackSettleTimer = setTimeout(check, 120)
}

function cancelVoiceOutput() {
  speechGeneration += 1
  clearTimeout(playbackSettleTimer)
  speechQueue = []
  speechBuffer = ''
  ttsAbortController?.abort()
  ttsAbortController = null
  voiceSession?.stopPlayback()
}

async function interruptForSpeech() {
  cancelVoiceOutput()
  if (busy.value) await stopCurrentTurn()
  voiceState.value = 'listening'
}

function interruptButton() {
  interruptForSpeech()
}

function stopVoice({ closePanel = true } = {}) {
  clearTimeout(reconnectTimer)
  cancelVoiceOutput()
  voiceEnabled.value = false
  voiceMuted.value = false
  voiceSession?.stop()
  voiceSession = null
  voiceInterim.value = ''
  voiceTranscript.value = ''
  if (closePanel) voiceVisible.value = false
  voiceState.value = 'listening'
}

function dismissVoice() {
  stopVoice({ closePanel: true })
}

function toggleVoice() {
  if (voiceVisible.value) dismissVoice()
  else startVoice()
}

function handleInstallPrompt(event) {
  event.preventDefault()
  installPrompt.value = event
}

async function installApp() {
  if (!installPrompt.value) return
  await installPrompt.value.prompt()
  installPrompt.value = null
}

onMounted(async () => {
  window.addEventListener('beforeinstallprompt', handleInstallPrompt)
  window.addEventListener('keydown', onGlobalKeydown)
  if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  await checkConnection()
  const saved = activeConversation.value
  if (saved) await restoreConversation(saved.id)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
  window.removeEventListener('keydown', onGlobalKeydown)
  eventSource?.close()
  clearTimeout(persistenceTimer)
  stopVoice({ closePanel: true })
})
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-is-collapsed': sidebarCollapsed }">
    <div v-if="sidebarOpen" class="mobile-scrim" @click="sidebarOpen = false"></div>
    <aside class="sidebar" :class="{ 'mobile-open': sidebarOpen }">
      <div class="sidebar-top">
        <a class="brand" href="#" @click.prevent="setActive(activeId)">
          <img src="/muse.svg" alt="" class="brand-mark" />
          <span class="brand-word">muse</span>
        </a>
        <button class="icon-button sidebar-toggle" aria-label="收起侧边栏" @click="sidebarCollapsed = true">
          <PanelLeftClose :size="17" />
        </button>
      </div>

      <button class="new-chat-button" :disabled="creating || !connected" @click="newConversation">
        <Plus :size="17" :stroke-width="2.2" />
        <span>开启新对话</span>
        <span class="shortcut">⌘ K</span>
      </button>

      <div class="sidebar-label">最近对话</div>
      <div class="conversation-list">
        <button
          v-for="item in recentConversations"
          :key="item.id"
          class="conversation-link"
          :class="{ selected: item.id === activeId }"
          @click="setActive(item.id)"
        >
          <MessageCircle :size="16" />
          <span class="conversation-name">{{ item.title || '新对话' }}</span>
          <span v-if="item.id === activeId && busy" class="conversation-live"></span>
        </button>
        <div v-if="recentConversations.length === 0" class="empty-recents">
          <span class="empty-recents-icon"><Sparkles :size="16" /></span>
          <span>你的对话会显示在这里</span>
        </div>
      </div>

      <div class="sidebar-bottom">
        <div class="connection-card" :class="connection.state">
          <span class="connection-dot"></span>
          <div class="connection-copy">
            <strong>{{ connected ? 'Hermes 已连接' : connection.state === 'connecting' ? '正在连接 Hermes' : 'Hermes 离线' }}</strong>
            <span>本地 profile · {{ connection.profile }}</span>
          </div>
          <button v-if="!connected" class="connection-retry" aria-label="重试连接" @click="checkConnection">
            <Activity :size="15" />
          </button>
          <CircleCheck v-else :size="16" class="connection-check" />
        </div>
        <div class="profile-row">
          <div class="profile-avatar" aria-hidden="true"><MessageCircle :size="16" /></div>
          <div class="profile-meta"><strong>本地空间</strong><span>当前 Hermes profile</span></div>
          <button v-if="installPrompt" class="icon-button install-button" aria-label="安装 Muse" @click="installApp">
            <ArrowUp :size="16" />
          </button>
          <button class="icon-button profile-more" aria-label="空间菜单"><MoreHorizontal :size="18" /></button>
        </div>
      </div>
    </aside>

    <main class="main-panel">
      <header class="topbar">
        <div class="topbar-left">
          <button class="icon-button show-sidebar" aria-label="打开侧边栏" @click="sidebarOpen = true"><Menu :size="19" /></button>
          <button v-if="sidebarCollapsed" class="icon-button expand-sidebar" aria-label="展开侧边栏" @click="sidebarCollapsed = false"><PanelLeftOpen :size="18" /></button>
          <div class="mobile-brand"><img src="/muse.svg" alt="" /><span>muse</span></div>
          <div class="page-title">{{ activeConversation?.title || '和 Muse 聊一聊' }}</div>
          <button class="model-pill" :title="`当前会话使用本地 profile：${connection.profile}`">
            <span class="model-dot"></span>
            Hermes <ChevronDown :size="13" />
          </button>
        </div>
        <div class="topbar-right">
          <div class="topbar-status" :class="connection.state">
            <span class="status-dot"></span>
            <span>{{ connected ? '本地连接正常' : connection.state === 'connecting' ? '正在连接' : '连接异常' }}</span>
          </div>
          <button class="voice-top-button" @click="toggleVoice">
            <AudioLines :size="16" /> <span>语音聊天</span>
          </button>
        </div>
      </header>

      <div v-if="connection.error" class="connection-alert" role="status">
        <CircleHelp :size="16" /><span>{{ connection.error }}</span>
        <button class="alert-close" aria-label="关闭提示" @click="connection.error = ''"><X :size="15" /></button>
      </div>

      <section ref="scrollContainer" class="chat-scroll" :class="{ 'has-messages': messages.length }">
        <div v-if="messages.length === 0" class="welcome-wrap">
          <div class="welcome-orbit" aria-hidden="true">
            <div class="welcome-orbit-halo"></div>
            <div class="welcome-orbit-core"><AudioLines :size="32" :stroke-width="1.5" /></div>
            <span class="orbit-spark spark-one"></span><span class="orbit-spark spark-two"></span>
          </div>
          <div class="welcome-eyebrow"><Sparkles :size="14" /> 你的本地对话助手</div>
          <h1>想聊点什么？</h1>
          <p>我在本机的 Hermes 里，随时可以帮你思考、查找和处理事情。</p>
          <div class="suggestion-grid">
            <button class="suggestion-card" @click="promptFromChip('帮我梳理一下今天最重要的几件事')">
              <span class="suggestion-icon warm"><Clock3 :size="17" /></span>
              <span><strong>整理思路</strong><small>帮我梳理今天要做的事</small></span>
              <ArrowUp class="suggestion-arrow" :size="15" />
            </button>
            <button class="suggestion-card" @click="promptFromChip('帮我检查一下服务器最近的运行情况')">
              <span class="suggestion-icon lilac"><Activity :size="17" /></span>
              <span><strong>检查服务器</strong><small>看看运行状态和日志</small></span>
              <ArrowUp class="suggestion-arrow" :size="15" />
            </button>
            <button class="suggestion-card" @click="promptFromChip('解释一个复杂概念，并举一个简单的例子')">
              <span class="suggestion-icon blue"><Sparkles :size="17" /></span>
              <span><strong>探索新知</strong><small>解释一个复杂概念并举例</small></span>
              <ArrowUp class="suggestion-arrow" :size="15" />
            </button>
          </div>
          <div class="welcome-footnote"><span class="footnote-line"></span><span>文字或语音，你来决定</span><span class="footnote-line"></span></div>
        </div>

        <div v-else class="messages-column">
          <div class="date-divider"><span>{{ formatDate(activeConversation?.updatedAt) }}</span></div>
          <article v-for="message in messages" :key="message.id" class="message-row" :class="message.role">
            <div v-if="message.role === 'assistant'" class="assistant-avatar"><img src="/muse.svg" alt="Muse" /></div>
            <div class="message-body">
              <div v-if="message.role === 'assistant'" class="message-author">
                <strong>Muse</strong><span v-if="message.streaming" class="responding-label"><span></span> 正在回复</span>
              </div>
              <div v-if="message.tools?.length" class="tool-activity">
                <div class="tool-activity-heading"><Wrench :size="14" /><span>Hermes 正在处理</span><span class="tool-count">{{ message.tools.length }}</span></div>
                <div v-for="tool in message.tools" :key="tool.id" class="tool-item">
                  <span class="tool-status-mark" :class="tool.status"><LoaderCircle v-if="tool.status === 'running' || tool.status === 'pending'" :size="13" /><CircleCheck v-else-if="tool.status === 'completed'" :size="13" /><X v-else :size="13" /></span>
                  <span class="tool-title">{{ tool.title }}</span>
                  <span class="tool-status-label">{{ tool.status === 'completed' ? '完成' : tool.status === 'failed' ? '失败' : '进行中' }}</span>
                </div>
              </div>
              <div v-if="message.plan?.length" class="plan-strip">
                <div v-for="entry in message.plan" :key="entry.content || entry.title" class="plan-entry" :class="entry.status">
                  <CircleCheck v-if="entry.status === 'completed'" :size="13" /><span v-else class="plan-pip"></span>
                  <span>{{ entry.content || entry.title }}</span>
                </div>
              </div>
              <div v-if="message.content" class="message-content" v-html="renderMarkdown(message.content)"></div>
              <div v-else-if="message.streaming" class="thinking-dots" aria-label="正在思考"><span></span><span></span><span></span></div>
              <div v-if="message.role === 'assistant' && message.content && !message.streaming" class="message-actions">
                <button class="message-action" @click="copyMessage(message)"><Check v-if="copiedId === message.id" :size="14" /><Copy v-else :size="14" />{{ copiedId === message.id ? '已复制' : '复制' }}</button>
                <button v-if="voiceEnabled" class="message-action" @click="queueSpeech(message.content, true)"><Volume2 :size="14" />朗读</button>
              </div>
            </div>
            <div v-if="message.role === 'user'" class="user-avatar">我</div>
          </article>
          <div v-if="busy" class="run-live-indicator"><span></span> Hermes 正在运行 <span class="run-live-rule"></span><button @click="stopCurrentTurn"><Square :size="12" />停止</button></div>
          <div class="message-bottom-space"></div>
        </div>
      </section>

      <footer class="composer-area">
        <div class="composer" :class="{ focused: messageInput }">
          <textarea
            v-model="messageInput"
            rows="1"
            maxlength="12000"
            placeholder="给 Muse 发消息…"
            aria-label="给 Muse 发消息"
            @input="resizeComposer"
            @keydown="onComposerKeydown"
          ></textarea>
          <div class="composer-toolbar">
            <div class="composer-tools">
              <button class="composer-tool voice-trigger" :class="{ active: voiceEnabled }" aria-label="开始语音聊天" @click="toggleVoice">
                <AudioLines :size="17" /><span>语音</span>
              </button>
              <span class="composer-hint"><kbd>↵</kbd> 发送 <span class="hint-divider">·</span> <kbd>⇧ ↵</kbd> 换行</span>
            </div>
            <div class="composer-send-area">
              <span class="local-note"><span></span> 对话由本地 Hermes 处理</span>
              <button v-if="busy" class="send-button stop-button" aria-label="停止生成" @click="stopCurrentTurn"><Square :size="15" fill="currentColor" /></button>
              <button v-else class="send-button" :disabled="!messageInput.trim() || !connected" aria-label="发送消息" @click="sendMessage()"><ArrowUp :size="19" :stroke-width="2.3" /></button>
            </div>
          </div>
        </div>
        <div class="composer-disclaimer">Hermes 可能会犯错。执行工具前请确认授权内容。</div>
      </footer>
    </main>

    <Transition name="voice-overlay">
      <div v-if="voiceVisible" class="voice-overlay" role="dialog" aria-modal="true" aria-label="语音聊天">
        <div class="voice-topline">
          <div class="voice-brand"><img src="/muse.svg" alt="" /><span>muse</span><i></i><span class="voice-mode-name">语音聊天</span></div>
          <div class="voice-top-actions">
            <span class="voice-profile-pill"><span></span> {{ connection.profile }}</span>
            <button class="voice-close icon-button" aria-label="结束语音聊天" @click="dismissVoice"><X :size="19" /></button>
          </div>
        </div>
        <div class="voice-stage">
          <div class="voice-stage-caption"><span class="voice-caption-orb"><Sparkles :size="13" /></span> 和 Muse 自然地聊一聊</div>
          <div class="voice-orb-wrap" :class="`voice-${voiceState}`" @click="voiceState === 'speaking' ? interruptButton() : null">
            <div class="voice-orb-glow"></div><div class="voice-orb-ring ring-a"></div><div class="voice-orb-ring ring-b"></div>
            <div class="voice-orb-core"><div class="voice-bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
            <div class="voice-orb-spark spark-a"></div><div class="voice-orb-spark spark-b"></div>
          </div>
          <div class="voice-status-line"><span v-if="voiceEnabled && !voiceMuted" class="voice-status-dot"></span>{{ voiceLabel }}</div>
          <p class="voice-instruction">{{ voiceState === 'speaking' ? '随时开口，我会停下来听你说' : voiceState === 'thinking' ? '我听到了，正在想怎么回答' : '可以直接说话，也可以按下方按钮打断' }}</p>
          <div v-if="voiceTranscript || voiceInterim" class="voice-transcript" aria-live="polite">
            <span class="transcript-label">{{ voiceInterim ? '识别中' : '你说' }}</span>
            <span>{{ [voiceTranscript, voiceInterim].filter(Boolean).join(' ') }}</span>
          </div>
          <div class="voice-services">
            <span :class="{ online: voiceServices.asr?.available }">FunASR {{ voiceServices.asr?.available ? (voiceServices.asr.local ? '本机' : '已连接') : '未连接' }}</span>
            <span :class="{ online: voiceServices.tts?.available }">CosyVoice {{ voiceServices.tts?.available ? (voiceServices.tts.local ? '本机' : '已连接') : '未连接' }}</span>
          </div>
          <div v-if="voiceError" class="voice-error"><CircleHelp :size="15" />{{ voiceError }}</div>
          <div class="voice-controls">
            <button class="voice-control" :class="{ muted: voiceMuted }" :aria-label="voiceMuted ? '开启麦克风' : '静音麦克风'" @click="voiceEnabled && toggleMicrophone()">
              <span class="voice-control-icon"><MicOff v-if="voiceMuted" :size="20" /><Mic v-else :size="20" /></span>
              <span>{{ voiceMuted ? '取消静音' : '麦克风' }}</span>
            </button>
            <button v-if="busy || voiceState === 'speaking'" class="voice-control interrupt-control" @click="interruptButton">
              <span class="interrupt-icon"><Square :size="16" fill="currentColor" /></span><span>打断</span>
            </button>
          <button class="voice-control keyboard-control" @click="dismissVoice(); nextTick(() => document.querySelector('.composer textarea')?.focus())">
              <span class="voice-control-icon"><Keyboard :size="20" /></span><span>文字输入</span>
            </button>
          </div>
          <div class="voice-mode-footnote"><span class="voice-footnote-line"></span><span>本机 FunASR 识别 · Hermes · CosyVoice 流式朗读</span><span class="voice-footnote-line"></span></div>
        </div>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="permissionRequest" class="permission-backdrop" role="dialog" aria-modal="true" aria-label="Hermes 工具授权">
        <div class="permission-card">
          <div class="permission-icon"><ShieldAlert :size="20" /></div>
          <button class="permission-close icon-button" aria-label="关闭" @click="permissionRequest = null"><X :size="18" /></button>
          <p class="permission-eyebrow">需要你的确认</p>
          <h2>允许 Hermes 使用这个工具吗？</h2>
          <p class="permission-description">{{ permissionRequest.toolCall?.title || 'Hermes 正在请求执行一项操作。' }}</p>
          <pre v-if="permissionRequest.toolCall?.rawInput" class="permission-command">{{ JSON.stringify(permissionRequest.toolCall.rawInput, null, 2) }}</pre>
          <div class="permission-options">
            <button
              v-for="option in permissionRequest.options"
              :key="option.optionId || option.option_id"
              class="permission-option"
              :class="{ primary: (option.kind || '').includes('allow'), reject: (option.kind || '').includes('reject') }"
              @click="answerPermission(option)"
            >{{ optionLabel(option) }}<ArrowUp v-if="(option.kind || '').includes('allow')" :size="15" /></button>
          </div>
          <p class="permission-footnote">授权请求来自你本机的 Hermes profile。</p>
        </div>
      </div>
    </Transition>
  </div>
</template>
