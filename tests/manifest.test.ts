import { describe, expect, it } from 'vitest'
import { manifestToYaml, parseManifest, toInternalPermissions, toManifestPermissions } from '../src/lib/manifest'

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
    expect(res.manifest.environment[0].name).toBe('SEARCH_ENDPOINT')
    expect(res.manifest.gateway).toBe('private')
    expect(res.manifest.resources.storage_mb).toBe(25)
  })

  it('normalizes legacy v1 flat permissions into namespaced capabilities', () => {
    const res = parseManifest(VALID) // VALID uses receive_messages/send_messages (v1 style)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.manifest.permissions.messaging.dm).toBe(true)
    expect(res.manifest.permissions.messaging.public).toBe(false)
    expect(res.manifest.permissions.nostr.publish).toBe(false)
    expect(res.manifest.permissions.wallet.zap).toBe(false)
  })

  it('parses v1.1 namespaced capabilities and gateway/resources', () => {
    const res = parseManifest(`
apiVersion: botstr.dev/v1
kind: Bot
metadata:
  name: gateway-bot
template: echo
runtime: { type: nostr }
identity: { mode: generate }
permissions:
  messaging: { dm: true, public: true }
  nostr: { publish: true }
  storage: { files: true }
  network: { outbound_http: false }
gateway: gateway
resources:
  storage_mb: 100
  max_events_per_minute: 10
relays: [wss://relay.example.com]
triggers: [message]
`)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const internal = toInternalPermissions(res.manifest.permissions)
    expect(internal.sendMessages).toBe(true)
    expect(internal.publicMentions).toBe(true)
    expect(internal.publishPublic).toBe(true)
    expect(internal.files).toBe(true)
    expect(internal.outboundHttp).toBe(false)
    expect(res.manifest.gateway).toBe('gateway')
    expect(res.manifest.resources.max_events_per_minute).toBe(10)
    // internal → manifest round trip
    const back = toManifestPermissions(internal)
    expect(back).toEqual(res.manifest.permissions)
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
