# Runtime Adapters

Botstr core knows three things about a runtime: its **type** (`nostr`,
`vector`, `concord`), the **executor** it runs on (`browser`, `cloudflare`,
`runner`), and its **capabilities**. Everything else is the adapter's business.

## The contract

```ts
interface Adapter {
  executor: ExecutorType
  available(): Promise<boolean>            // can this dashboard use it right now?
  start(bot: BotRecord): Promise<void>     // provisions + boots the bot
  stop(botId: string): Promise<void>
  remove(botId: string): Promise<void>
  live(botId: string): BotLiveState        // REAL status only
}
```

Capabilities (advertised, never assumed):

```ts
{ messaging, directMessages, publicMentions, publishing, communities,
  reactions, files, moderation, tor, scheduling, alwaysOn }
```

The wizard renders only what the selected runtime actually supports. A runtime
that lacks communities must say so; the UI greys out community features. No
fake toggles.

## What a template sees

Templates are runtime-agnostic. They receive normalized input and act through
`Ctx` (`src/lib/core.ts`):

```ts
interface Msg { id; from; text; ts; kind: 'dm' | 'mention'; relay }
interface Ctx {
  pubkey; npub; env; config; permissions; state        // state = per-bot KV, persisted
  reply(msg, text)  sendDM(to, text)  post(text)       // outbound
  search(relayUrl, filter, limit)                      // one-shot NIP-50 query
  fetch(url, init)                                     // guarded egress
  log(level, msg)
}
```

A Vector adapter implements the same `Ctx` against SDK calls
(`msg.reply`, `channel.send`, …); a Concord adapter against CORD-01 streams.
Templates don't change.

## Vector adapter (design)

The Vector SDK is Rust-only and process-owning (one bot per process, embedded
Tor, communities with roles/invites — see `vectorapp.io` docs, SDK v0.3 /
Vector v0.4). So the Vector executor is a **runner**: a self-hosted Rust
binary you run on your own machine/VPS:

```
botstr-runner --token <pairing-token> --data-dir ~/.botstr
```

1. Pairing: the dashboard shows a one-time token; the runner exchanges it for
   work over a WebSocket to your Botstr deployment (outbound-only — no open
   ports, no NAT dance).
2. The runner receives `BotRecord`s (secrets delivered encrypted with a
   runner-held keypair), builds `VectorBot::builder().nsec(...)`, and maps SDK
   events onto `BotEvent`s back to the dashboard.
3. Bot keys are generated *on the runner* for `identity.mode: generate` — key
   material for runner bots never transits the dashboard at all.

⚠️ **Version risk, recorded honestly:** the public `VectorPrivacy/Vector-SDK`
repo is marked "(Old)" (v0.2.1 API) while the current docs describe v0.3.0
against Vector ≥ 0.4.0. Before building the runner, pin where `vector_sdk`
0.3 is published (crates.io vs git) and adapt the runner to the *actual*
crate. Do not code against the README.

## Concord adapter (design)

Concord (CORD-01…08, see `spec/`) needs no new crypto: CORD-01 streams are
kind-1059 giftwraps signed by a shared stream key with NIP-44 self-ECDH —
primitives Botstr already implements. A Concord adapter subscribes the stream
address, maps stream seals to `Msg`, and signs replies with the stream key.
Communities, roles and rekeys (CORD-02…06) arrive with a Concord client
library; the adapter boundary is already shaped for them.

## Adding a template

Built-in for now (MVP deliberately does not execute uploaded code). A template
is a `TemplateDef` in `src/lib/templates.ts`: metadata + wizard field schema +
a `BotModule` (`onStart/onMessage/onTick/onStop`). The registry era will let
developers publish `{ bot.yaml, README, icon, source }` to a Nostr-based
registry; the template system already speaks manifests.
