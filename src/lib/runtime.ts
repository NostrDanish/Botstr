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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ record: bot, nsecHex, secrets }),
    })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  }

  /** Update non-secret config server-side (gateway mode, relays, template config). */
  async update(bot: BotRecord) {
    const res = await fetch(`./api/bots/${bot.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bot),
    })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  }

  /** Rotate identity INSIDE the node — the new key never leaves it. */
  async rotate(botId: string): Promise<{ pubkey: string }> {
    const res = await fetch(`./api/bots/${botId}/rotate`, { method: 'POST' })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    return (await res.json()) as { pubkey: string }
  }

  /** Owner export of the node's sealed material, over TLS, from your own deployment. */
  async exportSecrets(botId: string): Promise<{ nsecHex: string; secrets: Record<string, string>; state: Record<string, unknown> }> {
    const res = await fetch(`./api/bots/${botId}/export`, { method: 'POST' })
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
    return (await res.json()) as { nsecHex: string; secrets: Record<string, string>; state: Record<string, unknown> }
  }

  /** Merge bots that were created on another device into the local list. */
  async fetchRemote(): Promise<BotRecord[]> {
    const res = await fetch('./api/bots')
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
    await fetch(`./api/bots/${botId}`, { method: 'DELETE' })
    this.states.delete(botId)
  }

  private async send(botId: string, action: string, bot?: BotRecord) {
    const res = await fetch(`./api/bots/${botId}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      const res = await fetch(`./api/bots/${botId}`)
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
          directMessages: true,
          publicMentions: false,
          publishing: false,
          communities: true,
          reactions: true,
          files: true,
          moderation: true,
          tor: true,
          scheduling: true,
          alwaysOn: true,
          gateway: false,
        },
      },
      {
        runtime: 'concord',
        executor: 'runner',
        label: 'Concord · self-hosted runner',
        available: false,
        reason: 'Concord (CORD-01…08) is spec-stage; its adapter lands after Vector. See spec/ in this repo.',
        capabilities: {
          messaging: true,
          directMessages: false,
          publicMentions: false,
          publishing: false,
          communities: true,
          reactions: true,
          files: false,
          moderation: true,
          tor: false,
          scheduling: true,
          alwaysOn: true,
          gateway: false,
        },
      },
    ]
  }

  private adapterFor(executor: ExecutorType): Adapter {
    return executor === 'cloudflare' ? this.cloudflare : this.browser
  }

  // ------------------------------------------------------------ lifecycle
  async createBot(draft: Omit<BotRecord, 'id' | 'createdAt' | 'updatedAt'>, identity: Identity, secrets: Record<string, string>): Promise<BotRecord> {
    const bot: BotRecord = { ...draft, id: uid(), createdAt: Date.now(), updatedAt: Date.now() }
    if (bot.executor === 'cloudflare') {
      if (!this.cloudAvailable) throw new Error('cloud runtime is not available — deploy Botstr to Cloudflare first')
      // secrets go straight to the bot's Durable Object over TLS; they are
      // sealed there with BOTSTR_SECRET. They are not kept in this browser.
      await this.cloudflare.provision(bot, identity.secretHex, secrets)
    } else {
      await sealSecret(`bot:${bot.id}`, identity.secretHex)
      for (const [name, value] of Object.entries(secrets)) {
        await sealSecret(`bot:${bot.id}:env:${name}`, value)
      }
    }
    await db.putBot(bot)
    this.bots = [bot, ...this.bots]
    this.log(bot.id, 'info', `bot created (${getTemplate(bot.template)?.name ?? bot.template}, ${bot.runtime} on ${bot.executor})`)
    this.event(bot.id, 'lifecycle', 'bot created')
    this.emit()
    return bot
  }

  async start(id: string) {
    const bot = this.bots.find((b) => b.id === id)
    if (!bot) throw new Error('bot not found')
    const adapter = this.adapterFor(bot.executor)
    await db.putState(`live:${id}`, { status: 'starting' } as never)
    await adapter.start(bot)
    this.emit()
  }

  async stop(id: string) {
    const bot = this.bots.find((b) => b.id === id)
    if (!bot) return
    await this.adapterFor(bot.executor).stop(id)
    this.browser.setLive(id, { status: 'stopped' })
    this.cloudflare.setLive(id, { status: 'stopped' })
    await db.putState(`live:${id}`, { status: 'stopped' } as never)
    this.emit()
  }

  async restart(id: string) {
    await this.stop(id)
    await this.start(id)
  }

  async remove(id: string) {
    const bot = this.bots.find((b) => b.id === id)
    if (bot) await this.adapterFor(bot.executor).remove(id)
    await deleteSecret(`bot:${id}`)
    for (const name of bot?.secretNames ?? []) await deleteSecret(`bot:${id}:env:${name}`)
    await db.deleteBot(id)
    await db.deleteState(`live:${id}`)
    this.bots = this.bots.filter((b) => b.id !== id)
    this.logListeners.delete(id)
    this.emit()
  }

  async updateEnv(id: string, plain: Record<string, string>, secrets: Record<string, string>) {
    const bot = this.bots.find((b) => b.id === id)
    if (!bot) throw new Error('bot not found')
    bot.env = plain
    bot.secretNames = Object.keys(secrets)
    bot.updatedAt = Date.now()
    for (const [name, value] of Object.entries(secrets)) await sealSecret(`bot:${id}:env:${name}`, value)
    await db.putBot(bot)
    this.emit()
  }

  async revealNsec(id: string): Promise<string | null> {
    const hex = await openSecret(`bot:${id}`)
    if (!hex) return null
    const { nsec } = importIdentity(hex)
    return nsec
  }

  /** node.files backing for browser-executor bots (IndexedDB, quota-enforced). */
  private async fileOp(botId: string, msg: FileReqMsg): Promise<unknown> {
    const bot = this.bots.find((b) => b.id === botId)
    const quotaMB = bot?.resources?.storageMB ?? 25
    if (msg.op === 'put' && msg.data) {
      const used = await db.filesUsedBytes(botId)
      const existing = await db.getFile(botId, msg.name)
      const usedWithout = used - (existing?.size ?? 0)
      if (usedWithout + msg.data.byteLength > quotaMB * 1024 * 1024) {
        throw new Error(`node storage quota exceeded (${quotaMB} MB logical quota)`)
      }
      await db.putFile(botId, msg.name, msg.data.slice().buffer as ArrayBuffer, msg.contentType ?? 'application/octet-stream')
      return { size: msg.data.byteLength }
    }
    if (msg.op === 'get') {
      const f = await db.getFile(botId, msg.name)
      return f ? new Uint8Array(f.data) : null
    }
    if (msg.op === 'list') return db.listFiles(botId)
    if (msg.op === 'delete') {
      await db.deleteFile(botId, msg.name)
      return null
    }
    throw new Error('unknown file op')
  }

  /** Update non-secret config; cloud nodes patch their Durable Object too. */
  async updateBot(record: BotRecord): Promise<void> {
    record.updatedAt = Date.now()
    if (record.executor === 'cloudflare' && this.cloudAvailable) await this.cloudflare.update(record)
    await db.putBot(record)
    const i = this.bots.findIndex((b) => b.id === record.id)
    if (i >= 0) this.bots[i] = record
    this.log(record.id, 'info', 'configuration updated')
    this.event(record.id, 'lifecycle', 'configuration updated')
    this.emit()
  }

  /**
   * Identity rotation. For cloud bots the new key is generated INSIDE the
   * node and never crosses the wire; the old key is destroyed.
   */
  async rotateIdentity(id: string): Promise<string> {
    const bot = this.bots.find((b) => b.id === id)
    if (!bot) throw new Error('bot not found')
    const wasRunning = this.live(id).status === 'running' || this.live(id).status === 'starting'
    if (wasRunning) await this.stop(id)
    if (bot.executor === 'cloudflare' && this.cloudAvailable) {
      const { pubkey } = await this.cloudflare.rotate(id)
      bot.pubkey = pubkey
    } else {
      const identity = generateIdentity()
      await sealSecret(`bot:${id}`, identity.secretHex)
      bot.pubkey = identity.pubkey
    }
    bot.updatedAt = Date.now()
    await db.putBot(bot)
    this.log(id, 'warn', 'identity rotated — old key destroyed, new npub in effect')
    this.event(id, 'lifecycle', 'identity rotated')
    this.emit()
    if (wasRunning) await this.start(id)
    return nip19.npubEncode(bot.pubkey)
  }

  /** Portable node bundle: manifest + (optionally) identity + secrets + state. */
  async exportBot(id: string, includeIdentity: boolean): Promise<string> {
    const bot = this.bots.find((b) => b.id === id)
    if (!bot) throw new Error('bot not found')
    const template = getTemplate(bot.template)
    const manifest = manifestFromBot(bot, template?.env ?? [])
    let nsec: string | undefined
    let secrets: Record<string, string> | undefined
    let state: Record<string, unknown> = {}
    if (bot.executor === 'cloudflare' && this.cloudAvailable) {
      const bundle = await this.cloudflare.exportSecrets(id)
      if (includeIdentity) {
        nsec = importIdentity(bundle.nsecHex).nsec
        secrets = bundle.secrets
      }
      state = bundle.state ?? {}
    } else {
      if (includeIdentity) {
        const hex = await openSecret(`bot:${id}`)
        if (hex) nsec = importIdentity(hex).nsec
        secrets = {}
        for (const name of bot.secretNames) {
          const v = await openSecret(`bot:${id}:env:${name}`)
          if (v !== null) secrets[name] = v
        }
      }
      state = await db.getState(id)
    }
    return JSON.stringify(
      { apiVersion: 'botstr.dev/bundle-v1', exportedAt: new Date().toISOString(), manifest, nsec, secrets, state },
      null,
      2,
    )
  }

  /** Import a node bundle. The bot lands stopped; operator starts it. */
  async importBot(bundleText: string, executor: ExecutorType): Promise<BotRecord> {
    const bundle = JSON.parse(bundleText) as {
      apiVersion: string
      manifest: BotManifest
      nsec?: string
      secrets?: Record<string, string>
      state?: Record<string, unknown>
    }
    if (bundle.apiVersion !== 'botstr.dev/bundle-v1') throw new Error('not a Botstr bundle (apiVersion mismatch)')
    const manifest = manifestSchema.parse(bundle.manifest)
    const identity = bundle.nsec ? importIdentity(bundle.nsec) : generateIdentity()
    const draft: Omit<BotRecord, 'id' | 'createdAt' | 'updatedAt'> = {
      name: manifest.metadata.name,
      description: manifest.metadata.description,
      template: manifest.template,
      runtime: manifest.runtime.type,
      executor,
      version: manifest.metadata.version,
      pubkey: identity.pubkey,
      relays: manifest.relays,
      triggers: manifest.triggers,
      permissions: toInternalPermissions(manifest.permissions),
      gateway: manifest.gateway,
      resources: {
        storageMB: manifest.resources.storage_mb,
        maxEventsPerMinute: manifest.resources.max_events_per_minute,
        maxRelays: manifest.resources.max_relays,
      },
      env: {},
      secretNames: Object.keys(bundle.secrets ?? {}),
      config: manifest.config,
    }
    const bot = await this.createBot(draft, identity, bundle.secrets ?? {})
    if (bundle.state) await db.putState(bot.id, bundle.state)
    this.log(bot.id, 'info', `imported from bundle (${manifest.metadata.name} v${manifest.metadata.version})`)
    return bot
  }

  /** Refresh live state for cloud-hosted bots (they don't stream over postMessage). */
  async refreshLive(id: string) {
    const bot = this.bots.find((b) => b.id === id)
    if (bot?.executor === 'cloudflare') {
      await this.cloudflare.pollState(id)
      this.emit()
    }
  }

  newIdentity(): Identity {
    return generateIdentity()
  }

  importIdentity(input: string): Identity {
    return importIdentity(input)
  }

  // ------------------------------------------------------------ streams
  private onWorkerMsg(botId: string, msg: WorkerOutMsg) {
    if (msg.kind === 'log' && msg.level && msg.msg !== undefined) {
      this.log(botId, msg.level, msg.msg)
    } else if (msg.kind === 'status' && msg.status) {
      const live: BotLiveState = { status: msg.status, detail: msg.detail, startedAt: msg.startedAt }
      this.browser.setLive(botId, live)
      void db.putState(`live:${botId}`, live as never)
      this.emit()
    } else if (msg.kind === 'event' && msg.eventType && msg.summary) {
      this.event(botId, msg.eventType, msg.summary)
    } else if (msg.kind === 'state' && msg.state) {
      void db.putState(botId, msg.state)
    }
  }

  private log(botId: string, level: LogEntry['level'], msg: string) {
    const entry: LogEntry = { ts: Date.now(), level, msg }
    void db.appendLog(botId, entry)
    for (const cb of this.logListeners.get(botId) ?? []) cb(entry)
  }

  private event(botId: string, type: BotEventEntry['type'], summary: string) {
    void db.appendEvent(botId, { ts: Date.now(), type, summary })
  }

  async logs(botId: string): Promise<LogEntry[]> {
    return db.getLogs(botId)
  }

  async events(botId: string): Promise<BotEventEntry[]> {
    return db.getEvents(botId)
  }

  subscribeLogs(botId: string, cb: LogListener): () => void {
    if (!this.logListeners.has(botId)) this.logListeners.set(botId, new Set())
    this.logListeners.get(botId)!.add(cb)
    return () => this.logListeners.get(botId)?.delete(cb)
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getSnapshot(): BotWithLive[] {
    return this.snapshot
  }

  private emit() {
    this.snapshot = this.list()
    for (const cb of this.listeners) cb()
  }

  cloudEnabled(): boolean {
    return this.cloudAvailable
  }
}

export const manager = new Manager()

export function runtimeLabel(runtime: RuntimeType, executor: ExecutorType): string {
  const r = runtime.charAt(0).toUpperCase() + runtime.slice(1)
  const e = executor === 'browser' ? 'browser' : executor === 'cloudflare' ? 'Cloudflare' : 'runner'
  return `${r} · ${e}`
}
