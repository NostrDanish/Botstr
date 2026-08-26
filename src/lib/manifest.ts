/**
 * bot.yaml — the Botstr manifest (apiVersion botstr.dev/v1).
 *
 * The manifest describes REQUIREMENTS, never infrastructure: capabilities the
 * bot requests, resources it may consume, triggers it listens to. Providers
 * decide how those map to reality. Secrets are never part of the manifest.
 *
 * v1.1: namespaced capabilities (messaging.dm, nostr.publish, storage.files,
 * network.outbound_http, moderation, wallet.zap), logical resources, and the
 * node's relay gateway mode. Legacy flat v1 permission keys are still accepted
 * and normalized.
 */
import { z } from 'zod'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'
import { DEFAULT_RESOURCES, type BotPermissions, type BotRecord, type GatewayMode } from './types'

const capSchema = z.object({
  messaging: z
    .object({
      dm: z.boolean().default(false),
      public: z.boolean().default(false),
      reactions: z.boolean().default(false),
    })
    .default({ dm: false, public: false, reactions: false }),
  nostr: z.object({ publish: z.boolean().default(false) }).default({ publish: false }),
  storage: z.object({ files: z.boolean().default(false) }).default({ files: false }),
  network: z.object({ outbound_http: z.boolean().default(false) }).default({ outbound_http: false }),
  moderation: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  wallet: z.object({ zap: z.boolean().default(false) }).default({ zap: false }),
})

export const manifestSchema = z.object({
  apiVersion: z.literal('botstr.dev/v1'),
  kind: z.literal('Bot'),
  metadata: z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
    version: z.string().default('1.0.0'),
    description: z.string().max(500).optional(),
  }),
  template: z.string().min(1),
  runtime: z.object({
    type: z.enum(['nostr', 'vector', 'concord']),
    version: z.string().optional(),
  }),
  identity: z.object({ mode: z.enum(['generate', 'import']) }),
  permissions: capSchema,
  gateway: z.enum(['private', 'gateway', 'public']).default('private'),
  resources: z
    .object({
      storage_mb: z.number().int().min(1).max(10240).default(DEFAULT_RESOURCES.storageMB),
      max_events_per_minute: z.number().int().min(1).max(600).default(DEFAULT_RESOURCES.maxEventsPerMinute),
      max_relays: z.number().int().min(1).max(12).default(DEFAULT_RESOURCES.maxRelays),
    })
    .default({
      storage_mb: DEFAULT_RESOURCES.storageMB,
      max_events_per_minute: DEFAULT_RESOURCES.maxEventsPerMinute,
      max_relays: DEFAULT_RESOURCES.maxRelays,
    }),
  relays: z
    .array(z.string().regex(/^wss:\/\//, 'relays must be wss:// URLs'))
    .min(1, 'at least one relay is required')
    .max(12),
  triggers: z.array(z.enum(['message', 'mention', 'schedule'])).min(1),
  commands: z.array(z.string()).default([]),
  environment: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'SHOUTY_SNAKE_CASE'),
        description: z.string().optional(),
        required: z.boolean().default(false),
        secret: z.boolean().default(false),
      }),
    )
    .default([]),
  schedule: z.object({ interval_seconds: z.number().int().min(30) }).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})

export type BotManifest = z.infer<typeof manifestSchema>
export type ManifestPermissions = z.infer<typeof capSchema>

/** Legacy v1 flat keys → namespaced (normalize BEFORE schema parse). */
function normalizeLegacyPermissions(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const p = raw as Record<string, unknown>
  if (!('receive_messages' in p || 'send_messages' in p || 'public_mentions' in p || 'publish_public' in p)) return raw
  return {
    messaging: {
      dm: Boolean(p.receive_messages || p.send_messages),
      public: Boolean(p.public_mentions),
      reactions: Boolean(p.reactions),
    },
    nostr: { publish: Boolean(p.publish_public) },
    storage: { files: Boolean(p.files) },
    network: { outbound_http: Boolean(p.outbound_http ?? true) },
    moderation: { enabled: Boolean(p.moderation) },
    wallet: { zap: false },
  }
}

export type ParseResult = { ok: true; manifest: BotManifest } | { ok: false; errors: string[] }

export function parseManifest(text: string): ParseResult {
  let raw: unknown
  try {
    raw = yamlLoad(text)
  } catch (e) {
    return { ok: false, errors: [`YAML: ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    r.permissions = normalizeLegacyPermissions(r.permissions)
  }
  const res = manifestSchema.safeParse(raw)
  if (!res.success) {
    return { ok: false, errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  }
  return { ok: true, manifest: res.data }
}

export function manifestToYaml(m: BotManifest): string {
  return yamlDump(m, { lineWidth: 100, noRefs: true })
}

// ---------------------------------------------------------------------------
// capability mapping: manifest (what the bot requests) ↔ internal (what the core enforces)

export function toInternalPermissions(p: ManifestPermissions): BotPermissions {
  return {
    receiveMessages: p.messaging.dm,
    sendMessages: p.messaging.dm,
    publicMentions: p.messaging.public,
    publishPublic: p.nostr.publish,
    reactions: p.messaging.reactions,
    files: p.storage.files,
    moderation: p.moderation.enabled,
    outboundHttp: p.network.outbound_http,
  }
}

export function toManifestPermissions(p: BotPermissions): ManifestPermissions {
  return {
    messaging: { dm: p.receiveMessages || p.sendMessages, public: p.publicMentions, reactions: p.reactions },
    nostr: { publish: p.publishPublic },
    storage: { files: p.files },
    network: { outbound_http: p.outboundHttp },
    moderation: { enabled: p.moderation },
    wallet: { zap: false },
  }
}

/** Human-readable capability review ("THIS BOT REQUESTS"). */
export function capabilityReview(p: BotPermissions): { label: string; granted: boolean }[] {
  return [
    { label: 'Read Nostr relays', granted: true }, // every node reads its relays
    { label: 'Send & receive encrypted DMs', granted: p.receiveMessages && p.sendMessages },
    { label: 'Answer public mentions', granted: p.publicMentions },
    { label: 'Publish public notes', granted: p.publishPublic },
    { label: 'Store data (node database)', granted: true }, // state is intrinsic to a node
    { label: 'Store files (object storage)', granted: p.files },
    { label: 'Access external websites', granted: p.outboundHttp },
    { label: 'Reactions', granted: p.reactions },
    { label: 'Moderate communities', granted: p.moderation },
    { label: 'Access wallet / zaps', granted: false }, // not implemented anywhere yet
    { label: 'Access other bots', granted: false }, // never
  ]
}

/** Derive the portable manifest for a stored bot. Secrets are never included. */
export function manifestFromBot(
  bot: BotRecord,
  envSpecs: { name: string; description?: string; required?: boolean; secret?: boolean }[],
): BotManifest {
  return manifestSchema.parse({
    apiVersion: 'botstr.dev/v1',
    kind: 'Bot',
    metadata: { name: bot.name, version: bot.version, description: bot.description },
    template: bot.template,
    runtime: { type: bot.runtime },
    identity: { mode: 'generate' },
    permissions: toManifestPermissions(bot.permissions),
    gateway: bot.gateway,
    resources: {
      storage_mb: bot.resources.storageMB,
      max_events_per_minute: bot.resources.maxEventsPerMinute,
      max_relays: bot.resources.maxRelays,
    },
    relays: bot.relays,
    triggers: bot.triggers,
    commands: [],
    environment: envSpecs.map((e) => ({
      name: e.name,
      description: e.description,
      required: e.required ?? false,
      secret: e.secret ?? false,
    })),
    config: bot.config,
  })
}

export type { GatewayMode }
