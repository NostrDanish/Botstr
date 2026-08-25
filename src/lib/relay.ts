/**
 * RelayClient — one WebSocket to one Nostr relay.
 * Isomorphic: runs in the dashboard, in a Web Worker, and in a Durable Object.
 * Handles reconnect with backoff, resubscription, REQ/EVENT/OK/EOSE/NOTICE/CLOSED.
 */
import type { Event as NostrEvent, Filter } from 'nostr-tools'

export type RelayState = 'connecting' | 'open' | 'closed'

interface Sub {
  filters: Filter[]
  onEvent: (ev: NostrEvent, relay: string) => void
  onEose?: (relay: string) => void
}

interface Hooks {
  onState: (url: string, state: RelayState, detail?: string) => void
  onLog: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void
}

const MAX_BACKOFF = 60_000

export class RelayClient {
  readonly url: string
  private ws: WebSocket | null = null
  private subs = new Map<string, Sub>()
  private okWaiters = new Map<string, { resolve: (ok: boolean, msg: string) => void; timer: ReturnType<typeof setTimeout> }>()
  private attempts = 0
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  state: RelayState = 'connecting'

  constructor(
    url: string,
    private hooks: Hooks,
  ) {
    this.url = url
  }

  connect() {
    this.stopped = false
    this.open()
  }

  private open() {
    if (this.stopped) return
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.hooks.onLog('error', `${this.url}: ${String(e)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.setState('open')
      this.hooks.onLog('info', `connected ${this.url}`)
      for (const [id] of this.subs) this.sendReq(id)
    }
    ws.onmessage = (m) => this.handle(m.data)
    ws.onerror = () => {
      // onclose follows and handles reconnect
    }
    ws.onclose = (e) => {
      this.ws = null
      this.setState('closed')
      this.failOkWaiters('relay closed connection')
      if (!this.stopped) {
        this.hooks.onLog('warn', `disconnected ${this.url}${e.reason ? ` (${e.reason})` : ''}`)
        this.scheduleReconnect()
      }
    }
  }

  private setState(s: RelayState) {
    this.state = s
    this.hooks.onState(this.url, s)
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    this.attempts++
    const delay = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(this.attempts, 6)) + Math.floor(Math.random() * 500)
    this.hooks.onLog('info', `reconnecting ${this.url} in ${Math.round(delay / 1000)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private handle(data: unknown) {
    if (typeof data !== 'string') return
    let msg: unknown[]
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    switch (msg[0]) {
      case 'EVENT': {
        const [, subId, ev] = msg as [string, string, NostrEvent]
        this.subs.get(subId)?.onEvent(ev, this.url)
        break
      }
      case 'OK': {
        const [, id, ok, text] = msg as [string, string, boolean, string]
        const w = this.okWaiters.get(id)
        if (w) {
          clearTimeout(w.timer)
          this.okWaiters.delete(id)
          w.resolve(ok, text ?? '')
        }
        break
      }
      case 'EOSE': {
        const [, subId] = msg as [string, string]
        this.subs.get(subId)?.onEose?.(this.url)
        break
      }
      case 'CLOSED': {
        const [, subId, reason] = msg as [string, string, string]
        this.hooks.onLog('warn', `${this.url} closed subscription ${subId}: ${reason ?? 'no reason'}`)
        this.subs.delete(subId)
        break
      }
      case 'NOTICE': {
        this.hooks.onLog('warn', `${this.url} NOTICE: ${String(msg[1] ?? '')}`)
        break
      }
    }
  }

  private send(msg: unknown[]) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private sendReq(id: string) {
    const sub = this.subs.get(id)
    if (sub) this.send(['REQ', id, ...sub.filters])
  }

  subscribe(id: string, filters: Filter[], onEvent: Sub['onEvent'], onEose?: Sub['onEose']) {
    this.subs.set(id, { filters, onEvent, onEose })
    this.sendReq(id)
  }

  unsubscribe(id: string) {
    if (this.subs.delete(id)) this.send(['CLOSE', id])
  }

  /** Publish and wait for the relay's OK (12s timeout). */
  publish(ev: NostrEvent): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, message: 'not connected' })
        return
      }
      const timer = setTimeout(() => {
        this.okWaiters.delete(ev.id)
        resolve({ ok: false, message: 'timeout waiting for OK' })
      }, 12_000)
      this.okWaiters.set(ev.id, { resolve: (ok, msg) => resolve({ ok, message: msg }), timer })
      this.send(['EVENT', ev])
    })
  }

  private failOkWaiters(reason: string) {
    for (const [, w] of this.okWaiters) {
      clearTimeout(w.timer)
      w.resolve(false, reason)
    }
    this.okWaiters.clear()
  }

  close() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.failOkWaiters('client closed')
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
    this.ws = null
  }
}
