import { describe, expect, it } from 'vitest'
import { manifestToYaml, parseManifest } from '../src/lib/manifest'

const VALID = `
apiVersion: botstr.dev/v1
kind: Bot
metadata:
  name: sip-search-bot
  version: 1.0.0
  description: Search the decentralized SIP index
template: sip-search
runtime:
  type: nostr
identity:
  mode: generate
permissions:
  receive_messages: true
  send_messages: true
relays:
  - wss://relay.example.com
triggers:
  - message
commands:
  - /search
environment:
  - name: SEARCH_ENDPOINT
    required: false
    secret: false
`

describe('bot.yaml manifest', () => {
  it('accepts a valid manifest and applies defaults', () => {
    const res = parseManifest(VALID)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.manifest.metadata.name).toBe('sip-search-bot')
    expect(res.manifest.permissions.public_mentions).toBe(false)
    expect(res.manifest.environment[0].name).toBe('SEARCH_ENDPOINT')
  })

  it('rejects an invalid bot name', () => {
    const res = parseManifest(VALID.replace('sip-search-bot', 'Bad Name!'))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.join()).toMatch(/metadata\.name/)
  })

  it('rejects non-wss relays', () => {
    const res = parseManifest(VALID.replace('wss://relay.example.com', 'http://insecure.example.com'))
    expect(res.ok).toBe(false)
  })

  it('rejects zero relays', () => {
    const res = parseManifest(VALID.replace('  - wss://relay.example.com', ''))
    expect(res.ok).toBe(false)
  })

  it('rejects unknown api versions', () => {
    const res = parseManifest(VALID.replace('botstr.dev/v1', 'botstr.dev/v99'))
    expect(res.ok).toBe(false)
  })

  it('rejects env var names that are not SHOUTY_SNAKE_CASE', () => {
    const res = parseManifest(VALID.replace('SEARCH_ENDPOINT', 'searchEndpoint'))
    expect(res.ok).toBe(false)
  })

  it('round-trips through YAML', () => {
    const res = parseManifest(VALID)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const again = parseManifest(manifestToYaml(res.manifest))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.manifest).toEqual(res.manifest)
  })
})
