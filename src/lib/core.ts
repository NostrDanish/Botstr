/**
 * Bot core — the isomorphic Bot Node engine shared by every provider
 * (browser Web Worker, Cloudflare Durable Object, future Rust runner).
 *
 * The core owns relay connections, subscriptions, giftwrap decoding, event
 * normalization, dedupe, rate limiting, scheduling and the Node API. A
 * template never touches a socket; it only sees `node` — the same API no
 * matter where the node runs. This is Botstr's killer abstraction:
 *
 *   node.identity · node.state · node.memory · node.files · node.events
 *   node.schedule · node.log · node.reply · node.sendDM · node.post
 *   node.search · node.fetch
 */
import { finalizeEvent, getPublicKey, nip19, type Event as NostrEvent } from 'nostr-tools'
import { RelayClient } from './relay'
import { GIFTWRAP_KIND, unwrapGift, wrapDM } from './giftwrap'
import type { BotRecord, BotStatus, LogEntry } from './types'

export interface Msg {
  id: string
  from: string // hex pubkey
  text: string
  ts: number
  kind: 'dm' | 'mention'
  relay: string
}

export interface StateStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

export interface FileEntry {
  name: string
  size: number
}

/** The Bot Node API — everything a template is allowed to touch. */
export interface Node {
  identity: { pubkey: string; npub: string }
  env: Record<string, string>
  config: Record<string, unknown>
  permissions: BotRecord['permissions']
  resources: BotRecord['resources']
  relays: string[]

  log: (level: LogEntry['level'], msg: string) => void

  /** messaging */
  reply: (msg: Msg, text: string) => Promise<void>
  sendDM: (npubOrHex: string, text: string) => Promise<void>
  post: (text: string) => Promise<void>
  /** one-shot query against a relay (e.g. NIP-50 search) */
  search: (relayUrl: string, filter: Record<string, unknown>, limit: number) => Promise<NostrEvent[]>
  /** guarded outbound HTTP — requires the network.outbound_http capability */
  fetch: (url: string, init?: RequestInit) => Promise<Response>

  /** durable key-value state */
  state: StateStore
  /** semantic memory: remembers facts and per-chat history across restarts */
  memory: {
    remember: (key: string, value: unknown) => void
    recall: <T>(key: string) => T | undefined
    forget: (key: string) => void
    history: <T>(chatId: string) => T[]
    appendHistory: <T>(chatId: string, item: T, cap?: number) => void
    clearHistory: (chatId: string) => void
  }
  /** object storage (quota-enforced by the provider) */
  files: {
    put: (name: string, data: Uint8Array | string, contentType?: string) => Promise<void>
    get: (name: string) => Promise<Uint8Array | null>
    list: () => Promise<FileEntry[]>
    delete: (name: string) => Promise<void>
  }
  /** normalized event stream */
  events: { emit: (type: string, summary: string) => void }
  /** recurring jobs — survives restarts (cloud executor re-arms via watchdog) */
  schedule: { every: (seconds: number, fn: () => Promise<void> | void) => () => void }
}

/** Back-compat alias while the ecosystem migrates. */
export type Ctx = Node

export interface BotModule {
  onStart?(node: Node): Promise<void> | void
  onMessage?(node: Node, msg: Msg): Promise<void> | void
  /** Called once per second while running (prefer node.schedule.every). */
  onTick?(node: Node, now: number): Promise<void> | void
  onStop?(node: Node): Promise<void> | void
}

export interface FileOp {
  op: 'put' | 'get' | 'list' | 'delete'
  name: string
  data?: Uint8Array
  contentType?: string
}

export interface HostHooks {
  log: (level: LogEntry['level'], msg: string) => void
  status: (status: BotStatus, detail?: string) => void
  event: (type: 'message' | 'mention' | 'connection' | 'error' | 'lifecycle' | 'schedule' | 'publish', summary: string) => void
  persistState: (state: Record<string, unknown>) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  /** object storage backing for node.files */
  fileOp: (op: FileOp) => Promise<unknown>
  /** called after every accepted publish (the gateway stores/broadcasts these) */
  onPublish?: (ev: NostrEvent) => void
}

export interface BotHandle {
  stop(): Promise<void>
  /** Feed an externally-sourced event (e.g. from the node's relay gateway). */
  inject(ev: NostrEvent): void
}

const SEEN_CAP = 2000

function hexFromNpubOrHex(s: string): string {
  if (/^[0-9a-f]{64}$/.test(s)) return s
  const dec = nip19.decode(s)
  if (dec.type === 'npub' || dec.type === 'nprofile') return dec.data as string
  throw new Error('expected npub or hex pubkey')
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,200}$/

export async function runBot(
  bot: BotRecord,
  secrets: Record<string, string>,
  mod: BotModule,
  hooks: HostHooks,
  opts: { privkey: Uint8Array; persistedState?: Record<string, unknown> },
): Promise<BotHandle> {
  const { privkey } = opts
  const pubkey = getPublicKey(privkey)
  const npub = nip19.npubEncode(pubkey)
  const log = hooks.log
  const relays: RelayClient[] = []
  const seen = new Set<string>()
  const stateMap = new Map<string, unknown>(Object.entries(opts.persistedState ?? {}))
  const jobs: { intervalMs: number; nextAt: number; fn: () => Promise<void> | void }[] = []
  let publishedTs: number[] = []
  let stopped = false
  let openedOnce = false

  hooks.status('starting')

  const markSeen = (id: string) => {
    if (seen.has(id)) return true
    seen.add(id)
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string)
    return false
  }

  /** Logical quota: sliding-window publish rate limit. */
  const checkRateLimit = () => {
    const limit = bot.resources?.maxEventsPerMinute ?? 30
    const cutoff = Date.now() - 60_000
    publishedTs = publishedTs.filter((t) => t > cutoff)
    if (publishedTs.length >= limit) {
      throw new Error(`publish rate limit exceeded (${limit}/min quota)`)
    }
    publishedTs.push(Date.now())
  }

  const publishAll = async (ev: NostrEvent): Promise<void> => {
    checkRateLimit()
    const open = relays.filter((r) => r.state === 'open')
    if (open.length === 0) throw new Error('no connected relays')
    const results = await Promise.all(open.map((r) => r.publish(ev)))
    const okCount = results.filter((r) => r.ok).length
    if (okCount === 0) throw new Error(`rejected by relays: ${results.map((r) => r.message).join('; ') || 'unknown'}`)
    log('debug', `published kind ${ev.kind} to ${okCount}/${open.length} relays`)
    hooks.onPublish?.(ev)
  }

  const state: StateStore = {
    get: <T,>(k: string) => stateMap.get(k) as T | undefined,
    set: (k, v) => void stateMap.set(k, v),
    delete: (k) => void stateMap.delete(k),
  }

  const node: Node = {
    identity: { pubkey, npub },
    env: { ...bot.env, ...secrets },
    config: bot.config,
    permissions: bot.permissions,
    resources: bot.resources,
    relays: bot.relays,
    log,

    reply: async (msg, text) => {
      if (!bot.permissions.sendMessages) throw new Error('messaging.dm capability is off')
      if (msg.kind === 'dm') {
        await publishAll(wrapDM(privkey, msg.from, text))
      } else {
        await publishAll(
          finalizeEvent(
            { kind: 1, content: text, tags: [['e', msg.id], ['p', msg.from]], created_at: Math.floor(Date.now() / 1000) },
            privkey,
          ),
        )
      }
      hooks.event('publish', `replied to ${nip19.npubEncode(msg.from).slice(0, 12)}…`)
    },
    sendDM: async (to, text) => {
      if (!bot.permissions.sendMessages) throw new Error('messaging.dm capability is off')
      await publishAll(wrapDM(privkey, hexFromNpubOrHex(to), text))
    },
    post: async (text) => {
      if (!bot.permissions.publishPublic) throw new Error('nostr.publish capability is off')
      await publishAll(finalizeEvent({ kind: 1, content: text, tags: [], created_at: Math.floor(Date.now() / 1000) }, privkey))
      hooks.event('publish', 'posted a public note')
    },
    search: (relayUrl, filter, limit) =>
      new Promise<NostrEvent[]>((resolve) => {
        const out: NostrEvent[] = []
        const subId = `q-${Math.random().toString(36).slice(2, 10)}`
        const done = () => {
          client.unsubscribe(subId)
          client.close()
          resolve(out.slice(0, limit))
        }
        const timer = setTimeout(done, 5000)
        const client = new RelayClient(relayUrl, {
          onState: () => {},
          onLog: () => {},
        })
        client.connect()
        client.subscribe(
          subId,
          [{ ...filter, limit } as never],
          (ev) => out.push(ev),
          () => {
            clearTimeout(timer)
            done()
          },
        )
      }),
    fetch: (url, init) => {
      if (!bot.permissions.outboundHttp) throw new Error('network.outbound_http capability is off')
      return fetch(url, init)
    },

    state,
    memory: {
      remember: (key, value) => void stateMap.set(`mem:${key}`, value),
      recall: <T,>(key: string) => stateMap.get(`mem:${key}`) as T | undefined,
      forget: (key) => void stateMap.delete(`mem:${key}`),
      history: <T,>(chatId: string) => (stateMap.get(`hist:${chatId}`) as T[] | undefined) ?? [],
      appendHistory: <T,>(chatId: string, item: T, cap = 50) => {
        const h = ((stateMap.get(`hist:${chatId}`) as T[] | undefined) ?? []).concat(item)
        stateMap.set(`hist:${chatId}`, h.slice(-cap))
      },
      clearHistory: (chatId: string) => void stateMap.delete(`hist:${chatId}`),
    },
    files: {
      put: async (name, data, contentType) => {
        if (!bot.permissions.files) throw new Error('storage.files capability is off')
        if (!SAFE_NAME.test(name) || name.includes('..')) throw new Error('invalid file name')
        await hooks.fileOp({ op: 'put', name, data: typeof data === 'string' ? new TextEncoder().encode(data) : data, contentType })
      },
      get: async (name) => {
        if (!SAFE_NAME.test(name) || name.includes('..')) throw new Error('invalid file name')
        return (await hooks.fileOp({ op: 'get', name })) as Uint8Array | null
      },
      list: async () => (await hooks.fileOp({ op: 'list', name: '' })) as FileEntry[],
      delete: async (name) => {
        await hooks.fileOp({ op: 'delete', name })
      },
    },
    events: {
      emit: (type, summary) => hooks.event(type as never, summary),
    },
    schedule: {
      every: (seconds, fn) => {
        const intervalMs = Math.max(10, seconds) * 1000
        const job = { intervalMs, nextAt: Date.now() + intervalMs, fn }
        jobs.push(job)
        return () => {
          const i = jobs.indexOf(job)
          if (i >= 0) jobs.splice(i, 1)
        }
      },
    },
  }

  const dispatchMessage = (msg: Msg) => {
    if (markSeen(msg.id)) return
    hooks.event(msg.kind === 'dm' ? 'message' : 'mention', `${msg.kind === 'dm' ? 'DM' : 'mention'} from ${nip19.npubEncode(msg.from).slice(0, 12)}…`)
    log('info', `received ${msg.kind} from ${msg.from.slice(0, 12)}…`)
    Promise.resolve()
      .then(() => mod.onMessage?.(node, msg))
      .catch((e) => {
        log('error', `handler error: ${e instanceof Error ? e.message : String(e)}`)
        hooks.event('error', `handler error: ${e instanceof Error ? e.message : String(e)}`)
      })
  }

  /** Shared ingress path: relay subscriptions AND the gateway both land here. */
  const handleIncoming = (ev: NostrEvent, source: string) => {
    if (ev.kind === GIFTWRAP_KIND && ev.tags.some((t) => t[0] === 'p' && t[1] === pubkey)) {
      try {
        const rumor = unwrapGift(ev, privkey)
        if (rumor.kind !== 14) return
        dispatchMessage({ id: rumor.id, from: rumor.pubkey, text: rumor.content, ts: rumor.created_at, kind: 'dm', relay: source })
      } catch (e) {
        log('debug', `dropped undecryptable giftwrap on ${source}: ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    if (
      ev.kind === 1 &&
      ev.pubkey !== pubkey &&
      bot.permissions.publicMentions &&
      ev.tags.some((t) => t[0] === 'p' && t[1] === pubkey)
    ) {
      dispatchMessage({ id: ev.id, from: ev.pubkey, text: ev.content, ts: ev.created_at, kind: 'mention', relay: source })
    }
  }

  // --- relay wiring -------------------------------------------------------
  const onRelayState = (url: string, state: 'connecting' | 'open' | 'closed') => {
    if (state === 'open') {
      hooks.event('connection', `connected ${url}`)
      if (!openedOnce) {
        openedOnce = true
        hooks.status('running')
      }
    }
    if (state === 'closed') hooks.event('connection', `disconnected ${url}`)
  }

  const maxRelays = bot.resources?.maxRelays ?? 12
  for (const url of bot.relays.slice(0, maxRelays)) {
    const client = new RelayClient(url, { onState: onRelayState, onLog: log })
    relays.push(client)
    client.connect()

    if (bot.triggers.includes('message') && bot.permissions.receiveMessages) {
      client.subscribe(
        'giftwraps',
        [{ kinds: [GIFTWRAP_KIND], '#p': [pubkey], since: Math.floor(Date.now() / 1000) - 300 }],
        (ev, relay) => handleIncoming(ev, relay),
      )
    }
    if (bot.triggers.includes('mention')) {
      client.subscribe(
        'mentions',
        [{ kinds: [1], '#p': [pubkey], since: Math.floor(Date.now() / 1000) - 60 }],
        (ev, relay) => handleIncoming(ev, relay),
      )
    }
  }

  // --- scheduling ---------------------------------------------------------
  const timer = hooks.setTimer(() => {
    if (stopped) return
    const now = Date.now()
    for (const job of jobs) {
      if (now >= job.nextAt) {
        job.nextAt = now + job.intervalMs
        Promise.resolve()
          .then(() => job.fn())
          .catch((e) => log('error', `scheduled job failed: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    Promise.resolve()
      .then(() => mod.onTick?.(node, now))
      .catch((e) => log('error', `tick error: ${e instanceof Error ? e.message : String(e)}`))
  }, 1000)

  // --- start --------------------------------------------------------------
  try {
    await mod.onStart?.(node)
    hooks.event('lifecycle', `node started as ${npub.slice(0, 16)}…`)
  } catch (e) {
    log('error', `onStart failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  const statePersist = hooks.setTimer(() => hooks.persistState(Object.fromEntries(stateMap)), 10_000)

  return {
    inject: (ev) => handleIncoming(ev, 'gateway'),
    stop: async () => {
      if (stopped) return
      stopped = true
      hooks.clearTimer(timer)
      hooks.clearTimer(statePersist)
      try {
        await mod.onStop?.(node)
      } catch {
        /* noop */
      }
      for (const r of relays) r.close()
      hooks.persistState(Object.fromEntries(stateMap))
      hooks.event('lifecycle', 'node stopped')
      hooks.status('stopped')
      log('info', 'stopped')
    },
  }
}
