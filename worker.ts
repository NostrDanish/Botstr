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
import { hexToBytes } from './src/lib/identity'
import type { BotLiveState, BotRecord, BotStatus, LogEntry } from './src/lib/types'

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
      const dup = await env.DB.prepare('SELECT id FROM bots WHERE id = ?').bind(body.record.id).first()
      if (dup) return err(409, 'bot id exists')
      await env.DB.prepare('INSERT INTO bots (id, record, last_status, created_at) VALUES (?, ?, ?, ?)')
        .bind(body.record.id, JSON.stringify(body.record), 'created', Date.now())
        .run()
      const stub = env.BOT_RUNNER.get(env.BOT_RUNNER.idFromName(body.record.id))
      const res = await stub.fetch('https://do/provision', {
        method: 'POST',
        body: JSON.stringify({ nsecHex: body.nsecHex, secrets: body.secrets ?? {}, botId: body.record.id }),
      })
      if (!res.ok) return err(500, `provision failed: ${await res.text()}`)
      return json({ ok: true })
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

    const m = url.pathname.match(/^\/api\/bots\/([0-9a-f]{16})(?:\/(start|stop|restart|logs|events))?$/)
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
      return json({
        ...(JSON.parse(row.record) as BotRecord),
        live: state.live ?? { status: 'stopped' },
        storage: state.storage,
      })
    }

    if (action === 'logs' || action === 'events') {
      const after = url.searchParams.get('after') ?? '0'
      const res = await stub.fetch(`https://do/${action}?after=${after}`)
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

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

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
    return Number((config?.config?.storageQuotaMB as number | undefined) ?? 25)
  }

  private async fileSizes(): Promise<Record<string, number>> {
    return (await this.state.storage.get<Record<string, number>>('fileSizes')) ?? {}
  }

  private async usedBytes(): Promise<number> {
    return (await this.state.storage.get<number>('storageUsed')) ?? 0
  }

  private async handleFiles(request: Request, path: string): Promise<Response> {
    const botId = (await this.state.storage.get<string>('botId')) ?? 'unprovisioned'
    const ct = request.headers.get('content-type') ?? 'application/octet-stream'

    if (request.method === 'PUT' && path) {
      const bytes = await request.arrayBuffer()
      const sizes = await this.fileSizes()
      const used = (await this.usedBytes()) - (sizes[path] ?? 0)
      const quota = (await this.quotaMB()) * 1024 * 1024
      if (used + bytes.byteLength > quota) return err(413, `node storage quota exceeded (${await this.quotaMB()} MB)`)
      if (!this.env.BOT_STORAGE && bytes.byteLength > 1_500_000)
        return err(413, 'bind an R2 bucket (BOT_STORAGE) for files over 1.5 MB')
      if (this.env.BOT_STORAGE) {
        await this.env.BOT_STORAGE.put(`bots/${botId}/${path}`, bytes, { httpMetadata: { contentType: ct } })
      } else {
        await this.state.storage.put(`file:${path}`, bytes)
      }
      sizes[path] = bytes.byteLength
      await this.state.storage.put('fileSizes', sizes)
      await this.state.storage.put('storageUsed', used + bytes.byteLength)
      return json({ ok: true, path, size: bytes.byteLength })
    }

    if (request.method === 'GET' && path) {
      if (this.env.BOT_STORAGE) {
        const obj = await this.env.BOT_STORAGE.get(`bots/${botId}/${path}`)
        if (!obj) return err(404, 'not found')
        return new Response(await obj.arrayBuffer(), {
          headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream' },
        })
      }
      const data = await this.state.storage.get<ArrayBuffer>(`file:${path}`)
      if (!data) return err(404, 'not found')
      return new Response(data, { headers: { 'content-type': 'application/octet-stream' } })
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
      const sizes = await this.fileSizes()
      if (!(path in sizes)) return err(404, 'not found')
      if (this.env.BOT_STORAGE) await this.env.BOT_STORAGE.delete(`bots/${botId}/${path}`)
      else await this.state.storage.delete(`file:${path}`)
      const used = (await this.usedBytes()) - sizes[path]
      delete sizes[path]
      await this.state.storage.put('fileSizes', sizes)
      await this.state.storage.put('storageUsed', Math.max(0, used))
      return json({ ok: true })
    }

    return err(405, 'method not allowed')
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    const fm = url.pathname.match(/^\/files(?:\/(.*))?$/)
    if (fm) return this.handleFiles(request, fm[1] ?? '')

    if (url.pathname === '/provision' && request.method === 'POST') {
      if (!this.env.BOTSTR_SECRET) return err(500, 'BOTSTR_SECRET not set')
      const body = (await request.json()) as { nsecHex: string; secrets: Record<string, string>; botId?: string }
      if (body.botId) await this.state.storage.put('botId', body.botId)
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
