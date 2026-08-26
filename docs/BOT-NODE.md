# The Bot Node

> **Every bot gets its own node.**

A Botstr bot is not a row in a shared database with a script attached. It is a
small, sovereign infrastructure node:

```
🪪 identity      its own Nostr keypair — generated for the bot, sealed in the vault
⚙️  runtime       its own isolate (Web Worker / Durable Object) — no shared memory
📡 gateway       its own relay connections (outbound today; inbound gateway on the roadmap)
🗄️  database      its own SQLite storage (DO storage backend / IndexedDB in the browser)
📦 object storage its own keyspace with a logical quota (R2 on the cloud executor)
🔐 secrets       its own sealed env vars (AES-256-GCM)
📊 monitoring    its own live status, uptime, and last-seen state
📝 logs          its own ring buffer, streamed to the dashboard
```

Alice's bot and Bob's bot never share state, sockets, keys, or logs. One
crashed, spammed, or compromised node cannot contaminate another.

## Where each node lives

Botstr's unit of isolation is the **Durable Object** (cloud) or **Web Worker**
(browser): one per bot, by construction, since the first commit.

## Verified economics (Cloudflare, August 2026 — recheck before printing numbers)

| Resource | Workers Free | Workers Paid ($5/mo) |
|---|---|---|
| Durable Objects | ✅ SQLite backend only | ✅ |
| Objects per namespace | unlimited | unlimited |
| Storage per object | ~1 GB (5 GB account-wide) | **10 GB** (+$0.20/GB-mo past 5 GB incl.) |
| Rows read/written | 5M + 100k **per day** | 25B + 50M **per month** included |
| D1 databases | 10 (500 MB each) | **50,000** (10 GB hard cap each), 1 TB/account |
| R2 storage | 10 GB-month/mo free, egress free | $0.015/GB-month |
| Worker scripts | 100 | 500 (Workers for Platforms: unlimited, $25/mo) |
| Outbound connections/invocation | 6 | 6 → **keep ≤ 6 relays per cloud bot** |
| Requests | 100k/day | 10M/mo included |

Sources: Cloudflare D1/Durable Objects/R2/Workers limits & pricing docs.

**Corrections this forces:**
- "10 GB free per bot" is *not a thing*. 10 GB is the per-object storage cap
  on the paid plan and R2's account-wide free allowance. Botstr therefore
  exposes **logical quotas** (per-bot, configurable, default 25 MB) and
  reports honest usage. Marketing follows the meter, not the other way round.
- Durable Objects **do work on the free plan** now (SQLite backend), with
  daily request/row caps — so 24/7 cloud bots are free-tier-viable for light
  traffic. Paid plan is for fleets and heavy bots.

## Tenancy models

**A — Shared worker, per-bot node (default).** One Botstr deployment, one DO
per bot. Isolation is at the isolate+storage level; economics are the best on
both plans; script/D1 budgets are untouched. *This is what Botstr implements.*

**B — Hard nodes (per-bot D1 + R2 bucket).** D1's per-tenant design (50k
databases/account on paid) makes this genuinely possible: a bot with heavy
data needs gets its own database and bucket. Costs nothing extra at rest —
D1 bills usage, not databases. Implement as an *upgrade path* per bot when a
template actually needs it (e.g. a SIP indexer bot), not as the default.

**C — Per-bot Worker (untrusted custom code).** The moment Botstr runs code a
user *wrote* (not built-in templates), isolation must move to the script
boundary: per-account script limits (100/500) make this an Enterprise/Workers
for Platforms ($25/mo, unlimited dispatch scripts, per-customer CPU limits)
feature. Deliberately out of MVP scope — see SECURITY.md.

## Distribution: deploy to *your* Cloudflare account

Botstr never pays for anyone's infrastructure, and nobody's bots live in our
account:

1. **Deploy to Cloudflare button** (same mechanism as SIP-Booster-Relay):
   clones this repo into the user's GitHub, provisions D1 + DO + secrets into
   *their* account, builds, deploys. No OAuth app needed.
2. **wrangler path** for developers (docs/DEPLOYMENT.md).
3. **Hosted provisioning service** (optional, later): the SIP-Booster "deploy
   service" pattern — Nostr login, pay in sats, relay/bot provisioned into the
   customer's own account. The orchestrator is Botstr; the infrastructure is
   always the user's.

```
Botstr (the software)                     User's Cloudflare account
───────────────────  deploy button  →     ┌────────────────────────┐
orchestration, dashboard,                 │ Botstr worker          │
templates, manifest spec                  │  ├─ DO: alice-bot  ⚡   │
                                          │  ├─ DO: bob-bot    ⚡   │
                                          │  ├─ D1: registry        │
                                          │  └─ R2: node storage    │
                                          └────────────────────────┘
```

## The Node API

Templates never name a database, bucket, or socket. They see:

| Node API | What it is |
|---|---|
| `node.identity` | the node's npub/pubkey |
| `node.state` | durable key-value store (survives restarts) |
| `node.memory` | semantic memory: `remember/recall/forget` + per-chat `history` — the bot owns its memory, not the AI provider |
| `node.files` | object storage, quota-enforced (`resources.storage_mb`) |
| `node.events` | normalized event stream (`message · mention · connection · lifecycle · schedule · publish · error`) |
| `node.schedule` | `every(seconds, fn)` recurring jobs |
| `node.log` | structured logs → dashboard |
| `node.reply / sendDM / post / search` | outbound Nostr actions, rate-limited (`resources.max_events_per_minute`) |
| `node.fetch` | outbound HTTP, only with the `network.outbound_http` capability |

Same API in the browser worker, the Durable Object, and (via IPC) the future
Rust runner. Templates are written once.

## The gateway: every node can be its own relay

Modes (chosen at deploy, changeable later):

| Mode | Endpoint | Accepts | Serves |
|---|---|---|---|
| `private` (default) | closed | — | — |
| `gateway` | `wss://<host>/nodes/<id>/relay` | events authored by or `p`-tagged to the bot (its mailbox) | the node's stored events |
| `public` | same | any valid event, per-connection rate limit | the node's stored events |

NIP-11 relay info is served at the same URL
(`Accept: application/nostr+json`), and `GET /nodes/<id>` returns the node's
discovery document (name, npub, status, capabilities, software) — the seed of
a future Botstr registry.

The gateway is a NIP-01 subset on purpose: REQ/EVENT/CLOSE, EOSE, OK, NOTICE,
signature verification, per-connection rate limiting, ring-buffered event
store. It is the node's front door, not a general-purpose relay — nosflare
remains the reference for full relay behavior.

## Roadmap notes

- **Replay on wake**: gateway events that arrive while a node is stopped are
  stored; replaying them into the core on start is the next iteration.
- **Files**: `/api/bots/:id/files/*` (R2-backed when bound, quota-enforced).
  The Vector runner will map its file send/receive onto this; Nostr file
  templates (NIP-96) can use it as a cache.
