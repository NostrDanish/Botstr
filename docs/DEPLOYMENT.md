# Deploying Botstr

Two ways to run Botstr — and you can use both at once.

## 1. Zero-setup (browser executor)

Serve the static dashboard anywhere (or just open the deployed URL). Bots run
in a Web Worker while the tab is open and resume when you return. Perfect for
development, demos, and low-stakes bots.

```
npm install && npm run build   # → dist/  (static, host it anywhere)
```

## 2. Always-on (Cloudflare executor) — the real deal

Bots become Durable Objects: they stay online when you close the tab,
self-heal when evicted, and cost ~nothing at bot scale (your
SIP-Booster-Relay experience applies — same DO + D1 shape).

### Prerequisites

- A Cloudflare account with the **Workers paid plan** (Durable Objects require
  it — same as your relay).
- Node.js ≥ 20 and this repo cloned.

### Steps

```bash
npm install

# 1. database (SQLite — the bot registry)
npx wrangler d1 create botstr
#    → copy the database_id into wrangler.jsonc (d1_databases[0].database_id)

# 2. apply the schema
npx wrangler d1 migrations apply botstr --remote

# 3. the secret that encrypts every bot key at rest
npx wrangler secret put BOTSTR_SECRET     # any long random string

# 4. build + deploy
npm run build
npx wrangler deploy
```

Open `https://botstr.<your-subdomain>.workers.dev` — the header badge should
flip from **browser runtime** to **cloud runtime connected**, and the deploy
wizard's *Runtime* step unlocks **Nostr · Cloudflare (24/7)**.

### Shakespeare one-click path

This repo is Shakespeare-native (`wrangler.jsonc` + `worker.ts` +
`dist/` assets is exactly Shakespeare's Cloudflare convention). In
[Shakespeare](https://shakespeare.diy): Settings → Deploy → add Cloudflare →
Deploy. Create the D1 database and `BOTSTR_SECRET` in the Cloudflare dashboard
first, same as above.

### Important: put auth in front

The `/api` surface is unauthenticated (single-tenant MVP). Before sharing the
URL, enable **Cloudflare Access** on the hostname (free, email OTP) — or any
reverse proxy auth. See [SECURITY.md](SECURITY.md).

## 3. Runner executor (Vector / Concord) — preview of the design

```
botstr-runner --token <pairing-token>    # your machine/VPS, Rust binary
```

Bots with `runtime: vector` or `concord` are dispatched to paired runners and
executed there (Vector SDK, embedded Tor, communities). Keys for runner bots
are generated on the runner. Design: [RUNTIME-ADAPTERS.md](RUNTIME-ADAPTERS.md).
The runner lands after the Vector SDK publication situation (old public repo
vs v0.3 docs) is pinned down.

## Upgrading

```
git pull && npm install && npm run build && npx wrangler deploy
```

Durable Object storage and D1 rows persist across deploys. If a migration
changes DO classes, `wrangler.jsonc` gains a new migration tag — wrangler
handles the rollout.
