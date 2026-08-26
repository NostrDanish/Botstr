/**
 * RelayGateway — the Bot Node's inbound relay.
 *
 * A deliberate NIP-01 subset: REQ / EVENT / CLOSE, EOSE, OK, NOTICE.
 * Each node optionally exposes wss://<host>/nodes/<botId>/relay in one of
 * three modes:
 *
 *   private  — endpoint closed (default; the node only dials out)
 *   gateway  — serve the node's stored events; accept only events authored by
 *              or addressed to the node (this is the bot's mailbox)
 *   public   — serve and accept everything (rate-limited; operator opt-in)
 *
 * The gateway never claims to be a full relay: no negentropy, no NIP-50 — it
 * is the node's front door. Storage is a provider-supplied ring buffer.
 */
import { verifyEvent, type Event as NostrEvent, type Filter } from 'nostr-tools'
import type { GatewayMode } from './types'

export interface GatewayStore {
  load(): Promise<NostrEvent[]>
  append(ev: NostrEvent): Promise<void>
}

interface GatewayHooks {
  /** events addressed to the bot (giftwraps) are injected into the running core */
  inject: (ev: NostrEvent) => void
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void
}

/** Local filter matcher (ids/authors prefix, kinds, #e/#p/#t, since/until). */
export function matchFilter(f: Filter, ev: NostrEvent): boolean {
  if (f.ids && !f.ids.some((id) => ev.id.startsWith(id))) return false
  if (f.authors && !f.authors.some((a) => ev.pubkey.startsWith(a))) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.since && ev.created_at < f.since) return false
  if (f.until && ev.created_at > f.until) return false
  for (const key of Object.keys(f)) {
    if (key.startsWith('#')) {
      const want = (f as Record<string, unknown>)[key] as string[]
      const tag = key.slice(1)
      if (Array.isArray(want) && !want.some((v) => ev.tags.some((t) => t[0] === tag && t[1] === v))) return false
    }
  }
  return true
}

const EVENT_RATE = 30 // per-connection EVENT publishes per minute

export class RelayGateway {
  private clients = new Map<WebSocket, Map<string, Filter[]>>()
  private publishedAt = new Map<WebSocket, number[]>()

  constructor(
    private opts: {
      botPubkey: string
      getMode: () => GatewayMode
      store: GatewayStore
      hooks: GatewayHooks
      maxStoredEvents?: number
    },
  ) {}

  attach(ws: WebSocket) {
    this.clients.set(ws, new Map())
    this.publishedAt.set(ws, [])
    this.opts.hooks.log('info', `gateway client connected (${this.clients.size} online)`)
  }

  detach(ws: WebSocket) {
    this.clients.delete(ws)
    this.publishedAt.delete(ws)
  }

  private send(ws: WebSocket, msg: unknown[]) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      this.detach(ws)
    }
  }

  private rateLimited(ws: WebSocket): boolean {
    const cutoff = Date.now() - 60_000
    const ts = (this.publishedAt.get(ws) ?? []).filter((t) => t > cutoff)
    this.publishedAt.set(ws, ts)
    if (ts.length >= EVENT_RATE) return true
    ts.push(Date.now())
    return false
  }

  async message(ws: WebSocket, data: unknown): Promise<void> {
    if (typeof data !== 'string') return
    let msg: unknown[]
    try {
      msg = JSON.parse(data)
    } catch {
      return this.send(ws, ['NOTICE', 'invalid JSON'])
    }
    if (!Array.isArray(msg)) return

    switch (msg[0]) {
      case 'REQ': {
        const [, subId, ...filters] = msg as [string, string, ...Filter[]]
        if (typeof subId !== 'string' || filters.length === 0) return this.send(ws, ['CLOSED', String(subId ?? ''), 'invalid: REQ needs filters'])
        this.clients.get(ws)?.set(subId, filters)
        const stored = await this.opts.store.load()
        const seen = new Set<string>()
        for (const f of filters) {
          const limit = Math.min(f.limit ?? 100, 500)
          let n = 0
          for (const ev of stored) {
            if (n >= limit) break
            if (seen.has(ev.id)) continue
            if (matchFilter(f, ev)) {
              seen.add(ev.id)
              n++
              this.send(ws, ['EVENT', subId, ev])
            }
          }
        }
        this.send(ws, ['EOSE', subId])
        break
      }
      case 'EVENT': {
        const ev = msg[1] as NostrEvent
        if (!ev || typeof ev.id !== 'string') return this.send(ws, ['OK', '', false, 'invalid: malformed event'])
        const mode = this.opts.getMode()
        const addressedToBot = ev.tags?.some((t) => t[0] === 'p' && t[1] === this.opts.botPubkey) ?? false
        const fromBot = ev.pubkey === this.opts.botPubkey
        if (mode === 'gateway' && !addressedToBot && !fromBot) {
          return this.send(ws, ['OK', ev.id, false, 'blocked: this node only accepts events for its bot'])
        }
        if (this.rateLimited(ws)) {
          return this.send(ws, ['OK', ev.id, false, 'rate-limited: slow down'])
        }
        if (!verifyEvent(ev)) {
          return this.send(ws, ['OK', ev.id, false, 'invalid: bad signature'])
        }
        await this.opts.store.append(ev)
        this.broadcast(ev)
        if (addressedToBot && !fromBot) this.opts.hooks.inject(ev)
        this.send(ws, ['OK', ev.id, true, ''])
        break
      }
      case 'CLOSE': {
        this.clients.get(ws)?.delete(String(msg[1]))
        break
      }
      default:
        this.send(ws, ['NOTICE', 'unsupported message type'])
    }
  }

  private broadcast(ev: NostrEvent) {
    for (const [ws, subs] of this.clients) {
      for (const [subId, filters] of subs) {
        if (filters.some((f) => matchFilter(f, ev))) this.send(ws, ['EVENT', subId, ev])
      }
    }
  }

  /** The bot's own outbound events are stored and served to subscribers. */
  async ingestFromBot(ev: NostrEvent) {
    await this.opts.store.append(ev)
    this.broadcast(ev)
  }

  clientCount(): number {
    return this.clients.size
  }
}
