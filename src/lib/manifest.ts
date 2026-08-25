/**
 * bot.yaml — the Botstr manifest (apiVersion botstr.dev/v1).
 * Machine-readable, versioned, runtime-agnostic. A manifest fully describes a
 * bot; a Botstr bot is exportable and runnable outside Botstr.
 */
import { z } from 'zod'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'
import type { BotRecord } from './types'

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
  identity: z.object({
    mode: z.enum(['generate', 'import']),
  }),
  permissions: z.object({
    receive_messages: z.boolean().default(true),
    send_messages: z.boolean().default(true),
    public_mentions: z.boolean().default(false),
    publish_public: z.boolean().default(false),
    reactions: z.boolean().default(false),
    files: z.boolean().default(false),
    moderation: z.boolean().default(false),
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

export type ParseResult =
  | { ok: true; manifest: BotManifest }
  | { ok: false; errors: string[] }

export function parseManifest(text: string): ParseResult {
  let raw: unknown
  try {
    raw = yamlLoad(text)
  } catch (e) {
    return { ok: false, errors: [`YAML: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const res = manifestSchema.safeParse(raw)
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  return { ok: true, manifest: res.data }
}

export function manifestToYaml(m: BotManifest): string {
  return yamlDump(m, { lineWidth: 100, noRefs: true })
}

/** Derive the portable manifest for a stored bot. Secrets are never included. */
export function manifestFromBot(bot: BotRecord, envSpecs: { name: string; description?: string; required?: boolean; secret?: boolean }[]): BotManifest {
  return manifestSchema.parse({
    apiVersion: 'botstr.dev/v1',
    kind: 'Bot',
    metadata: { name: bot.name, version: bot.version, description: bot.description },
    template: bot.template,
    runtime: { type: bot.runtime },
    identity: { mode: 'generate' },
    permissions: {
      receive_messages: bot.permissions.receiveMessages,
      send_messages: bot.permissions.sendMessages,
      public_mentions: bot.permissions.publicMentions,
      publish_public: bot.permissions.publishPublic,
      reactions: bot.permissions.reactions,
      files: bot.permissions.files,
      moderation: bot.permissions.moderation,
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
