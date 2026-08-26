# Self-Hosting Botstr

Cloudflare is the default, never the requirement. The Botstr promise:
**your bot, your identity, your data, your infrastructure.**

## Docker (recommended self-host path)

```bash
git clone https://github.com/NostrDanish/Botstr.git
cd Botstr
BOTSTR_SECRET=$(openssl rand -hex 32) docker compose up -d
# → http://localhost:8787
```

One container carries the whole platform: dashboard, API, bot nodes
(Durable Objects), database (D1 → local SQLite), object storage (R2 → local
emulation) — all through wrangler's local runtime, so self-hosted behavior is
the *same code* as the cloud executor, not a fork of it.

Works on any Docker host: VPS, home server, Raspberry Pi (ARM64), NAS,
Proxmox, Unraid, Synology. Kubernetes is not needed and not required.

## Local development (no Docker)

```bash
npm install
npx wrangler d1 migrations apply botstr --local
BOTSTR_SECRET=dev-secret npx wrangler dev --local
```

Or the pure-browser dev loop (no local runtime at all):

```bash
npm run dev   # bots run in Web Workers in your browser
```

## Backups

- **Platform state**: the `botstr-data` volume (`/data`) holds the registry
  and every node's Durable Object storage (state, logs, events, sealed keys).
  Back up the volume + your `BOTSTR_SECRET`. Without the secret, sealed keys
  are unrecoverable by design.
- **Per-bot**: use *Export bundle* on any bot's Config tab — a portable JSON
  with manifest, identity (optional), secrets (optional) and state.

## Migration

**Cloudflare → self-host:** on the cloud deployment, export the bot bundle
*with identity*; on your self-hosted instance, Home → Import bundle. The bot
keeps its npub, config, memory and state.

**Self-host → Cloudflare:** same flow in reverse. Same bundle, same identity.

## Reverse proxy / TLS

Put Caddy/nginx/Traefik in front for a real domain. The only hard requirement:
**WebSocket upgrade support** (bot node gateways are `wss://`). Caddy handles
this by default:

```
bots.example.com {
    reverse_proxy localhost:8787
}
```

## Honest limitations of the current self-host path

- It runs through wrangler's local emulation (miniflare), not a native Node
  adapter. That's deliberate for now: one codebase, zero drift. A native
  `NodeProvider` (no Cloudflare emulation at all) is a clean adapter task
  because of the Node API — see docs/PROVIDERS.md.
- Behind NAT? Nodes dial *out* to relays, so bots work fine; exposing the
  gateway endpoint needs a reachable address (or a tunnel).

## Upgrading

```bash
git pull && docker compose up -d --build
```

Node state, registry and sealed keys persist in the volume.
