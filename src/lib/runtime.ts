/**
 * Runtime adapters and the bot manager.
 *
 * Botstr is runtime-agnostic: the dashboard talks to the Manager, the Manager
 * routes to an Executor adapter, the adapter runs the shared core.
 *
 *   browser     → bots run in a Web Worker in this tab (real relays, real keys)
 *   cloudflare  → bots run as Durable Objects via the Botstr API (24/7)
 *   runner      → future self-hosted Rust runner (Vector SDK / Concord)
 */
import { nip19 } from 'nostr-tools'
import * as db from './db'
import { deleteSecret, openSecret, sealSecret } from './vault'
import { generateIdentity, importIdentity, type Identity } from './identity'
import { getTemplate } from './templates'
import { manifestFromBot, manifestSchema, toInternalPermissions, type BotManifest } from './manifest'
import {
  DEFAULT_RESOURCES,
  uid,
  type BotEventEntry,
  type BotLiveState,
  type BotRecord,
  type BotStatus,
  type Capabilities,
  type ExecutorType,
  type LogEntry,
  type RuntimeDescriptor,
  type RuntimeType,
} from './types'

// ---------------------------------------------------------------------------
// adapter interface

interface Adapter {
  executor: ExecutorType
  available(): Promise<boolean>
  start(bot: BotRecord): Promise<void>
  stop(botId: string): Promise<void>
  remove(botId: string): Promise<void>
  live(botId: string): BotLiveState | undefined
}

// ---------------------------------------------------------------------------
// browser adapter — one Web Worker per bot

class BrowserAdapter implements Adapter {
  executor: ExecutorType = 'browser'
  private workers = new Map<string, Worker>()
  private states = new Map<string, BotLiveState>()

  constructor(
    private sink: (botId: string, msg: WorkerOutMsg) => void,
    private fileHandler: (botId: string, msg: FileReqMsg) => Promise<unknown>,
  ) {}

  async available() {
    return typeof Worker !== 'undefined'
  }

  async start(bot: BotRecord) {
    await this.halt(bot.id)
    const nsecHex = await openSecret(`bot:${bot.id}`)
    if (!nsecHex) throw new Error('bot identity missing from vault')
    const secrets: Record<string, string> = {}
    for (const name of bot.secretNames) {
      const v = await openSecret(`bot:${bot.id}:env:${name}`)
      if (v !== null) secrets[name] = v
    }
    const state = await db.getState(bot.id)
    const worker = new Worker(new URL('./worker-entry.ts', import.meta.url), { type: 'module', name: `botstr-${bot.name}` })
    this.workers.set(bot.id, worker)
    this.states.set(bot.id, { status: 'starting' })
    worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
      const msg = e.data
      if (msg.kind === 'file') {
        void this.fileHandler(bot.id, msg)
          .then((result) => worker.postMessage({ kind: 'file:res', reqId: msg.reqId, ok: true, result }))
          .catch((err) =>
            worker.postMessage({
              kind: 'file:res',
              reqId: msg.reqId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        return
      }
      this.sink(bot.id, msg)
    }
    worker.onerror = (e) => {
      this.sink(bot.id, { kind: 'status', status: 'crashed', detail: e.message ?? 'worker error' })
    }
    worker.postMessage({ cmd: 'start', bot, nsecHex, secrets, state })
  }

  async stop(botId: string) {
    const w = this.workers.get(botId)
    if (!w) return
    w.postMessage({ cmd: 'stop' })
    await new Promise((r) => setTimeout(r, 1500))
    await this.halt(botId)
  }

  private async halt(botId: string) {
    const w = this.workers.get(botId)
    if (w) {
      w.terminate()
      this.workers.delete(botId)
    }
  }

  async remove(botId: string) {
    await this.halt(botId)
    this.states.delete(botId)
  }

  live(botId: string) {
    return this.states.get(botId)
  }

  setLive(botId: string, s: BotLiveState) {
    this.states.set(botId, s)
  }

  runningIds(): string[] {
    return [...this.workers.keys()]
  }
}

interface WorkerOutMsg {
  kind: 'log' | 'status' | 'event' | 'state' | 'file'
  level?: LogEntry['level']
  msg?: string
  status?: BotStatus
  detail?: string
  startedAt?: number
  eventType?: BotEventEntry['type']
  summary?: string
  state?: Record<string, unknown>
}

interface FileReqMsg {
  kind: 'file'
  reqId: string
  op: 'put' | 'get' | 'list' | 'delete'
  name: string
  data?: Uint8Array
  contentType?: string
}

// ---------------------------------------------------------------------------
// cloudflare adapter — talks to the Botstr API (worker.ts) over HTTP

/**
 * Owner token for the /api/bots* admin API (must match BOTSTR_OWNER_TOKEN on
 * the worker). Stored in this browser's localStorage; set it from the browser
 * console with `setOwnerToken('…')` (exported below) or:
 *   localStorage.setItem('botstr:ownerToken', '<token>')
 */
export function getOwnerToken(): string | null {
  try {
    return localStorage.getItem('botstr:ownerToken')
  } catch {
    return null
  }
}

export function setOwnerToken(token: string | null): void {
  try {
    if (token) localStorage.setItem('botstr:ownerToken', token)
    else localStorage.removeItem('botstr:ownerToken')
  } catch {
    /* storage unavailable */
  }
}

function ownerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getOwnerToken()
  return token ? { ...extra, authorization: `Bearer ${token}` } : extra
}

class CloudflareAdapter implements Adapter {
  executor: ExecutorType = 'cloudflare'
  private states = new Map<string, BotLiveState>()

  async available(): Promise<boolean> {
    try {
      const res = await fetch('./api/health', { signal: AbortSignal.timeout(2500) })
      if (!res.ok) return false
      const data = (await res.json()) as { runtime?: string }
      return data.runtime === 'cloudflare'
    } catch {
      return false
    }
  }

  /** Create the bot server-side: registry row + sealed secrets inside its DO. */
  async provision(bot: BotRecord, nsecHex: string, secrets: Record<string, string>) {
    const res = await fetch('./api/bots', {
      method: 'POST',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ record: bot, nsecHex, secrets }),
    })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  }

  /** Update non-secret config server-side (gateway mode, relays, template config). */
  async update(bot: BotRecord) {
    const res = await fetch(`./api/bots/${bot.id}`, {
      method: 'PATCH',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(bot),
    })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  }

  /** Rotate identity INSIDE the node — the new key never leaves it. */
  async rotate(botId: string): Promise<{ pubkey: string }> {
    const res = await fetch(`./api/bots/${botId}/rotate`, { method: 'POST', headers: ownerHeaders() })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    return (await res.json()) as { pubkey: string }
  }

  /** Owner export of the node's sealed material, over TLS, from your own deployment. */
  async exportSecrets(botId: string): Promise<{ nsecHex: string; secrets: Record<string, string>; state: Record<string, unknown> }> {
    const res = await fetch(`./api/bots/${botId}/export`, { method: 'POST', headers: ownerHeaders() })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    return (await res.json()) as { nsecHex: string; secrets: Record<string, string>; state: Record<string, unknown> }
  }

  /** Merge bots that were created on another device into the local list. */
  async fetchRemote(): Promise<BotRecord[]> {
    const res = await fetch('./api/bots', { headers: ownerHeaders() })
    if (!res.ok) return []
    return (await res.json()) as BotRecord[]
  }

  async start(bot: BotRecord) {
    await this.send(bot.id, 'start', bot)
  }

  async stop(botId: string) {
    await this.send(botId, 'stop')
  }

  async remove(botId: string) {
    await fetch(`./api/bots/${botId}`, { method: 'DELETE', headers: ownerHeaders() })
    this.states.delete(botId)
  }

  private async send(botId: string, action: string, bot?: BotRecord) {
    const res = await fetch(`./api/bots/${botId}/${action}`, {
      method: 'POST',
      headers: ownerHeaders({ 'content-type': 'application/json' }),
      body: bot ? JSON.stringify(bot) : undefined,
    })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    this.states.set(botId, { status: action === 'start' ? 'starting' : 'stopped' })
  }

  live(botId: string) {
    return this.states.get(botId)
  }

  setLive(botId: string, s: BotLiveState) {
    this.states.set(botId, s)
  }

  async pollState(botId: string): Promise<BotLiveState | undefined> {
    try {
      const res = await fetch(`./api/bots/${botId}`, { headers: ownerHeaders() })
      if (!res.ok) return undefined
      const data = (await res.json()) as { live?: BotLiveState; storage?: { usedBytes: number; quotaMB: number } }
      if (data.live) {
        const live: BotLiveState = {
          ...data.live,
          storageUsedBytes: data.storage?.usedBytes,
          storageQuotaMB: data.storage?.quotaMB,
        }
        this.states.set(botId, live)
        return live
      }
      return undefined
    } catch {
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// manager

export interface BotWithLive extends BotRecord {
  live: BotLiveState
}

type Listener = () => void
type LogListener = (entry: LogEntry) => void

class Manager {
  private browser: BrowserAdapter
  private cloudflare = new CloudflareAdapter()
  private bots: BotRecord[] = []
  private listeners = new Set<Listener>()
  private logListeners = new Map<string, Set<LogListener>>()
  private cloudAvailable = false
  private ready: Promise<void>
  private snapshot: BotWithLive[] = []

  constructor() {
    this.browser = new BrowserAdapter(
      (botId, msg) => this.onWorkerMsg(botId, msg),
      (botId, msg) => this.fileOp(botId, msg),
    )
    this.ready = this.init()
  }

  private async init() {
    this.bots = await db.listBots()
    this.cloudAvailable = await this.cloudflare.available()
    // normalize records written by older Botstr versions
    for (const bot of this.bots) {
      let dirty = false
      if (bot.permissions.outboundHttp === undefined) {
        bot.permissions.outboundHttp = true // legacy: fetch was unrestricted
        dirty = true
      }
      if (!bot.gateway) {
        bot.gateway = 'private'
        dirty = true
      }
      if (!bot.resources) {
        bot.resources = { ...DEFAULT_RESOURCES }
        dirty = true
      }
      if (dirty) void db.putBot(bot)
    }
    // merge cloud bots created on other devices
    if (this.cloudAvailable) {
      try {
        const remote = await this.cloudflare.fetchRemote()
        const known = new Set(this.bots.map((b) => b.id))
        for (const r of remote) {
          if (!known.has(r.id)) {
            this.bots.push(r)
            void db.putBot(r)
          }
        }
      } catch {
        /* remote list is best-effort */
      }
    }
    // browser-hosted bots whose tab died are resumed: the dashboard is their host.
    for (const bot of this.bots) {
      if (bot.executor !== 'browser') continue
      const live = await db.getState(`live:${bot.id}`)
      if (live.status === 'running' || live.status === 'starting') {
        this.log(bot.id, 'info', 'dashboard reopened — resuming bot')
        void this.start(bot.id)
      }
    }
    this.emit()
  }

  // ------------------------------------------------------------ registry
  async whenReady() {
    await this.ready
  }

  list(): BotWithLive[] {
    return this.bots.map((b) => ({ ...b, live: this.live(b.id) }))
  }

  get(id: string): BotWithLive | undefined {
    const b = this.bots.find((x) => x.id === id)
    return b ? { ...b, live: this.live(id) } : undefined
  }

  live(id: string): BotLiveState {
    return this.browser.live(id) ?? this.cloudflare.live(id) ?? { status: 'stopped' }
  }

  runtimes(): RuntimeDescriptor[] {
    const nostrCaps: Capabilities = {
      messaging: true,
      directMessages: true,
      publicMentions: true,
      publishing: true,
      communities: false,
      reactions: false,
      files: true,
      moderation: false,
      tor: false,
      scheduling: true,
      alwaysOn: false,
      gateway: false,
    }
    return [
      {
        runtime: 'nostr',
        executor: 'browser',
        label: 'Nostr · this browser',
        available: true,
        reason: 'Bots run in this tab. Closing the dashboard stops them.',
        capabilities: nostrCaps,
      },
      {
        runtime: 'nostr',
        executor: 'cloudflare',
        label: 'Nostr · Cloudflare (24/7)',
        available: this.cloudAvailable,
        reason: this.cloudAvailable
          ? 'Bots run as Durable Objects on your deployed Botstr worker — they stay online when you close this tab.'
          : 'Deploy Botstr to your Cloudflare account to enable always-on bot nodes. Works on the free plan (daily caps); paid for fleets. See docs/DEPLOYMENT.md.',
        capabilities: { ...nostrCaps, alwaysOn: true, gateway: true },
      },
      {
        runtime: 'vector',
        executor: 'runner',
        label: 'Vector · self-hosted runner',
        available: false,
        reason: 'Vector bots use the Rust SDK (communities, files, Tor). A runner binary connects to this dashboard — see docs/RUNTIME-ADAPTERS.md.',
        capabilities: {
          messaging: true,
          directMessages: false,
          publicMentions: false,
          publishing: false,
          communities: true,
          roles: false,
          files: false,
          moderation: false,
          tor: false,
          scheduling: false,
          alwaysOn: false,
          gateway: false,
        },
      },
    ]
  }
