# bot.yaml — Botstr Manifest v1

Every Botstr bot is described by a versioned, machine-readable manifest. The
manifest is the bot's portable definition: export it, hand it to another
Botstr instance, or translate it to a runtime's native config.

**Secrets are never part of the manifest.** It declares *which* secrets a bot
needs (`environment[].secret: true`); values live in the vault.

```yaml
apiVersion: botstr.dev/v1        # required, exact
kind: Bot                        # required, exact

metadata:
  name: sip-search-bot           # lowercase letters, digits, dashes
  version: 1.0.0
  description: Search the decentralized SIP index

template: sip-search             # built-in template id (registry refs later)

runtime:
  type: nostr                    # nostr | vector | concord
  version: ">=1"                 # optional runtime version constraint

identity:
  mode: generate                 # generate | import

permissions:                     # all default false unless listed
  receive_messages: true
  send_messages: true
  public_mentions: false
  publish_public: false
  reactions: false               # vector runtime
  files: false                   # vector runtime
  moderation: false

relays:                          # 1..12, wss:// only
  - wss://relay.damus.io
  - wss://nos.lol

triggers:                        # at least one
  - message                      # NIP-17 DMs
  # - mention                    # public kind-1 mentions (needs public_mentions)
  # - schedule                   # template-driven ticking

commands:                        # informational; templates implement them
  - /search

environment:                     # declarations only — values are in the vault
  - name: SEARCH_ENDPOINT
    description: SIP-01 relay URL
    required: false
    secret: false

schedule:                        # optional, only with the schedule trigger
  interval_seconds: 300          # minimum 30

config:                          # free-form template config (validated by the template's schema)
  searchRelay: wss://your-sip-relay.example.com
  resultsLimit: 5
```

## Validation rules (enforced by `src/lib/manifest.ts`)

- `metadata.name`: `^[a-z0-9][a-z0-9-]*$`, ≤ 64 chars.
- `relays`: 1–12 entries, each starting `wss://`.
- `environment[].name`: `^[A-Z][A-Z0-9_]*$`.
- `schedule.interval_seconds`: integer ≥ 30.
- Unknown `apiVersion`/`kind` are rejected outright — parsers must fail closed.

## Export & portability

The dashboard's *Config* tab exports the manifest for any bot. Combined with
the bot's nsec (reveal/export on the bot page) that is everything needed to
run the bot anywhere else: Botstr holds nothing hostage.
