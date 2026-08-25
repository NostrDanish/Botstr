# Contributing to Botstr

Botstr is MIT-licensed infrastructure for the Nostr ecosystem. Contributions
welcome — with a few hard rules.

## Hard rules (they exist so users can trust the platform)

1. **Never log, serialize, or transmit private keys** beyond the documented
   vault/runtime paths. PRs that touch key handling get hostile review.
2. **No fake functionality.** Status, logs, events and search results are real
   or the feature doesn't ship. A disabled toggle with an honest explanation
   beats a working-looking lie.
3. **Don't invent protocol.** Where a NIP applies, implement the NIP. New
   semantics belong in a CORD/NIP-style doc first (see `spec/`).
4. **Templates are pure `BotModule`s** — no direct `WebSocket`, no global
   state, everything through `Ctx`. ( enforced in review; the registry era
   will enforce it structurally.)

## Adding a template

`src/lib/templates.ts`. You need:

```ts
{
  id: 'my-bot',                 // unique, kebab-case
  name, tagline, description,   // shown in the wizard
  category, icon,               // lucide icon name
  runtimeSupport: ['nostr'],
  defaults: { triggers, permissions, relays },
  env: [{ name, description, required, secret, default }],
  fields: [{ key, label, type, required, default, help }],   // wizard UI schema
  commands: ['/whatever'],
  module: { onStart?, onMessage?, onTick?, onStop? },
}
```

Test it with the mock-ctx pattern in `tests/templates.test.ts`, then run the
real thing: `npm run dev` → deploy your template against
`wss://relay.damus.io` → DM it from a real client. A template PR without a
test and a screenshot of it answering a real DM will be asked for both.

## Running checks

```
npm test          # manifest, giftwrap roundtrip, templates, feed parser
npm run build     # type-checks via the bundler, produces dist/
```

## Code shape

- `src/lib/*` is isomorphic (runs in browser, Web Worker, Durable Object,
  Node tests). **No DOM APIs, no `window`, no Node APIs** in `lib/`.
- UI lives in `src/pages` + `src/components` only.
- The Cloudflare runtime (`worker.ts`) shares `lib/` — if your change breaks
  the worker build, it breaks the 24/7 executor.

## Roadmap hooks

- Vector runner (Rust) — see docs/RUNTIME-ADAPTERS.md, and pin the SDK
  publication question first.
- Nostr-native template registry (manifest + README + icon as events).
- Passphrase vault mode, per-sender rate limiting, template marketplace.
