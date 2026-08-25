# Botstr Architecture

## 60-second version

```
┌─────────────────────────────────────────────────────────────┐
│ Dashboard (React, static assets — runs anywhere)            │
│  wizard → bot.yaml → BotRecord + vault                      │
└──────────────┬──────────────────────────────────────────────┘
               │ BotRuntime interface (start/stop/restart/status/logs/events)
     ┌─────────┴──────────┬─────────────────────┐
     ▼                    ▼                     ▼
┌──────────┐     ┌─────────────────┐    ┌──────────────────┐
│ Browser  │     │ Cloudflare      │    │ Runner (future)  │
│ executor │     │ executor        │    │ Rust binary that │
│ 1 Web    │     │ 1 Durable       │    │ hosts Vector SDK │
│ Worker/  │     │ Object/bot +    │    │ and (later)      │
│ bot      │     │ D1 registry     │    │ Concord          │
└────┬─────┘     └───────┬─────────┘    └────────┬─────────┘
     └───────────────────┼───────────────────────┘
                         ▼
              shared bot core (core.ts)
        relays · NIP-17 giftwraps · dedupe · ctx
                         ▼
                   Nostr relays
```

Every layer is swappable. The **template** never knows where it runs; the
**executor** never knows what the template does; the **dashboard** never
touches a private key outside the vault.

## Components

| Piece | File | Job |
|---|---|---|
| Manifest | `src/lib/manifest.ts` | `bot.yaml` v1 schema (zod), parse/validate/serialize. The portable bot definition. |
| Vault | `src/lib/vault.ts` | AES-256-GCM sealed secrets (browser: non-extractable device key; cloud: `BOTSTR_SECRET`). |
| Store | `src/lib/db.ts` | IndexedDB: bot records, capped logs (600), events (300), template state. |
| Giftwrap | `src/lib/giftwrap.ts` | NIP-17 DMs by hand: rumor → seal (kind 13) → wrap (kind 1059), NIP-44 v2, randomized timestamps. |
| Relay client | `src/lib/relay.ts` | One WebSocket per relay. Reconnect/backoff, resubscribe, OK/EOSE/NOTICE/CLOSED. |
| Core | `src/lib/core.ts` | The engine: wires relays → normalizes events → runs the template module → ctx.reply/post/search. |
| Templates | `src/lib/templates.ts` | Built-in, reviewed bot behaviors + their config schemas for the wizard. |
| Manager | `src/lib/runtime.ts` | Dashboard-side lifecycle: create/start/stop/restart/delete, adapter routing, live state, resume. |
| Worker entry | `src/lib/worker-entry.ts` | Browser executor: one Web Worker per bot. |
| Cloud runtime | `worker.ts` | API + `BotRunner` Durable Object (per-bot isolate, encrypted secrets, watchdog alarm). |

## The Bot Node

Every bot is a **node**: its own identity, isolate, relay gateway, SQLite
database, object-storage quota, sealed secrets, monitoring and logs. One bot
can never contaminate another's state. The full model — verified Cloudflare
quotas, the per-bot-D1 upgrade path, and the "deploy to your own account"
distribution story — lives in [BOT-NODE.md](BOT-NODE.md).

## The BotRuntime contract

```ts
interface Adapter {
  executor: 'browser' | 'cloudflare' | 'runner'
  available(): Promise<boolean>
  start(bot: BotRecord): Promise<void>   // bot + vault secrets → live process
  stop(botId): Promise<void>
  remove(botId): Promise<void>
  live(botId): BotLiveState              // status, startedAt, detail
}
```

Status values are **real**: `created · starting · running · stopped · failed ·
crashed · updating`, reported by the executor, never assumed by the UI.

## Executors

### Browser

One Web Worker per bot, spawned with the config + decrypted secrets (memory
only). Real relay connections, real signatures. Bots stop when the tab closes
and are **resumed** when the dashboard reopens (logged as such). This executor
makes Botstr usable with zero infrastructure and is the dev/test loop for
templates.

### Cloudflare

`worker.ts` serves the dashboard as static assets and exposes `/api/*`. Each
bot is a `BotRunner` Durable Object: its own V8 isolate holding outbound
WebSockets to relays, running the *same* `core.ts` + template. Registry rows
live in D1 (SQLite). Secrets are sealed with `BOTSTR_SECRET` before touching
DO storage. A 30s alarm watchdog re-runs any bot whose isolate was evicted —
crash recovery without Kubernetes.

### Runner (future: Vector, Concord)

Vector bots need Rust (communities, files, Tor) — they can't run in a browser
or a Worker. The runner is a small self-hosted binary that authenticates to a
Botstr deployment and executes `BotRecord`s locally against the Vector SDK.
The dashboard only ever holds what it needs: runner-hosted bots keep keys on
the runner. See [RUNTIME-ADAPTERS.md](RUNTIME-ADAPTERS.md).

Concord (spec in `spec/`) is pure NIP-44/59 construction — its adapter can be
TypeScript or Rust and lands after Vector.

## Event model

Executors normalize everything into:

```
message · mention · connection · error · lifecycle · schedule · publish
```

stored per-bot (capped) and streamed to the dashboard. Templates additionally
see `Msg { id, from, text, ts, kind: 'dm'|'mention', relay }` — one shape
whether the runtime is Nostr today or Vector tomorrow.

## Why not Docker for MVP?

The master plan calls for containers. Isolation per bot is the actual
requirement; V8 isolates (Web Workers / Durable Objects) provide it with zero
host surface, platform-enforced resource limits, and free-tier economics — the
same trade nosflare/SIP-Booster-Relay proved for relays. Docker remains the
right home for the Vector/Concord runner, and the adapter interface means that
decision is reversible.
