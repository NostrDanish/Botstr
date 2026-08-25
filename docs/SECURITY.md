# Botstr Security Model

Botstr handles other people's keys. This document is the threat model and what
we do about it — including what we deliberately **don't** do yet.

## Assets

1. **Bot secret keys** — control the bot's identity, DMs, and (via Lightning
   address metadata) possibly money.
2. **Secret env vars** — e.g. `OPENAI_API_KEY`.
3. **Message content** — NIP-17 DMs are encrypted end-to-end; Botstr executors
   see plaintext by necessity and must not leak it.
4. **The host** — the machine running Botstr (your browser, your Cloudflare
   account, your runner).

## Rules the code enforces

- Bots get **their own generated identities**. The user's personal Nostr key
  is never requested, used, or stored.
- Secrets are **AES-256-GCM encrypted at rest**:
  - browser executor: non-extractable device key in IndexedDB (`vault.ts`);
  - cloudflare executor: sealed with `BOTSTR_SECRET` before touching DO
    storage; the API **refuses to run** if `BOTSTR_SECRET` is unset.
- Secrets never appear in: logs, URLs, `bot.yaml`, the bot record, analytics
  (there are none), or error messages (relay errors are passed through, and
  relay `OK` messages don't contain key material by protocol).
- Secrets cross the wire exactly once (browser → your own deployment's API,
  TLS) and only for cloud bots; browser-executor secrets never leave the
  device.
- **No arbitrary code execution.** MVP templates are built-in, reviewed
  modules compiled into the app. There is no upload-your-code path yet; when
  it arrives it must run in a fresh isolate with no vault access.
- Manifest validation fails closed (unknown version/kind rejected).

## Isolation

| Executor | Sandbox | Resource limits |
|---|---|---|
| browser | one Web Worker per bot (no DOM, no IndexedDB access from the bot process) | browser-enforced |
| cloudflare | one Durable Object (V8 isolate) per bot — no shared memory between bots | Workers CPU/memory limits |
| runner | one process per bot (Vector SDK contract) | OS-level (systemd/Docker on the runner) |

## Threat model notes & MVP limits (honest list)

- **Malicious template** — mitigated by built-ins only. Future registry
  templates need review + signing; tracked in CONTRIBUTING.
- **XSS in dashboard** — message text is rendered as text (React escapes);
  no `dangerouslySetInnerHTML` anywhere.
- **SSRF via templates** — `ctx.fetch` targets are template-fixed (CoinGecko,
  configured feed/endpoint). A malicious config URL could make the *executor*
  fetch internal addresses on a self-hosted runner; runners should apply
  egress policy. Documented for runner operators.
- **Relay abuse / rate limits** — bots publish only in response to triggers or
  schedules (≥30s). Reconnect backoff caps at 60s. Operators are responsible
  for relay etiquette.
- **Browser vault is device-bound** — malware with device access wins. For
  high-value bots, use the cloudflare executor (`BOTSTR_SECRET` in Workers
  secrets) or the runner. A passphrase mode (PBKDF2) is planned.
- **Cloudflare API auth** — the MVP API is unauthenticated: it is *your*
  single-tenant deployment, but anyone with the URL could drive it. Put
  Cloudflare Access (or any SSO) in front, or add `ADMIN_TOKEN` checks before
  exposing it. This is called out in DEPLOYMENT.md because it matters.
- **DoS via inbound DMs** — per-template responsibility today (dedupe in core
  caps memory). Rate limiting per sender is on the template roadmap.
- **Dependency risk** — few, pinned deps (`nostr-tools`, `zod`, `js-yaml`,
  React). `npm audit` in CI is recommended for forks.

## Reporting

Open a private security advisory on GitHub (or DM the maintainers on Nostr).
Do not file public issues for key-handling bugs.
