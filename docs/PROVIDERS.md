# Providers & Runtimes — Cloud Default, Self-Host Always

Two axes, kept deliberately separate:

- **Runtime = WHAT runs the bot** (protocol engine): `nostr` today, `vector`
  and `concord` next.
- **Provider = WHERE the node runs** (deployment target): `browser`,
  `cloudflare`, `docker`/self-host, `runner`.

Never combine them. A Vector bot on Docker and a Vector bot on a runner are
the same bot; a Nostr bot on Cloudflare and a Nostr bot in a browser are the
same bot. The `bot.yaml` manifest describes **requirements, not
infrastructure** — providers decide how to satisfy them.

## The Botstr promise

> Deploy a Nostr bot in one click.
> Cloudflare if you want easy. Docker if you want control.
> Local if you want simplicity. Self-host if you want sovereignty.
> **Your bot. Your identity. Your data. Your infrastructure.**

## The final architectural test

Before any feature is accepted:

> **"Can this feature work without Cloudflare?"**
>
> YES → it belongs in Botstr Core (`src/lib/`).
> NO  → it belongs behind a provider adapter.

Cloudflare-specific code may never leak into the manifest, the Node API, the
runtime API, identity, storage, or the event model. Today the only
Cloudflare-shaped files are `worker.ts` + `wrangler.jsonc` — everything else
is isomorphic TypeScript.

## Provider interface (conceptual)

```ts
interface DeploymentProvider {
  id: string                      // 'browser' | 'cloudflare' | 'docker' | …
  available(): Promise<boolean>
  provision(bot: BotRecord): Promise<void>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  remove(id: string): Promise<void>
  live(id: string): Promise<BotLiveState>
  logs(id: string, after?: number): Promise<LogEntry[]>
}
```

| Provider | Status | How |
|---|---|---|
| `browser` | ✅ | Web Worker per node; IndexedDB vault/state/files |
| `cloudflare` | ✅ | Durable Object per node; D1 registry; R2 files; gateway relays |
| `docker` | ✅ (same code) | `docker compose up` → wrangler local runtime (see SELF-HOSTING.md) |
| `runner` | 📐 designed | Rust binary hosting Vector/Concord bots (RUNTIME-ADAPTERS.md) |
| future: Fly/Railway/Render/AWS/GCP | adapter-shaped | implement `DeploymentProvider`, change nothing else |

## Storage abstractions

The Node API never names a database product:

| Node API | browser | cloudflare | docker (today) |
|---|---|---|---|
| `node.state` / `node.memory` | IndexedDB | DO SQLite storage | same (local runtime) |
| `node.files` | IndexedDB + quota | R2 (or DO storage) + quota | same |
| `node.logs` / `node.events` | IndexedDB ring | DO storage ring | same |
| registry | IndexedDB `bots` | D1 `bots` | same |

Native `SQLiteProvider`/`PostgresProvider`/`S3Provider` are addable without
touching a single template.

## "Bring your own Cloudflare"

Botstr provisions into the **user's** account, never ours:

1. **Deploy button** (README) — clones the repo, provisions D1/DO/secrets into
   the user's Cloudflare account. No OAuth app required.
2. **wrangler** — same effect for developers.
3. Hosted provisioning with Nostr login (the SIP-Booster deploy-service
   pattern) is an optional future layer — the resources still land in the
   customer's account.

## Adding a provider — rules

1. Implement `DeploymentProvider` against the Node API; do not extend the core.
2. If the provider can't do something (e.g. no inbound sockets), say so in
   `capabilities` — the UI adapts; nothing is faked.
3. Secrets are sealed before they touch any provider storage.
4. A bot exported from your provider must import cleanly everywhere else.
