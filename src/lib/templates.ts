/**
 * Bot templates. Isomorphic: the same module object executes in the browser
 * worker and in the Cloudflare runtime. Templates never touch sockets — they
 * receive normalized messages and act through the Ctx interface.
 *
 * To add a template: define it here (MVP) — later, from the registry.
 */
import type { BotModule, Ctx, Msg } from './core'
import { DEFAULT_RELAYS, type BotPermissions, type EnvVarSpec, type RuntimeType } from './types'

export interface FieldSpec {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'textarea' | 'select' | 'list' | 'checkbox'
  required?: boolean
  default?: unknown
  options?: string[]
  help?: string
  placeholder?: string
}

export interface TemplateDef {
  id: string
  name: string
  tagline: string
  description: string
  category: string
  /** lucide icon name, resolved by the UI */
  icon: string
  runtimeSupport: RuntimeType[]
  defaults: {
    triggers: string[]
    permissions: Partial<BotPermissions>
    relays: string[]
  }
  env: EnvVarSpec[]
  fields: FieldSpec[]
  commands: string[]
  module: BotModule
}

function isCommand(msg: Msg): boolean {
  return msg.text.trim().startsWith('/')
}

function args(text: string): string {
  const i = text.indexOf(' ')
  return i === -1 ? '' : text.slice(i + 1).trim()
}

// ---------------------------------------------------------------- echo
const echo: TemplateDef = {
  id: 'echo',
  name: 'Echo Bot',
  tagline: 'Replies to every message it receives.',
  description:
    'The hello-world of bots. Answers every encrypted DM and public mention with an echo. Perfect for verifying your deployment pipeline end-to-end.',
  category: 'Basics',
  icon: 'Repeat',
  runtimeSupport: ['nostr'],
  defaults: {
    triggers: ['message', 'mention'],
    permissions: { receiveMessages: true, sendMessages: true, publicMentions: true },
    relays: DEFAULT_RELAYS,
  },
  env: [],
  fields: [
    {
      key: 'prefix',
      label: 'Reply prefix',
      type: 'text',
      default: 'You said: ',
      help: 'Text prepended to every echoed message.',
    },
  ],
  commands: [],
  module: {
    onStart(ctx) {
      ctx.log('info', `echo bot online as ${ctx.npub}`)
    },
    async onMessage(ctx, msg) {
      if (msg.text.length === 0) return
      const prefix = String(ctx.config.prefix ?? 'You said: ')
      await ctx.reply(msg, `${prefix}${msg.text}`.slice(0, 4000))
    },
  },
}

// ---------------------------------------------------------------- command
const command: TemplateDef = {
  id: 'command',
  name: 'Command Bot',
  tagline: 'A slash-command router: /ping, /echo, /help.',
  description: 'Responds to slash commands over encrypted DMs and public mentions. The starting point for your own command-driven bot.',
  category: 'Basics',
  icon: 'Terminal',
  runtimeSupport: ['nostr'],
  defaults: {
    triggers: ['message', 'mention'],
    permissions: { receiveMessages: true, sendMessages: true, publicMentions: true },
    relays: DEFAULT_RELAYS,
  },
  env: [],
  fields: [],
  commands: ['/ping', '/echo', '/help'],
  module: {
    async onMessage(ctx, msg) {
      const text = msg.text.trim()
      if (!isCommand(msg)) {
        await ctx.reply(msg, 'I speak in commands. Try /help')
        return
      }
      const cmd = text.split(/\s/, 1)[0].toLowerCase()
      switch (cmd) {
        case '/ping':
          await ctx.reply(msg, 'pong')
          break
        case '/echo':
          await ctx.reply(msg, args(text) || '(nothing to echo)')
          break
        case '/help':
          await ctx.reply(msg, 'Commands: /ping · /echo <text> · /help')
          break
        default:
          await ctx.reply(msg, `Unknown command "${cmd}". Try /help`)
      }
    },
  },
}

// ---------------------------------------------------------------- ai
interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const ai: TemplateDef = {
  id: 'ai',
  name: 'AI Bot',
  tagline: 'An LLM in your DMs — any OpenAI-compatible endpoint.',
  description:
    'Chats through any OpenAI-compatible API: OpenAI, OpenRouter, Ollama, LM Studio, a self-hosted vLLM — anything that speaks /chat/completions. Conversation memory lives in the node, not at the provider.',
  category: 'AI',
  icon: 'Sparkles',
  runtimeSupport: ['nostr'],
  defaults: {
    triggers: ['message', 'mention'],
    permissions: { receiveMessages: true, sendMessages: true, publicMentions: true, outboundHttp: true },
    relays: DEFAULT_RELAYS,
  },
  env: [
    { name: 'OPENAI_API_KEY', description: 'API key for the LLM endpoint', required: true, secret: true },
    { name: 'OPENAI_BASE_URL', description: 'OpenAI-compatible base URL', default: 'https://api.openai.com/v1' },
    { name: 'MODEL', description: 'Model name', default: 'gpt-4o-mini' },
  ],
  fields: [
    {
      key: 'systemPrompt',
      label: 'System prompt',
      type: 'textarea',
      default: 'You are a helpful assistant inside a Nostr bot. Keep answers concise.',
    },
    { key: 'maxHistory', label: 'History length (messages)', type: 'number', default: 12, help: 'Per-conversation memory.' },
  ],
  commands: ['/reset'],
  module: {
    async onMessage(node, msg) {
      if (msg.text.trim() === '/reset') {
        node.memory.clearHistory(msg.from)
        await node.reply(msg, 'Conversation reset.')
        return
      }
      const base = (node.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
      const key = node.env.OPENAI_API_KEY
      if (!key) {
        await node.reply(msg, 'My operator forgot to set OPENAI_API_KEY.')
        return
      }
      const history = node.memory.history<ChatMsg>(msg.from)
      const messages: ChatMsg[] = [
        { role: 'system', content: String(node.config.systemPrompt ?? 'You are a helpful assistant.') },
        ...history,
        { role: 'user', content: msg.text },
      ]
      const ctrl = new AbortController()
      const timeout = setTimeout(() => ctrl.abort(), 45_000)
      try {
        const res = await node.fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: node.env.MODEL || 'gpt-4o-mini', messages }),
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error(`LLM endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
        const answer = data.choices?.[0]?.message?.content?.trim() || '(empty response)'
        const maxHistory = Number(node.config.maxHistory ?? 12)
        node.memory.appendHistory(msg.from, { role: 'user', content: msg.text }, maxHistory)
        node.memory.appendHistory(msg.from, { role: 'assistant', content: answer }, maxHistory)
        await node.reply(msg, answer.slice(0, 4000))
      } catch (e) {
        node.log('error', `LLM call failed: ${e instanceof Error ? e.message : String(e)}`)
        await node.reply(msg, 'My brain is unreachable right now — the LLM endpoint errored. Try again in a bit.')
      } finally {
        clearTimeout(timeout)
      }
    },
  },
}

// ---------------------------------------------------------------- moderation
const moderation: TemplateDef = {
  id: 'moderation',
  name: 'Moderation Bot',
  tagline: 'Configurable word-filter moderation.',
  description:
    'Watches incoming messages for banned words and warns, ignores, or blocks the sender. Blocking is bot-local (it stops responding); community-wide kicks and bans arrive with the Vector runtime.',
  category: 'Moderation',
  icon: 'Shield',
  runtimeSupport: ['nostr'],
  defaults: {
    triggers: ['message'],
    permissions: { receiveMessages: true, sendMessages: true, moderation: true },
    relays: DEFAULT_RELAYS,
  },
  env: [],
  fields: [
    { key: 'bannedWords', label: 'Banned words', type: 'list', required: true, help: 'One per line, case-insensitive.' },
    {
      key: 'action',
      label: 'Action',
      type: 'select',
      options: ['warn', 'ignore', 'block'],
      default: 'warn',
      help: 'warn: reply with a warning · ignore: silently drop · block: never respond to that sender again',
    },
    { key: 'warnMessage', label: 'Warning message', type: 'textarea', default: 'That language is not welcome here.' },
  ],
  commands: [],
  module: {
    async onMessage(ctx, msg) {
      const blocked = ctx.state.get<string[]>('blocked') ?? []
      if (blocked.includes(msg.from)) return
      const words = (ctx.config.bannedWords as string[] | undefined) ?? []
      const text = msg.text.toLowerCase()
      const hit = words.find((w) => w && text.includes(w.toLowerCase()))
      if (!hit) return
      ctx.log('warn', `moderation hit (${hit}) from ${msg.from.slice(0, 12)}…`)
      const action = String(ctx.config.action ?? 'warn')
      if (action === 'warn') {
        await ctx.reply(msg, String(ctx.config.warnMessage ?? 'That language is not welcome here.'))
      } else if (action === 'block') {
        ctx.state.set('blocked', [...blocked, msg.from])
        ctx.log('info', `blocked ${msg.from.slice(0, 12)}…`)
      }
      // 'ignore' deliberately does nothing
    },
  },
}

// ---------------------------------------------------------------- price
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

async function fetchPrices(fetcher: Fetcher, ids: string[], currency: string): Promise<Record<string, { price: number; change: number }>> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=${encodeURIComponent(currency)}&include_24hr_change=true`
  const res = await fetcher(url)
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`)
  const data = (await res.json()) as Record<string, Record<string, number>>
  const out: Record<string, { price: number; change: number }> = {}
  for (const id of ids) {
    const row = data[id]
    if (row) out[id] = { price: row[currency], change: row[`${currency}_24h_change`] ?? 0 }
  }
  return out
}

function formatPrices(prices: Record<string, { price: number; change: number }>, currency: string): string {
  const lines = Object.entries(prices).map(([id, p]) => {
    const arrow = p.change >= 0 ? '+' : ''
    return `${id}: ${p.price.toLocaleString('en-US')} ${currency.toUpperCase()} (${arrow}${p.change.toFixed(2)}% 24h)`
  })
  return lines.length ? lines.join('\n') : 'No prices found.'
}

const price: TemplateDef = {
  id: 'price',
  name: 'Price Bot',
  tagline: 'Crypto prices on demand, or posted on a schedule.',
  description: 'Answers /price with live CoinGecko quotes. Can also broadcast a price note publicly on a schedule.',
  category: 'Finance',
  icon: 'TrendingUp',
  runtimeSupport: ['nostr'],
  defaults: {
    triggers: ['message', 'schedule'],
    permissions: { receiveMessages: true, sendMessages: true, outboundHttp: true },
    relays: DEFAULT_RELAYS,
  },
  env: [],
  fields: [
    { key: 'assets', label: 'Assets (CoinGecko ids)', type: 'list', default: ['bitcoin'], help: 'e.g. bitcoin, ethereum, monero' },
    { key: 'currency', label: 'Quote currency', type: 'text', default: 'usd' },
    { key: 'broadcast', label: 'Broadcast prices publicly on a schedule', type: 'checkbox', default: false },
    { key: 'intervalMinutes', label: 'Broadcast interval (minutes)', type: 'number', default: 60 },
  ],
  commands: ['/price'],
  module: {
    async onMessage(node, msg) {
      const text = msg.text.trim()
      if (!text.startsWith('/price')) return
      const requested = args(text)
      const assets = (node.config.assets as string[] | undefined) ?? ['bitcoin']
      const ids = requested ? [requested.toLowerCase()] : assets
      try {
        const prices = await fetchPrices(node.fetch, ids, String(node.config.currency ?? 'usd'))
        await node.reply(msg, formatPrices(prices, String(node.config.currency ?? 'usd')))
      } catch (e) {
        node.log('error', `price fetch failed: ${e instanceof Error ? e.message : String(e)}`)
        await node.reply(msg, 'Price feed is unavailable right now.')
      }
    },
    async onTick(node, now) {
      if (!node.config.broadcast) return
      if (!node.permissions.publishPublic) return
      const intervalMs = Math.max(5, Number(node.config.intervalMinutes ?? 60)) * 60_000
      const last = node.state.get<number>('lastBroadcast') ?? 0
      if (now - last < intervalMs) return
      node.state.set('lastBroadcast', now)
      try {
        const prices = await fetchPrices(node.fetch, (node.config.assets as string[]) ?? ['bitcoin'], String(node.config.currency ?? 'usd'))
        await node.post(formatPrices(prices, String(node.config.currency ?? 'usd')))
      } catch (e) {
        node.log('error', `broadcast failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  },
}

// ---------------------------------------------------------------- rss
interface FeedItem {
  id: string
  title: string
  link: string
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

/** Minimal RSS/Atom item extractor — no DOM, works in any isolate. */
export function parseFeed(xml: string, cap = 20): FeedItem[] {
  const items: FeedItem[] = []
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? []
  for (const block of blocks.slice(0, cap)) {
    const title = stripCdata(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    const linkRss = stripCdata(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? '')
    const linkAtom = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? ''
    const guid = stripCdata(block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? '')
    const link = linkRss || linkAtom
    if (!title && !link) continue
    items.push({ id: guid || link || title, title: title || link, link })
  }
  return items
}

const rss: TemplateDef = {
  id: 'rss',
  name: 'RSS / News Bot',
  tagline: 'Follows a feed and posts new items.',
  description: 'Polls any RSS or Atom feed and publishes new items as public Nostr notes. Deduplicates by guid, so restarts never double-post.',
  category: 'Notifications',
  icon: 'Rss',
  runtimeSupport: ['nostr'],
  defaults: {
    triggers: ['schedule'],
    permissions: { publishPublic: true, outboundHttp: true },
    relays: DEFAULT_RELAYS,
  },
  env: [],
  fields: [
    { key: 'feedUrl', label: 'Feed URL', type: 'text', required: true, placeholder: 'https://example.com/feed.xml' },
    { key: 'intervalMinutes', label: 'Poll interval (minutes)', type: 'number', default: 10 },
    {
      key: 'proxyPrefix',
      label: 'CORS proxy prefix (browser runtime only)',
      type: 'text',
      default: '',
      placeholder: 'https://proxy.example.com/?url=',
      help: 'Needed only if the feed does not send CORS headers and the bot runs in a browser. The Cloudflare runtime fetches directly.',
    },
  ],
  commands: [],
  module: {
    async onTick(ctx, now) {
      const intervalMs = Math.max(1, Number(ctx.config.intervalMinutes ?? 10)) * 60_000
      const last = ctx.state.get<number>('lastPoll') ?? 0
      if (now - last < intervalMs) return
      ctx.state.set('lastPoll', now)
      const feedUrl = String(ctx.config.feedUrl ?? '')
      if (!feedUrl) return
      try {
        const res = await ctx.fetch(`${String(ctx.config.proxyPrefix ?? '')}${feedUrl}`)
        if (!res.ok) throw new Error(`feed ${res.status}`)
        const items = parseFeed(await res.text())
        const seen = ctx.state.get<string[]>('seenItems') ?? []
        const fresh = items.filter((i) => i.id && !seen.includes(i.id))
        if (seen.length === 0 && fresh.length > 0) {
          // first poll: mark everything seen, announce only the newest item
          ctx.state.set('seenItems', items.map((i) => i.id).slice(0, 100))
          const newest = fresh[0]
          if (newest) await ctx.post(`${newest.title}\n\n${newest.link}`.slice(0, 4000))
          ctx.log('info', `first poll: ${items.length} items indexed, announced newest`)
          return
        }
        for (const item of fresh.slice(0, 3)) {
          await ctx.post(`${item.title}\n\n${item.link}`.slice(0, 4000))
          ctx.log('info', `posted: ${item.title.slice(0, 60)}`)
        }
        ctx.state.set('seenItems', [...seen, ...fresh.map((i) => i.id)].slice(-100))
      } catch (e) {
        ctx.log('error', `feed poll failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  },
}

// ---------------------------------------------------------------- sip-search
interface SipResult {
  title: string
  url: string
}

function extractSipResult(ev: { content: string; tags: string[][] }): SipResult | null {
  // SIP-01 kind 39697: try JSON content first, then tag conventions (d = url identity, title, u).
  try {
    const c = JSON.parse(ev.content) as Record<string, unknown>
    const url = String(c.url ?? c.u ?? c.d ?? '')
    const title = String(c.title ?? c.name ?? url)
    if (url) return { title, url }
  } catch {
    /* not JSON — fall through to tags */
  }
  const tag = (n: string) => ev.tags.find((t) => t[0] === n)?.[1]
  const url = tag('u') ?? tag('d') ?? tag('r')
  if (!url) return null
  return { title: tag('title') ?? url, url }
}

const sip: TemplateDef = {
  id: 'sip-search',
  name: 'SIP Search Bot',
  tagline: 'Decentralized web search in a DM.',
  description:
    'Answers /search <query> by querying a SIP-01 search relay (NIP-50 over kind 39697). Point it at your own SIP Booster Relay and search the decentralized index. Supports the relay’s operators: site:, lang:, after:, negations, and more.',
  category: 'SIP',
  icon: 'Search',
  runtimeSupport: ['nostr'],
  defaults: {
    triggers: ['message'],
    permissions: { receiveMessages: true, sendMessages: true },
    relays: DEFAULT_RELAYS,
  },
  env: [],
  fields: [
    {
      key: 'searchRelay',
      label: 'SIP-01 search relay',
      type: 'text',
      required: true,
      placeholder: 'wss://your-sip-relay.example.com',
      help: 'A SIP-01 relay with NIP-50 enabled — for example your SIP Booster Relay deployment.',
    },
    { key: 'resultsLimit', label: 'Results per answer', type: 'number', default: 5 },
  ],
  commands: ['/search'],
  module: {
    async onMessage(ctx, msg) {
      const text = msg.text.trim()
      if (!text.startsWith('/search')) return
      const query = args(text)
      if (!query) {
        await ctx.reply(msg, 'Usage: /search <query>\nExample: /search nostr privacy site:github.com')
        return
      }
      const relay = String(ctx.config.searchRelay ?? '').trim()
      if (!relay) {
        await ctx.reply(msg, 'SIP search relay is not configured. My operator needs to set one in the bot config.')
        return
      }
      try {
        const limit = Math.min(10, Math.max(1, Number(ctx.config.resultsLimit ?? 5)))
        const events = await ctx.search(relay, { kinds: [39697], search: query }, limit)
        const results = events.map(extractSipResult).filter((r): r is SipResult => r !== null)
        if (results.length === 0) {
          await ctx.reply(msg, `No results for "${query}".`)
          return
        }
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}`)
        await ctx.reply(msg, `Results for "${query}":\n\n${lines.join('\n\n')}\n\n— via SIP-01 decentralized index`.slice(0, 4000))
      } catch (e) {
        ctx.log('error', `SIP query failed: ${e instanceof Error ? e.message : String(e)}`)
        await ctx.reply(msg, 'The search relay is unreachable right now.')
      }
    },
  },
}

export const TEMPLATES: TemplateDef[] = [echo, command, ai, moderation, price, rss, sip]

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id)
}

export const TEMPLATE_CATEGORIES = ['Basics', 'AI', 'Search', 'SIP', 'Moderation', 'Finance', 'Notifications']
