/**
 * Bot core — the isomorphic execution engine shared by every executor
 * (browser Web Worker, Cloudflare Durable Object, future Rust runner via IPC).
 *
 * The core owns relay connections, subscriptions, giftwrap decoding, event
 * normalization, dedupe, scheduling and the template context (Ctx). A template
 * never touches a socket; it only sees Ctx + normalized messages.
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
}

export interface Ctx {
  pubkey: string
  npub: string
  env: Record<string, string>
  config: Record<string, unknown>
  permissions: BotRecord['permissions']
  state: StateStore
  log: (level: LogEntry['level'], msg: string) => void
  reply: (msg: Msg, text: string) => Promise<void>
  sendDM: (npubOrHex: string, text: string) => Promise<void>
  post: (text: string) => Promise<void>
  search: (relayUrl: string, filter: Record<string, unknown>, limit: number) => Promise<NostrEvent[]>
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

export interface BotModule {
  onStart?(ctx: Ctx): Promise<void> | void
  onMessage?(ctx: Ctx, msg: Msg): Promise<void> | void
  /** Called once per second while running. Templates check their own schedules. */
  onTick?(ctx: Ctx, now: number): Promise<void> | void
  onStop?(ctx: Ctx): Promise<void> | void
}

export interface HostHooks {
  log: (level: LogEntry['level'], msg: string) => void
  status: (status: BotStatus, detail?: string) => void
  event: (type: 'message' | 'mention' | 'connection' | 'error' | 'lifecycle' | 'schedule' | 'publish', summary: string) => void
  persistState: (state: Record<string, unknown>) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
}

export interface BotHandle {
  stop(): Promise<void>
}

const seenCap = 2000

function hexFromNpubOrHex(s: string): string {
  if (/^[0-9a-f]{64}$/.test(s)) return s
  const dec = nip19.decode(s)
  if (dec.type === 'npub' || dec.type === 'nprofile') return dec.data as string
  throw new Error('expected npub or hex pubkey')
}

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
  let stopped = false
  let openedOnce = false

  hooks.status('starting')

  const markSeen = (id: string) => {
    if (seen.has(id)) return true
    seen.add(id)
    if (seen.size > seenCap) seen.delete(seen.values().next().value as string)
    return false
  }

  const publishAll = async (ev: NostrEvent): Promise<void> => {
    const open = relays.filter((r) => r.state === 'open')
    if (open.length === 0) throw new Error('no connected relays')
    const results = await Promise.all(open.map((r) => r.publish(ev)))
    const okCount = results.filter((r) => r.ok).length
    if (okCount === 0) throw new Error(`rejected by relays: ${results.map((r) => r.message).join('; ') || 'unknown'}`)
    log('debug', `published kind ${ev.kind} to ${okCount}/${open.length} relays`)
  }

  const ctx: Ctx = {
    pubkey,
    npub,
    env: { ...bot.env, ...secrets },
    config: bot.config,
    permissions: bot.permissions,
    state: {
      get: <T,>(k: string) => stateMap.get(k) as T | undefined,
      set: (k: string, v: unknown) => {
        stateMap.set(k, v)
      },
    },
    log,
    reply: async (msg, text) => {
      if (!bot.permissions.sendMessages) throw new Error('send_messages permission is off')
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
      if (!bot.permissions.sendMessages) throw new Error('send_messages permission is off')
      await publishAll(wrapDM(privkey, hexFromNpubOrHex(to), text))
    },
    post: async (text) => {
      if (!bot.permissions.publishPublic) throw new Error('publish_public permission is off')
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
        }, timer = setTimeout(done, 5000)
        const client = new RelayClient(relayUrl, {
          onState: (u, s) => {
            if (s === 'open') log('debug', `query relay open: ${u}`)
          },
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
    fetch: (url, init) => fetch(url, init),
  }

  const onMessage = (msg: Msg) => {
    if (markSeen(msg.id)) return
    hooks.event(msg.kind === 'dm' ? 'message' : 'mention', `${msg.kind === 'dm' ? 'DM' : 'mention'} from ${nip19.npubEncode(msg.from).slice(0, 12)}…`)
    log('info', `received ${msg.kind} from ${msg.from.slice(0, 12)}…`)
    Promise.resolve()
      .then(() => mod.onMessage?.(ctx, msg))
      .catch((e) => {
        log('error', `handler error: ${e instanceof Error ? e.message : String(e)}`)
        hooks.event('error', `handler error: ${e instanceof Error ? e.message : String(e)}`)
      })
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

  for (const url of bot.relays) {
    const client = new RelayClient(url, {
      onState: onRelayState,
      onLog: log,
    })
    relays.push(client)
    client.connect()

    if (bot.triggers.includes('message')) {
      client.subscribe(
        'giftwraps',
        [{ kinds: [GIFTWRAP_KIND], '#p': [pubkey], since: Math.floor(Date.now() / 1000) - 300 }],
        (ev, relay) => {
          try {
            const rumor = unwrapGift(ev, privkey)
            if (rumor.kind !== DM_KIND) return
            onMessage({ id: rumor.id, from: rumor.pubkey, text: rumor.content, ts: rumor.created_at, kind: 'dm', relay })
          } catch (e) {
            log('debug', `dropped undecryptable giftwrap on ${relay}: ${e instanceof Error ? e.message : String(e)}`)
          }
        },
      )
    }
    if (bot.triggers.includes('mention') && bot.permissions.publicMentions) {
      client.subscribe(
        'mentions',
        [{ kinds: [1], '#p': [pubkey], since: Math.floor(Date.now() / 1000) - 60 }],
        (ev, relay) => {
          if (ev.pubkey === pubkey) return
          onMessage({ id: ev.id, from: ev.pubkey, text: ev.content, ts: ev.created_at, kind: 'mention', relay })
        },
      )
    }
  }

  // --- scheduling ---------------------------------------------------------
  const timer = hooks.setTimer(() => {
    if (stopped) return
    Promise.resolve()
      .then(() => mod.onTick?.(ctx, Date.now()))
      .catch((e) => log('error', `tick error: ${e instanceof Error ? e.message : String(e)}`))
  }, 1000)

  // --- start --------------------------------------------------------------
  try {
    await mod.onStart?.(ctx)
    hooks.event('lifecycle', `bot started as ${npub.slice(0, 16)}…`)
  } catch (e) {
    log('error', `onStart failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  const statePersist = hooks.setTimer(() => hooks.persistState(Object.fromEntries(stateMap)), 10_000)

  return {
    stop: async () => {
      if (stopped) return
      stopped = true
      hooks.clearTimer(timer)
      hooks.clearTimer(statePersist)
      try {
        await mod.onStop?.(ctx)
      } catch {
        /* noop */
      }
      for (const r of relays) r.close()
      hooks.persistState(Object.fromEntries(stateMap))
      hooks.event('lifecycle', 'bot stopped')
      hooks.status('stopped')
      log('info', 'stopped')
    },
  }
}
