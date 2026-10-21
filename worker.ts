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
 *   BOTSTR_OWNER_TOKEN  secret env: bearer token for the /api/bots* admin API.
 *                       Admin routes fail closed (503) when unset.
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
  /**
   * Owner credential for the /api/bots* admin API. REQUIRED in practice:
   * when unset, every admin route fails closed with 503 (never open).
   * Set with: npx wrangler secret put BOTSTR_OWNER_TOKEN
   */
  BOTSTR_OWNER_TOKEN?: string
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
// owner auth — the /api/bots* admin API (bot enumeration, lifecycle, logs,
// files, and nsec/secret export) is restricted to the deployment owner.
//
//   Authorization: Bearer <BOTSTR_OWNER_TOKEN>
//
// FAIL CLOSED: when BOTSTR_OWNER_TOKEN is not configured, admin routes return
// 503 — an internet-reachable deployment must never silently expose bot keys.

/** Constant-time bearer check: compares SHA-256 digests so length/timing don't leak. */
async function bearerMatches(header: string | null, token: string): Promise<boolean> {
  const m = (header ?? '').match(/^Bearer\s+(\S+)\s*$/i)
  if (!m) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(m[1])),
    crypto.subtle.digest('SHA-256', enc.encode(token)),
  ])
  const xa = new Uint8Array(a)
  const xb = new Uint8Array(b)
  if (xa.length !== xb.length) return false
  let diff = 0
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ xb[i]
  return diff === 0
}

/** Returns null when the request is authorized, otherwise the error Response to send. */
async function requireOwner(request: Request, env: Env): Promise<Response | null> {
  if (!env.BOTSTR_OWNER_TOKEN) {
    return err(
      503,
      'BOTSTR_OWNER_TOKEN is not set — the bot admin API is disabled (fail closed). ' +
        'Set it with: npx wrangler secret put BOTSTR_OWNER_TOKEN',
    )
  }
  if (!(await bearerMatches(request.headers.get('Authorization'), env.BOTSTR_OWNER_TOKEN))) {
    return new Response(JSON.stringify({ error: 'owner authorization required: Authorization: Bearer <BOTSTR_OWNER_TOKEN>' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'WWW-Authenticate': 'Bearer realm="botstr-admin"' },
    })
  }
  return null
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

    // GET /api/health — public, exposes no secrets
    if (url.pathname === '/api/health') return json({ ok: true, runtime: 'cloudflare', ts: Date.now() })

    // ALL /api/bots* routes are owner-only: they enumerate bots, mutate
    // lifecycle/config, read logs/files, and can export decrypted nsec+secrets.
    // (Public read-only routes that expose no secrets: /api/health above,
    //  /nodes/:id discovery doc, /nodes/:id/relay — handled below.)
    if (url.pathname === '/api/bots' || url.pathname.startsWith('/api/bots/')) {
      const denied = await requireOwner(request, env)
      if (denied) return denied
    }

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
