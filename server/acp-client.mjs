import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class HermesAcpClient extends EventEmitter {
  constructor(profile = process.env.HERMES_PROFILE || 'default') {
    super()
    this.profile = profile
    this.sequence = 0
    this.pending = new Map()
    this.child = null
    this.starting = null
    this.stderrTail = ''
  }

  start() {
    if (this.starting) return this.starting
    this.starting = this.#launch().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async #launch() {
    if (this.child && this.child.exitCode === null) return this
    const binary = process.env.HERMES_BIN || 'hermes'
    this.child = spawn(binary, ['-p', this.profile, 'acp'], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const child = this.child

    child.stdout.setEncoding('utf8')
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.#readLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000)
    })
    child.on('error', (error) => {
      this.#failPending(error)
      this.emit('exit', { error })
    })
    child.on('exit', (code, signal) => {
      this.#failPending(new Error(`Hermes ACP exited (${code ?? signal ?? 'unknown'})`))
      this.emit('exit', { code, signal })
      if (this.child === child) this.child = null
    })

    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'muse-web', version: '0.1.0' },
        clientCapabilities: {},
      }, 20000)
    } catch (error) {
      child.kill()
      const hint = this.stderrTail.trim().split('\n').slice(-2).join(' ').slice(-280)
      throw new Error(hint ? `${error.message}. ${hint}` : error.message)
    }
    return this
  }

  request(method, params, timeoutMs = 120000) {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error('Hermes ACP is not connected'))
    }
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Hermes did not answer ${method} in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result })
  }

  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  #write(frame) {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) {
      throw new Error('Hermes ACP is not connected')
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  #readLine(line) {
    if (!line.trim()) return
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.emit('protocolError', new Error('Hermes ACP returned an invalid frame'))
      return
    }

    if (frame.method) {
      if (frame.id !== undefined) this.emit('serverRequest', frame)
      else this.emit('notification', frame)
      return
    }

    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.error) {
      pending.reject(new Error(frame.error.message || 'Hermes ACP request failed'))
    } else {
      pending.resolve(frame.result)
    }
  }

  #failPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  stop() {
    this.child?.kill('SIGTERM')
    this.child = null
  }
}
