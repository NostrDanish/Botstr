# Deploying Botstr

Botstr is software you run — not a service you trust. Three ways to run it,
in order of commitment:

## 1. Zero-setup (browser executor)

Serve the static dashboard anywhere. Bots run in a Web Worker while the tab
is open and resume when you return. Perfect for development, demos, and
low-stakes bots.

```
npm install && npm run build   # → dist/  (static, host it anywhere)
```

## 2. Always-on (Cloudflare executor) — your account, your bots

Bots become Durable Objects ("Bot Nodes", see [BOT-NODE.md](BOT-NODE.md)):
online when you close the tab, self-healing via a watchdog alarm, with their
own sealed secrets, database, and quota-enforced file storage.

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NostrDanish/Botstr)

Cloudflare clones the repo into your GitHub account, provisions the D1
database and Durable Object namespace **into your own account**, builds, and
deploys. Botstr (the project) never touches your infrastructure bill.

### Manual (wrangler)

Prerequisites: Node.js ≥ 20, a Cloudflare account. Durable Objects work on
the **free plan** (SQLite backend, daily request/row caps); the paid plan
($5/mo) removes daily caps and raises per-node storage from ~1 GB to 10 GB.

```bash
npm install

# 1. registry database (SQLite)
npx wrangler d1 create botstr
#    → copy database_id into wrangler.jsonc (d1_databases[0].database_id)
npx wrangler d1 migrations apply botstr --remote

# 2. the secret that encrypts every bot key at rest (REQUIRED)
npx wrangler secret put BOTSTR_SECRET     # any long random string

# 3. optional: object storage for bot files (see docs/BOT-NODE.md)
# npx wrangler r2 bucket create botstr-storage
#    → then uncomment the r2_buckets block in wrangler.jsonc

# 4. build + deploy
npm run build
npx wrangler deploy
```

Open `https://botstr.<your-subdomain>.workers.dev` — the header badge flips
from **browser runtime** to **cloud runtime connected**, and the wizard's
*Runtime* step unlocks **Nostr · Cloudflare (24/7)**.

### Shakespeare path

This repo is Shakespeare-native (`wrangler.jsonc` + `worker.ts` + `dist/`
assets is exactly its Cloudflare convention): Settings → Deploy → add
Cloudflare → Deploy. Create the D1 database and `BOTSTR_SECRET` first.

### Quotas & honest limits

| Knob | Where | Default |
|---|---|---|
| Node file storage quota | bot config (`storageQuotaMB`) | 25 MB logical — set it against *your* plan's real numbers (docs/BOT-NODE.md) |
| Relays per cloud bot | platform limit | ≤ 6 outbound connections |
| Free plan | Cloudflare | 100k req/day, 5 GB DO storage/account, ~1 GB per node |
| Paid plan ($5/mo) | Cloudflare | unmetered requests, 10 GB per node, 50k D1 databases |

### Important: put auth in front

The `/api` surface is unauthenticated (single-tenant MVP). Before sharing the
URL, enable **Cloudflare Access** on the hostname (free, email OTP) — or any
reverse-proxy auth. See [SECURITY.md](SECURITY.md).

## 3. Runner executor (Vector / Concord) — design stage

```
botstr-runner --token <pairing-token>    # your machine/VPS, Rust binary
```

Bots with `runtime: vector` or `concord` dispatch to paired runners and
execute there (Vector SDK: communities, files, embedded Tor). Keys for runner
bots are generated on the runner and never transit the dashboard. Design:
[RUNTIME-ADAPTERS.md](RUNTIME-ADAPTERS.md).

## Upgrading

```
git pull && npm install && npm run build && npx wrangler deploy
```

Durable Object storage and D1 rows persist across deploys. If a migration
changes DO classes, `wrangler.jsonc` gains a new migration tag — wrangler
handles the rollout.
