/**
 * Botstr Cloudflare runtime — the always-on executor.
 *
 * Architecture (mirrors the SIP-Booster-Relay / nosflare pattern):
 *   static dashboard (assets) → API worker (this file) → one Durable Object
 *   per bot (BotRunner) → outbound WebSockets to Nostr relays.
 *
 * The DO holds the bot's (encrypted) identity, runs the SAME core + templates
 * as the browser runtime, keeps a ring buffer of logs/events in DO storage,
 * and uses an alarm watchdog to self-heal if the isolate is evicted.
 *
 * Bindings (wrangler.jsonc):
 *   BOT_RUNNER  Durable Object namespace
 *   DB          D1 database (bot registry + audit)
 *   ASSETS      static dashboard (dist/)
 *   BOTSTR_SECRET  secret env: encrypts bot keys at rest. REQUIRED.
 */
import { runBot, type BotHandle } from './src/lib/core'
import { getTemplate } from './src/lib/templates'
import { bytesToHex, hexToBytes } from './src/lib/identity'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { RelayGateway } from './src/lib/gateway'
import type { BotLiveState, BotRecord, BotStatus, GatewayMode, LogEntry } from './src/lib/types'
import type { Event as NostrEvent } from 'nostr-tools'

// ---------------------------------------------------------------------------
// minimal ambient Cloudflare types (keeps this file dependency-free)

interface D1Prepared {
  bind(...values: unknown[]): D1Prepared
  run(): Promise<unknown>
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
}
interface D1 {
  prepare(query: string): D1Prepared
}
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  deleteAll(): Promise<void>
  setAlarm(scheduledTime: number): Promise<void>
}
interface DurableObjectState {
  storage: DurableObjectStorage
  acceptWebSocket(ws: WebSocket): void
}
declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket }
}
interface DurableObjectStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
}
interface DurableObjectNs {
  idFromName(name: string): { toString(): string }
  get(id: unknown): DurableObjectStub
}
interface AssetsBinding {
  fetch(request: Request): Promise<Response>
}
interface R2ObjectInfo {
  key: string
  size: number
}
interface R2Bucket {
  put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>
  delete(key: string): Promise<void>
}
interface Env {
  BOT_RUNNER: DurableObjectNs
  DB: D1
  ASSETS: AssetsBinding
  /** optional object storage for per-node files (see docs/BOT-NODE.md) */
  BOT_STORAGE?: R2Bucket
  BOTSTR_SECRET?: string
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const err = (status: number, message: string) => json({ error: message }, status)

// ---------------------------------------------------------------------------
// secret sealing (AES-GCM key derived from BOTSTR_SECRET)

async function sealKey(secret: string, plaintext: string): Promise<string> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  const pack = new Uint8Array(12 + ct.byteLength)
  pack.set(iv, 0)
  pack.set(new Uint8Array(ct), 12)
  return btoa(String.fromCharCode(...pack))
}

async function openKey(secret: string, packed: string): Promise<string> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0))
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
  return new TextDecoder().decode(pt)
}

// ---------------------------------------------------------------------------
// API worker

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Botstr API', { status: 200 })
    }

    if (!env.BOTSTR_SECRET) {
      return err(500, 'BOTSTR_SECRET is not set — refusing to handle bot keys without encryption')
    }

    // GET /api/health
    if (url.pathname === '/api/health') return json({ ok: true, runtime: 'cloudflare', ts: Date.now() })

    // GET /api/bots
    if (url.pathname === '/api/bots' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT record, last_status FROM bots ORDER BY created_at DESC').all<{
        record: string
        last_status: string
      }>()
      return json(
        results.map((r) => {
          const bot = JSON.parse(r.record) as BotRecord
          return { ...bot, live: { status: r.last_status as BotStatus } }
        }),
      )
    }

    // POST /api/bots  { record, nsecHex, secrets }
    if (url.pathname === '/api/bots' && request.method === 'POST') {
      const body = (await request.json()) as { record: BotRecord; nsecHex: string; secrets: Record<string, string> }
      if (!body.record?.id || !body.nsecHex) return err(400, 'record and nsecHex required')
      if (!getTemplate(body.record.template)) return err(400, `unknown template "${body.record.template}"`)
      if (!body.record.relays?.every((r) => r.startsWith('wss://'))) return err(400, 'relays must be wss://')
      // platform constraint: 6 simultaneous outgoing connections per invocation
      if (body.record.relays.length > 6) return err(400, 'the cloudflare executor supports at most 6 relays per node')
      const dup = await env.DB.prepare('SELECT id FROM bots WHERE id = ?').bind(body.record.id).first()
      if (dup) return err(409, 'bot id exists')
      await env.DB.prepare('INSERT INTO bots (id, record, last_status, created_at) VALUES (?, ?, ?, ?)')
        .bind(body.record.id, JSON.stringify(body.record), 'created', Date.now())
        .run()
      const stub = env.BOT_RUNNER.get(env.BOT_RUNNER.idFromName(body.record.id))
      const res = await stub.fetch('https://do/provision', {
        method: 'POST',
        body: JSON.stringify({ nsecHex: body.nsecHex, secrets: body.secrets ?? {}, botId: body.record.id, record: body.record }),
      })
      if (!res.ok) return err(500, `provision failed: ${await res.text()}`)
      return json({ ok: true })
    }

    // GET /nodes/:id — the node's public info document (discovery)
    const nodeInfo = url.pathname.match(/^\/nodes\/([0-9a-f]{16})$/)
    if (nodeInfo && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT record, last_status FROM bots WHERE id = ?').bind(nodeInfo[1]).first<{
        record: string
        last_status: string
      }>()
      if (!row) return err(404, 'node not found')
      const bot = JSON.parse(row.record) as BotRecord
      return json({
        name: bot.name,
        description: bot.description,
        pubkey: bot.pubkey,
        status: row.last_status,
        runtime: bot.runtime,
        executor: bot.executor,
        version: bot.version,
        template: bot.template,
        relay: bot.gateway !== 'private' ? `wss://${url.host}/nodes/${bot.id}/relay` : null,
        capabilities: bot.permissions,
        software: 'https://github.com/NostrDanish/Botstr',
      })
    }

    // /nodes/:id/relay — the node's inbound relay (WebSocket) or NIP-11 doc
    const nodeRelay = url.pathname.match(/^\/nodes\/([0-9a-f]{16})\/relay$/)
    if (nodeRelay) {
      const stub = env.BOT_RUNNER.get(env.BOT_RUNNER.idFromName(nodeRelay[1]))
      return stub.fetch(request) // forwarded verbatim (keeps the Upgrade header)
    }

    // /api/bots/:id/files[/*] — per-node object storage, proxied to the DO
    const fm = url.pathname.match(/^\/api\/bots\/([0-9a-f]{16})\/files(?:\/(.*))?$/)
    if (fm) {
      const [, botId, path] = fm
      const stub = env.BOT_RUNNER.get(env.BOT_RUNNER.idFromName(botId))
      const res = await stub.fetch(`https://do/files${path ? `/${path}` : ''}`, {
        method: request.method,
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/octet-stream' },
        body: request.method === 'PUT' ? await request.arrayBuffer() : undefined,
      })
      return new Response(res.body, { status: res.status, headers: res.headers })
    }

    const m = url.pathname.match(/^\/api\/bots\/([0-9a-f]{16})(?:\/(start|stop|restart|logs|events|rotate|export))?$/)
    if (!m) return err(404, 'not found')
    const [, botId, action] = m

    const row = await env.DB.prepare('SELECT record FROM bots WHERE id = ?').bind(botId).first<{ record: string }>()
    if (!row) return err(404, 'bot not found')
    const stub = env.BOT_RUNNER.get(env.BOT_RUNNER.idFromName(botId))

    if (request.method === 'DELETE') {
      await stub.fetch('https://do/destroy', { method: 'POST' })
      await env.DB.prepare('DELETE FROM bots WHERE id = ?').bind(botId).run()
      return json({ ok: true })
    }

    if (!action && request.method === 'GET') {
      const state = (await (await stub.fetch('https://do/state')).json()) as {
        live?: BotLiveState
        storage?: { usedBytes: number; quotaMB: number }
      }
      const bot = JSON.parse(row.record) as BotRecord
      const live: BotLiveState = {
        ...(state.live ?? { status: 'stopped' }),
        relayUrl: bot.gateway !== 'private' ? `wss://${url.host}/nodes/${bot.id}/relay` : undefined,
      }
      return json({ ...bot, live, storage: state.storage })
    }

    // PATCH /api/bots/:id — update non-secret config (gateway mode, relays, config…)
    if (!action && request.method === 'PATCH') {
      const patch = (await request.json()) as Partial<BotRecord>
      const current = JSON.parse(row.record) as BotRecord
      const next: BotRecord = {
        ...current,
        ...patch,
        id: current.id,
        pubkey: current.pubkey, // identity changes go through rotation, never PATCH
        updatedAt: Date.now(),
      }
      if (next.relays.length > 6) return err(400, 'the cloudflare executor supports at most 6 relays per node')
      await env.DB.prepare('UPDATE bots SET record = ? WHERE id = ?').bind(JSON.stringify(next), botId).run()
      await stub.fetch('https://do/config', { method: 'POST', body: JSON.stringify(next) })
      return json({ ok: true })
    }

    if (action === 'logs' || action === 'events') {
      const after = url.searchParams.get('after') ?? '0'
      const res = await stub.fetch(`https://do/${action}?after=${after}`)
      return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } })
    }

    // identity rotation happens INSIDE the node; the new key never crosses the wire
    if (action === 'rotate' && request.method === 'POST') {
      const res = await stub.fetch('https://do/rotate', { method: 'POST' })
      if (!res.ok) return err(500, await res.text())
      const { pubkey } = (await res.json()) as { pubkey: string }
      const current = JSON.parse(row.record) as BotRecord
      current.pubkey = pubkey
      current.updatedAt = Date.now()
      await env.DB.prepare('UPDATE bots SET record = ? WHERE id = ?').bind(JSON.stringify(current), botId).run()
      return json({ ok: true, pubkey })
    }

    // owner export of the node's sealed material (over TLS, from your own deployment)
    if (action === 'export' && request.method === 'POST') {
      const res = await stub.fetch('https://do/export', { method: 'POST' })
      return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } })
    }

    if (action === 'start' || action === 'stop' || action === 'restart') {
      const res = await stub.fetch(`https://do/${action}`, { method: 'POST', body: row.record })
      const data = await res.text()
      await env.DB.prepare('UPDATE bots SET last_status = ? WHERE id = ?')
        .bind(action === 'stop' ? 'stopped' : 'starting', botId)
        .run()
      return new Response(data, { status: res.status, headers: { 'content-type': 'application/json' } })
    }

    return err(405, 'method not allowed')
  },
}

// ---------------------------------------------------------------------------
// BotRunner — one Durable Object per bot

const LOG_CAP = 600
const EVENT_CAP = 300
const WATCHDOG_MS = 30_000

export class BotRunner {
  private handle: BotHandle | null = null
  private logBuf: LogEntry[] = []
  private eventBuf: { ts: number; type: string; summary: string }[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private gatewayInst: RelayGateway | null = null
  private mode: GatewayMode = 'private'

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  /** The node's inbound relay. Lazily built; serves stored events even while the bot is stopped. */
  private gatewayPubkey = ''
  private async gateway(): Promise<RelayGateway> {
    const config = await this.state.storage.get<BotRecord | null>('config')
    this.mode = config?.gateway ?? 'private'
    const pk = config?.pubkey ?? ''
    if (!this.gatewayInst || this.gatewayPubkey !== pk) {
      this.gatewayPubkey = pk
      this.gatewayInst = new RelayGateway({
        botPubkey: pk,
        getMode: () => this.mode,
        store: {
          load: async () => (await this.state.storage.get<NostrEvent[]>('relay:events')) ?? [],
          append: async (ev) => {
            const events = (await this.state.storage.get<NostrEvent[]>('relay:events')) ?? []
            if (events.some((e) => e.id === ev.id)) return
            events.push(ev)
            events.sort((a, b) => b.created_at - a.created_at)
            await this.state.storage.put('relay:events', events.slice(0, 2000))
          },
        },
        hooks: {
          inject: (ev) => this.handle?.inject(ev),
          log: (level, msg) => void this.pushLog(level, msg),
        },
      })
    }
    return this.gatewayInst
  }

  /** Cloudflare hibernation hooks — gateway sockets live here. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const gw = await this.gateway()
    await gw.message(ws, message)
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const gw = await this.gateway()
    gw.detach(ws)
  }

  private async pushLog(level: LogEntry['level'], msg: string) {
    this.logBuf.push({ ts: Date.now(), level, msg })
    this.scheduleFlush()
  }

  private async pushEvent(type: string, summary: string) {
    this.eventBuf.push({ ts: Date.now(), type, summary })
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void (async () => {
        if (this.logBuf.length) {
          const logs = ((await this.state.storage.get<LogEntry[]>('logs')) ?? []).concat(this.logBuf).slice(-LOG_CAP)
          this.logBuf = []
          await this.state.storage.put('logs', logs)
        }
        if (this.eventBuf.length) {
          const events = ((await this.state.storage.get<typeof this.eventBuf>('events')) ?? [])
            .concat(this.eventBuf)
            .slice(-EVENT_CAP)
          this.eventBuf = []
          await this.state.storage.put('events', events)
        }
      })()
    }, 250)
  }

  private async setLive(live: BotLiveState, botId: string) {
    await this.state.storage.put('live', live)
    await this.env.DB.prepare('UPDATE bots SET last_status = ? WHERE id = ?').bind(live.status, botId).run()
  }

  private async start(bot: BotRecord): Promise<void> {
    if (this.handle) await this.handle.stop()
    const template = getTemplate(bot.template)
    if (!template) throw new Error(`unknown template "${bot.template}"`)
    const sealedKey = await this.state.storage.get<string>('nsec')
    if (!sealedKey || !this.env.BOTSTR_SECRET) throw new Error('bot identity missing — provision first')
    const nsecHex = await openKey(this.env.BOTSTR_SECRET, sealedKey)
    const sealedSecrets = (await this.state.storage.get<Record<string, string>>('secrets')) ?? {}
    const secrets: Record<string, string> = {}
    for (const [k, v] of Object.entries(sealedSecrets)) secrets[k] = await openKey(this.env.BOTSTR_SECRET, v)
    const persistedState = (await this.state.storage.get<Record<string, unknown>>('botState')) ?? {}

    await this.setLive({ status: 'starting' }, bot.id)
    this.handle = await runBot(bot, secrets, template.module, {
      log: (level, msg) => void this.pushLog(level, msg),
      status: (status, detail) => {
        void this.setLive({ status, detail, startedAt: status === 'starting' ? Date.now() : undefined }, bot.id)
      },
      event: (type, summary) => void this.pushEvent(type, summary),
      persistState: (s) => void this.state.storage.put('botState', s),
      setTimer: (fn, ms) => setInterval(fn, ms),
      clearTimer: (t) => clearInterval(t as number),
      fileOp: this.fileOp,
      // the node's own publishes flow into its relay gateway
      onPublish: (ev) => void this.gateway().then((gw) => gw.ingestFromBot(ev)),
    }, {
      privkey: hexToBytes(nsecHex),
      persistedState,
    })
    await this.state.storage.put('config', bot)
    await this.state.storage.setAlarm(Date.now() + WATCHDOG_MS)
  }

  /** Watchdog: if the isolate was evicted while the bot should be running, revive it. */
  async alarm(): Promise<void> {
    const config = await this.state.storage.get<BotRecord>('config')
    const live = await this.state.storage.get<BotLiveState>('live')
    if (config && live && (live.status === 'running' || live.status === 'starting')) {
      if (!this.handle) {
        await this.pushLog('warn', 'watchdog: isolate was evicted — reviving bot')
        try {
          await this.start(config)
        } catch (e) {
          await this.pushLog('error', `watchdog revive failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      await this.state.storage.setAlarm(Date.now() + WATCHDOG_MS)
    }
  }

  // ---------------------------------------------------------- node storage
  // Per-node file store. R2-backed when the BOT_STORAGE bucket is bound,
  // otherwise DO storage (small files only). Quota is a LOGICAL limit —
  // the operator sets it against their plan's real numbers (docs/BOT-NODE.md).

  private async quotaMB(): Promise<number> {
    const config = await this.state.storage.get<BotRecord | null>('config')
    return Number(config?.resources?.storageMB ?? 25)
  }

  private async fileSizes(): Promise<Record<string, number>> {
    return (await this.state.storage.get<Record<string, number>>('fileSizes')) ?? {}
  }

  private async usedBytes(): Promise<number> {
    return (await this.state.storage.get<number>('storageUsed')) ?? 0
  }

  private async putFile(name: string, bytes: ArrayBuffer, ct: string): Promise<{ size: number }> {
    const botId = (await this.state.storage.get<string>('botId')) ?? 'unprovisioned'
    const sizes = await this.fileSizes()
    const used = (await this.usedBytes()) - (sizes[name] ?? 0)
    const quota = (await this.quotaMB()) * 1024 * 1024
    if (used + bytes.byteLength > quota) throw new Error(`node storage quota exceeded (${await this.quotaMB()} MB)`)
    if (!this.env.BOT_STORAGE && bytes.byteLength > 1_500_000)
      throw new Error('bind an R2 bucket (BOT_STORAGE) for files over 1.5 MB')
    if (this.env.BOT_STORAGE) {
      await this.env.BOT_STORAGE.put(`bots/${botId}/${name}`, bytes, { httpMetadata: { contentType: ct } })
    } else {
      await this.state.storage.put(`file:${name}`, bytes)
    }
    sizes[name] = bytes.byteLength
    await this.state.storage.put('fileSizes', sizes)
    await this.state.storage.put('storageUsed', used + bytes.byteLength)
    return { size: bytes.byteLength }
  }

  private async getFile(name: string): Promise<{ data: ArrayBuffer; ct: string } | null> {
    const botId = (await this.state.storage.get<string>('botId')) ?? 'unprovisioned'
    if (this.env.BOT_STORAGE) {
      const obj = await this.env.BOT_STORAGE.get(`bots/${botId}/${name}`)
      if (!obj) return null
      return { data: await obj.arrayBuffer(), ct: obj.httpMetadata?.contentType ?? 'application/octet-stream' }
    }
    const data = await this.state.storage.get<ArrayBuffer>(`file:${name}`)
    return data ? { data, ct: 'application/octet-stream' } : null
  }

  private async deleteFile(name: string): Promise<boolean> {
    const botId = (await this.state.storage.get<string>('botId')) ?? 'unprovisioned'
    const sizes = await this.fileSizes()
    if (!(name in sizes)) return false
    if (this.env.BOT_STORAGE) await this.env.BOT_STORAGE.delete(`bots/${botId}/${name}`)
    else await this.state.storage.delete(`file:${name}`)
    const used = (await this.usedBytes()) - sizes[name]
    delete sizes[name]
    await this.state.storage.put('fileSizes', sizes)
    await this.state.storage.put('storageUsed', Math.max(0, used))
    return true
  }

  /** node.files backing for the shared core (templates call this via ctx). */
  private fileOp = async (op: { op: string; name: string; data?: Uint8Array; contentType?: string }): Promise<unknown> => {
    if (op.op === 'put') {
      const buf = op.data ? (op.data.slice().buffer as ArrayBuffer) : new ArrayBuffer(0)
      return this.putFile(op.name, buf, op.contentType ?? 'application/octet-stream')
    }
    if (op.op === 'get') {
      const f = await this.getFile(op.name)
      return f ? new Uint8Array(f.data) : null
    }
    if (op.op === 'list') {
      const sizes = await this.fileSizes()
      return Object.entries(sizes).map(([name, size]) => ({ name, size }))
    }
    if (op.op === 'delete') return this.deleteFile(op.name)
    throw new Error('unknown file op')
  }

  private async handleFiles(request: Request, path: string): Promise<Response> {
    const ct = request.headers.get('content-type') ?? 'application/octet-stream'
    try {
      if (request.method === 'PUT' && path) {
        const r = await this.putFile(path, await request.arrayBuffer(), ct)
        return json({ ok: true, path, size: r.size })
      }
      if (request.method === 'GET' && path) {
        const f = await this.getFile(path)
        if (!f) return err(404, 'not found')
        return new Response(f.data, { headers: { 'content-type': f.ct } })
      }
      if (request.method === 'GET') {
        const sizes = await this.fileSizes()
        return json({
          files: Object.entries(sizes).map(([key, size]) => ({ key, size })),
          usedBytes: await this.usedBytes(),
          quotaMB: await this.quotaMB(),
        })
      }
      if (request.method === 'DELETE' && path) {
        return (await this.deleteFile(path)) ? json({ ok: true }) : err(404, 'not found')
      }
      return err(405, 'method not allowed')
    } catch (e) {
      return err(413, e instanceof Error ? e.message : String(e))
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // /relay — the node's inbound relay endpoint
    if (url.pathname === '/relay') {
      const config = await this.state.storage.get<BotRecord | null>('config')
      this.mode = config?.gateway ?? 'private'
      if (this.mode === 'private') return err(404, 'this node is private')
      if (request.headers.get('Upgrade') === 'websocket') {
        const gw = await this.gateway()
        const pair = new WebSocketPair()
        this.state.acceptWebSocket(pair[1])
        gw.attach(pair[1])
        return new Response(null, { status: 101, webSocket: pair[0] } as unknown as ResponseInit)
      }
      if ((request.headers.get('Accept') ?? '').includes('application/nostr+json')) {
        return json({
          name: config?.name ?? 'botstr node',
          description: config?.description ?? '',
          pubkey: config?.pubkey,
          supported_nips: [1, 11, 17],
          software: 'https://github.com/NostrDanish/Botstr',
          version: config?.version ?? '1.0.0',
        })
      }
      return err(400, 'websocket upgrade required')
    }

    // /rotate — generate a new identity inside the node; the old key is destroyed
    if (url.pathname === '/rotate' && request.method === 'POST') {
      if (!this.env.BOTSTR_SECRET) return err(500, 'BOTSTR_SECRET not set')
      const config = await this.state.storage.get<BotRecord | null>('config')
      if (!config) return err(400, 'node not provisioned')
      const sk = generateSecretKey()
      await this.state.storage.put('nsec', await sealKey(this.env.BOTSTR_SECRET, bytesToHex(sk)))
      config.pubkey = getPublicKey(sk)
      await this.state.storage.put('config', config)
      await this.pushLog('warn', 'identity rotated inside the node — old key destroyed')
      if (this.handle) {
        await this.handle.stop()
        this.handle = null
        await this.start(config)
      }
      return json({ ok: true, pubkey: config.pubkey })
    }

    // /export — owner export of sealed material (over TLS, from your own deployment)
    if (url.pathname === '/export' && request.method === 'POST') {
      if (!this.env.BOTSTR_SECRET) return err(500, 'BOTSTR_SECRET not set')
      const sealedKey = await this.state.storage.get<string>('nsec')
      if (!sealedKey) return err(400, 'node not provisioned')
      const sealedSecrets = (await this.state.storage.get<Record<string, string>>('secrets')) ?? {}
      const secrets: Record<string, string> = {}
      for (const [k, v] of Object.entries(sealedSecrets)) secrets[k] = await openKey(this.env.BOTSTR_SECRET, v)
      return json({
        nsecHex: await openKey(this.env.BOTSTR_SECRET, sealedKey),
        secrets,
        state: (await this.state.storage.get<Record<string, unknown>>('botState')) ?? {},
      })
    }

    // /config — non-secret config updates (gateway mode, relays, template config)
    if (url.pathname === '/config' && request.method === 'POST') {
      const next = (await request.json()) as BotRecord
      const prev = await this.state.storage.get<BotRecord | null>('config')
      await this.state.storage.put('config', next)
      this.mode = next.gateway ?? 'private'
      if (this.handle && JSON.stringify(prev) !== JSON.stringify(next)) {
        await this.pushLog('info', 'configuration updated — applies fully on next restart')
      }
      return json({ ok: true })
    }

    const fm = url.pathname.match(/^\/files(?:\/(.*))?$/)
    if (fm) return this.handleFiles(request, fm[1] ?? '')

    if (url.pathname === '/provision' && request.method === 'POST') {
      if (!this.env.BOTSTR_SECRET) return err(500, 'BOTSTR_SECRET not set')
      const body = (await request.json()) as {
        nsecHex: string
        secrets: Record<string, string>
        botId?: string
        record?: BotRecord
      }
      if (body.botId) await this.state.storage.put('botId', body.botId)
      if (body.record) {
        await this.state.storage.put('config', body.record)
        this.mode = body.record.gateway ?? 'private'
      }
      await this.state.storage.put('nsec', await sealKey(this.env.BOTSTR_SECRET, body.nsecHex))
      const sealed: Record<string, string> = {}
      for (const [k, v] of Object.entries(body.secrets ?? {})) sealed[k] = await sealKey(this.env.BOTSTR_SECRET, v)
      await this.state.storage.put('secrets', sealed)
      return json({ ok: true })
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      try {
        const bot = (await request.json()) as BotRecord
        await this.state.storage.put('botId', bot.id)
        await this.start(bot)
        return json({ ok: true })
      } catch (e) {
        return err(500, e instanceof Error ? e.message : String(e))
      }
    }

    if (url.pathname === '/stop' && request.method === 'POST') {
      const botId = (await this.state.storage.get<string>('botId')) ?? ''
      await this.handle?.stop()
      this.handle = null
      await this.state.storage.put('config', null)
      if (botId) await this.setLive({ status: 'stopped' }, botId)
      else await this.state.storage.put('live', { status: 'stopped' })
      return json({ ok: true })
    }

    if (url.pathname === '/restart' && request.method === 'POST') {
      const bot = (await request.json()) as BotRecord
      await this.handle?.stop()
      this.handle = null
      await this.start(bot)
      return json({ ok: true })
    }

    if (url.pathname === '/state') {
      const live = (await this.state.storage.get<BotLiveState>('live')) ?? { status: 'stopped' }
      return json({ live, storage: { usedBytes: await this.usedBytes(), quotaMB: await this.quotaMB() } })
    }

    if (url.pathname === '/logs' || url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0)
      const stored = (await this.state.storage.get<{ ts: number }[]>(url.pathname.slice(1))) ?? []
      const pending = url.pathname === '/logs' ? this.logBuf : this.eventBuf
      const all = stored.concat(pending as never[]).filter((e) => e.ts > after)
      return json(all)
    }

    if (url.pathname === '/destroy' && request.method === 'POST') {
      await this.handle?.stop()
      this.handle = null
      await this.state.storage.deleteAll()
      return json({ ok: true })
    }

    return err(404, 'unknown DO route')
  }
}
