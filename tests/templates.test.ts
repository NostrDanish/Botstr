import { describe, expect, it } from 'vitest'
import type { Ctx, Msg, StateStore } from '../src/lib/core'
import { getTemplate, parseFeed } from '../src/lib/templates'

/** A Ctx test double: records replies/posts, serves stub env, fails any network call. */
function mockCtx(config: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const store = new Map<string, unknown>()
  const sent: { to: Msg | string; text: string }[] = []
  const posted: string[] = []
  const state: StateStore = {
    get: <T,>(k: string) => store.get(k) as T | undefined,
    set: (k, v) => void store.set(k, v),
  }
  const ctx: Ctx = {
    pubkey: 'a'.repeat(64),
    npub: 'npub1test',
    env,
    config,
    permissions: {
      receiveMessages: true,
      sendMessages: true,
      publicMentions: true,
      publishPublic: true,
      reactions: false,
      files: false,
      moderation: true,
    },
    state,
    log: () => {},
    reply: async (msg, text) => {
      sent.push({ to: msg, text })
    },
    sendDM: async (to, text) => {
      sent.push({ to, text })
    },
    post: async (text) => {
      posted.push(text)
    },
    search: async () => [],
    fetch: async () => {
      throw new Error('network disabled in tests')
    },
  }
  return { ctx, sent, posted, store }
}

const dm = (text: string, from = 'b'.repeat(64)): Msg => ({
  id: Math.random().toString(36).slice(2),
  from,
  text,
  ts: Math.floor(Date.now() / 1000),
  kind: 'dm',
  relay: 'wss://test',
})

describe('echo template', () => {
  it('echoes with the configured prefix', async () => {
    const { ctx, sent } = mockCtx({ prefix: 'You said: ' })
    await getTemplate('echo')!.module.onMessage!(ctx, dm('hello'))
    expect(sent[0].text).toBe('You said: hello')
  })
})

describe('command template', () => {
  it('answers /ping with pong', async () => {
    const { ctx, sent } = mockCtx()
    await getTemplate('command')!.module.onMessage!(ctx, dm('/ping'))
    expect(sent[0].text).toBe('pong')
  })

  it('answers /echo with the argument', async () => {
    const { ctx, sent } = mockCtx()
    await getTemplate('command')!.module.onMessage!(ctx, dm('/echo hello world'))
    expect(sent[0].text).toBe('hello world')
  })

  it('guides unknown commands to /help', async () => {
    const { ctx, sent } = mockCtx()
    await getTemplate('command')!.module.onMessage!(ctx, dm('/dance'))
    expect(sent[0].text).toMatch(/\/help/)
  })
})

describe('moderation template', () => {
  const cfg = { bannedWords: ['spam'], action: 'warn', warnMessage: 'no spam' }

  it('warns on a banned word', async () => {
    const { ctx, sent } = mockCtx(cfg)
    await getTemplate('moderation')!.module.onMessage!(ctx, dm('buy my spam'))
    expect(sent[0].text).toBe('no spam')
  })

  it('ignores clean messages', async () => {
    const { ctx, sent } = mockCtx(cfg)
    await getTemplate('moderation')!.module.onMessage!(ctx, dm('lovely day'))
    expect(sent).toHaveLength(0)
  })

  it('block action silences the sender permanently', async () => {
    const { ctx, sent } = mockCtx({ ...cfg, action: 'block' })
    const mod = getTemplate('moderation')!.module
    await mod.onMessage!(ctx, dm('spam here'))
    await mod.onMessage!(ctx, dm('hello again'))
    expect(sent).toHaveLength(0)
  })
})

describe('sip-search template', () => {
  it('shows usage when the query is empty', async () => {
    const { ctx, sent } = mockCtx({ searchRelay: 'wss://sip.example.com' })
    await getTemplate('sip-search')!.module.onMessage!(ctx, dm('/search'))
    expect(sent[0].text).toMatch(/Usage: \/search/)
  })

  it('explains when no relay is configured (never fakes results)', async () => {
    const { ctx, sent } = mockCtx({ searchRelay: '' })
    await getTemplate('sip-search')!.module.onMessage!(ctx, dm('/search nostr'))
    expect(sent[0].text).toMatch(/not configured/i)
  })
})

describe('rss feed parser', () => {
  it('extracts RSS items', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title><![CDATA[First Post]]></title><link>https://x.example/1</link><guid>g1</guid></item>
      <item><title>Second</title><link>https://x.example/2</link><guid>g2</guid></item>
    </channel></rss>`
    const items = parseFeed(xml)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ id: 'g1', title: 'First Post', link: 'https://x.example/1' })
  })

  it('extracts Atom entries', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Atom Post</title><link rel="alternate" href="https://x.example/a"/></entry>
    </feed>`
    const items = parseFeed(xml)
    expect(items[0].title).toBe('Atom Post')
    expect(items[0].link).toBe('https://x.example/a')
  })
})
