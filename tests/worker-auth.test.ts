import { describe, expect, it } from 'vitest'
import worker from '../worker'

type Env = Parameters<typeof worker.fetch>[1]

const BOT_ID = '0123456789abcdef'
const RECORD = {
  id: BOT_ID,
  name: 'test-bot',
  template: 'echo',
  pubkey: 'ab'.repeat(32),
  relays: [],
  gateway: 'private',
}

/** Minimal Cloudflare binding stubs; the DO stub answers every subrequest OK. */
function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    BOTSTR_SECRET: 'test-secret',
    BOTSTR_OWNER_TOKEN: 'owner-token',
    ASSETS: { fetch: async () => new Response('assets') },
    DB: {
      prepare: () => {
        const stmt = {
          run: async () => ({}),
          all: async () => ({ results: [] }),
          first: async () => ({ record: JSON.stringify(RECORD) }),
          bind: () => stmt,
        }
        return stmt
      },
    },
    BOT_RUNNER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ nsecHex: 'cd'.repeat(32), secrets: {}, state: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    },
    ...overrides,
  } as unknown as Env
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://botstr.example${path}`, init)
const OWNER = { authorization: 'Bearer owner-token' }

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/api/bots'],
  ['POST', '/api/bots'],
  ['GET', `/api/bots/${BOT_ID}`],
  ['PATCH', `/api/bots/${BOT_ID}`],
  ['DELETE', `/api/bots/${BOT_ID}`],
  ['POST', `/api/bots/${BOT_ID}/start`],
  ['POST', `/api/bots/${BOT_ID}/stop`],
  ['POST', `/api/bots/${BOT_ID}/rotate`],
  ['POST', `/api/bots/${BOT_ID}/export`],
  ['GET', `/api/bots/${BOT_ID}/logs`],
  ['GET', `/api/bots/${BOT_ID}/events`],
  ['GET', `/api/bots/${BOT_ID}/files`],
]

describe('owner auth on /api/bots* (audit C5)', () => {
  it('keeps /api/health public', async () => {
    const res = await worker.fetch(req('/api/health'), makeEnv())
    expect(res.status).toBe(200)
  })

  it('fails closed (503) on every admin route when BOTSTR_OWNER_TOKEN is unset', async () => {
    const env = makeEnv({ BOTSTR_OWNER_TOKEN: undefined })
    for (const [method, path] of ADMIN_ROUTES) {
      const res = await worker.fetch(req(path, { method, headers: OWNER }), env)
      expect(res.status, `${method} ${path}`).toBe(503)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/BOTSTR_OWNER_TOKEN/)
    }
  })

  it('rejects missing and wrong bearer tokens with 401', async () => {
    const env = makeEnv()
    for (const [method, path] of ADMIN_ROUTES) {
      expect((await worker.fetch(req(path, { method }), env)).status, `${method} ${path} no header`).toBe(401)
      const wrong = await worker.fetch(req(path, { method, headers: { authorization: 'Bearer wrong-token' } }), env)
      expect(wrong.status, `${method} ${path} wrong token`).toBe(401)
      expect(wrong.headers.get('WWW-Authenticate')).toMatch(/^Bearer /)
    }
  })

  it('lets the owner reach /export (the audited nsec leak)', async () => {
    const res = await worker.fetch(req(`/api/bots/${BOT_ID}/export`, { method: 'POST', headers: OWNER }), makeEnv())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nsecHex: string }
    expect(body.nsecHex).toBe('cd'.repeat(32))
  })

  it('lets the owner enumerate bots', async () => {
    const res = await worker.fetch(req('/api/bots', { headers: OWNER }), makeEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
