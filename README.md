# Botstr

**Deploy Nostr bots in minutes.**

Botstr is an open-source, self-hostable deployment platform for Nostr-based bots. Pick a template, generate a dedicated bot identity, choose relays, click **Deploy** — and a real bot is live, holding its own keys and speaking real Nostr (NIP-17 encrypted DMs, public mentions, scheduled posts).

No Rust. No Docker. No relay administration. No fake dashboard — status, logs and events are the bot's actual runtime output.

**Every bot gets its own node** — its own identity, isolate, database, sealed secrets, storage quota and logs (see [docs/BOT-NODE.md](docs/BOT-NODE.md)). And Botstr never hosts your infrastructure: you deploy the whole platform into **your own** Cloudflare account with one click:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NostrDanish/Botstr)

```
Choose template → Configure → Generate identity → Relays → Permissions → Secrets → Deploy
        │
        ▼
  ┌───────────┐   browser executor (Web Worker) — runs while the dashboard is open
  │  Botstr   │   cloudflare executor (Durable Object per bot) — 24/7, self-healing
  │ dashboard │   runner executor (future) — Vector SDK / Concord, self-hosted
  └───────────┘
```

## Why

Every bot-hosting platform is a company sitting between you and your users. Botstr is infrastructure you can hold: the whole platform is a static dashboard plus one Cloudflare worker you deploy into **your own** account. Bots are plain Nostr identities with portable `bot.yaml` manifests — export one and run it anywhere.

## Quick start

**Try it in the browser (zero setup):** open the dashboard, *Deploy Bot → Echo Bot → generate identity → deploy*. DM the bot's npub from any Nostr client that supports NIP-17 (e.g. Vector) and it answers. Bots run while the tab is open; the dashboard resumes them when you return.

**Run it always-on (your Cloudflare account):** see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). `npm run build && npx wrangler deploy` — bots then run as Durable Objects with a watchdog alarm, surviving tab closes and isolate evictions.

**Develop:**

```
npm install
npm run dev     # dashboard
npm test        # manifest, giftwrap, template, and parser tests
npm run build   # static site → dist/
```

## Templates

| Template | What it does |
|---|---|
| **Echo** | Replies to every message. The end-to-end pipeline check. |
| **Command** | `/ping` `/echo` `/help` — a slash-command router to build on. |
| **AI** | Chats through any OpenAI-compatible endpoint (`OPENAI_BASE_URL`, `MODEL`, `OPENAI_API_KEY`). |
| **Moderation** | Configurable word filter: warn / ignore / block senders. |
| **Price** | `/price` answers live CoinGecko quotes; optional scheduled public posts. |
| **RSS / News** | Polls any RSS/Atom feed, posts new items as Nostr notes, dedupes across restarts. |
| **SIP Search** | `/search <query>` against a configurable SIP-01 relay (NIP-50 over kind 39697) — decentralized web search in a DM. Pairs with a [SIP Booster Relay](https://github.com/NostrDanish/SIP-Booster-Relay). |

## Runtimes

Botstr is runtime-agnostic; the dashboard drives adapters behind one `BotRuntime` interface.

| Runtime | Executor | Status |
|---|---|---|
| Nostr (NIP-17 DMs, mentions, public posts, schedules) | Browser | ✅ works today |
| Nostr, same core | Cloudflare Durable Objects | ✅ works once deployed |
| Vector (communities, roles, files, Tor) via [Vector SDK](https://vectorapp.io) | Self-hosted Rust runner | 📐 designed, see [docs/RUNTIME-ADAPTERS.md](docs/RUNTIME-ADAPTERS.md) |
| Concord (CORD-01…08 private communities) | Same runner | 📐 spec stage — the spec lives in [spec/](spec/) |

## Security model (short version)

- Bots get **their own** identities; your personal key is never used.
- Secret keys are AES-256-GCM encrypted at rest (device key in the browser vault; `BOTSTR_SECRET` in the cloud runtime) and never appear in logs, URLs, manifests, or the bot record.
- Templates are built-in, reviewed code — Botstr MVP never executes arbitrary uploaded code.
- Per-bot isolation: a Web Worker per bot in the browser, a Durable Object isolate per bot in the cloud.

Full threat model: [docs/SECURITY.md](docs/SECURITY.md).

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data flow, executors
- [BOT-MANIFEST.md](docs/BOT-MANIFEST.md) — the `bot.yaml` v1 spec
- [RUNTIME-ADAPTERS.md](docs/RUNTIME-ADAPTERS.md) — writing a runtime (Vector, Concord, …)
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — self-hosting on Cloudflare
- [SECURITY.md](docs/SECURITY.md) — threat model and hardening
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — adding templates, hacking on Botstr

## Principles

Botstr is infrastructure; **Nostr is the protocol**. Where a NIP exists we use it (NIP-17/44/59 for DMs, kind 1 for public posts, NIP-50 for SIP search) and invent nothing. Bots are exportable (`bot.yaml` + nsec) and portable. There is no hosted Botstr you must trust — deploy your own.

[![Edit with Shakespeare](https://shakespeare.diy/badge.svg)](https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2FBotstr.git)

## License

MIT.
