import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools'
import { matchFilter, RelayGateway, type GatewayStore } from '../src/lib/gateway'
import type { GatewayMode } from '../src/lib/types'

class MockSocket {
  sent: string[] = []
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
  parsed(): unknown[][] {
    return this.sent.map((s) => JSON.parse(s))
  }
}

function memStore(): GatewayStore & { events: NostrEvent[] } {
  const events: NostrEvent[] = []
  return {
    events,
    load: async () => events,
    append: async (ev) => {
      if (!events.some((e) => e.id === ev.id)) events.push(ev)
    },
  }
}

function setup(mode: GatewayMode, botPubkey: string) {
  const store = memStore()
  const injected: NostrEvent[] = []
  const gw = new RelayGateway({
    botPubkey,
    getMode: () => mode,
    store,
    hooks: { inject: (ev) => injected.push(ev), log: () => {} },
  })
  return { gw, store, injected }
}

const skA = generateSecretKey()
const botSk = generateSecretKey()
const botPk = getPublicKey(botSk)

function sign(kind: number, content: string, tags: string[][], sk: Uint8Array = skA): NostrEvent {
  return finalizeEvent({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) }, sk)
}

describe('relay gateway', () => {
  it('serves stored events matching REQ filters, then EOSE', async () => {
    const { gw, store } = setup('gateway', botPk)
    await store.append(sign(1, 'hello world', [], botSk))
    await store.append(sign(1, 'unrelated kind', [], skA).kind === 1 ? sign(30023, 'nope', []) : sign(30023, 'nope', []))
    const ws = new MockSocket()
    gw.attach(ws as never)
    await gw.message(ws as never, JSON.stringify(['REQ', 'sub1', { kinds: [1] }]))
    const msgs = ws.parsed()
    const events = msgs.filter((m) => m[0] === 'EVENT')
    const eose = msgs.filter((m) => m[0] === 'EOSE')
    expect(events).toHaveLength(1)
    expect((events[0][2] as NostrEvent).content).toBe('hello world')
    expect(eose).toHaveLength(1)
  })

  it('gateway mode rejects events not addressed to the bot', async () => {
    const { gw } = setup('gateway', botPk)
    const ws = new MockSocket()
    gw.attach(ws as never)
    const ev = sign(1, 'spam', [])
    await gw.message(ws as never, JSON.stringify(['EVENT', ev]))
    const ok = ws.parsed().find((m) => m[0] === 'OK')
    expect(ok?.[2]).toBe(false)
    expect(String(ok?.[3])).toMatch(/blocked/)
  })

  it('gateway mode accepts + injects giftwraps addressed to the bot', async () => {
    const { gw, store, injected } = setup('gateway', botPk)
    const ws = new MockSocket()
    gw.attach(ws as never)
    const ev = sign(1059, 'encrypted-blob', [['p', botPk]])
    await gw.message(ws as never, JSON.stringify(['EVENT', ev]))
    const ok = ws.parsed().find((m) => m[0] === 'OK')
    expect(ok?.[2]).toBe(true)
    expect(injected).toHaveLength(1)
    expect(injected[0].id).toBe(ev.id)
    expect(store.events).toHaveLength(1)
  })

  it('rejects bad signatures', async () => {
    const { gw } = setup('public', botPk)
    const ws = new MockSocket()
    gw.attach(ws as never)
    const ev = sign(1, 'tampered', [])
    ev.content = 'tampered!'
    await gw.message(ws as never, JSON.stringify(['EVENT', ev]))
    const ok = ws.parsed().find((m) => m[0] === 'OK')
    expect(ok?.[2]).toBe(false)
  })

  it('public mode accepts third-party events and broadcasts to subscribers', async () => {
    const { gw } = setup('public', botPk)
    const reader = new MockSocket()
    const writer = new MockSocket()
    gw.attach(reader as never)
    gw.attach(writer as never)
    await gw.message(reader as never, JSON.stringify(['REQ', 's', { kinds: [1] }]))
    const ev = sign(1, 'public note', [])
    await gw.message(writer as never, JSON.stringify(['EVENT', ev]))
    const pushed = reader.parsed().filter((m) => m[0] === 'EVENT' && (m[2] as NostrEvent).id === ev.id)
    expect(pushed).toHaveLength(1)
  })

  it('matchFilter honors kinds, authors, #p and since', () => {
    const ev = sign(1, 'x', [['p', botPk]])
    expect(matchFilter({ kinds: [1] }, ev)).toBe(true)
    expect(matchFilter({ kinds: [4] }, ev)).toBe(false)
    expect(matchFilter({ authors: [ev.pubkey] }, ev)).toBe(true)
    expect(matchFilter({ '#p': [botPk] }, ev)).toBe(true)
    expect(matchFilter({ '#p': ['f'.repeat(64)] }, ev)).toBe(false)
    expect(matchFilter({ since: ev.created_at + 10 }, ev)).toBe(false)
  })
})
