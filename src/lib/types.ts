/** Botstr core types — shared by the dashboard, the browser runtime and the Cloudflare runtime. */

/** WHAT runs the bot (protocol engine). */
export type RuntimeType = 'nostr' | 'vector' | 'concord'
/** WHERE the bot runs (deployment provider). */
export type ExecutorType = 'browser' | 'cloudflare' | 'runner'

export type BotStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'crashed'
  | 'updating'

/** Capability permissions — the manifest is the authority. */
export interface BotPermissions {
  /** messaging.dm — receive and answer encrypted DMs */
  receiveMessages: boolean
  sendMessages: boolean
  /** messaging.public — watch and answer public mentions */
  publicMentions: boolean
  /** nostr.publish — post public kind-1 notes */
  publishPublic: boolean
  /** nostr.reactions (vector runtime) */
  reactions: boolean
  /** storage.files — object storage */
  files: boolean
  /** moderation.ban */
  moderation: boolean
  /** network.outbound_http — guarded fetch */
  outboundHttp: boolean
}

export type GatewayMode = 'private' | 'gateway' | 'public'

/** Logical resource quotas — enforced by Botstr, independent of provider limits. */
export interface BotResources {
  storageMB: number
  maxEventsPerMinute: number
  maxRelays: number
}

export const DEFAULT_RESOURCES: BotResources = {
  storageMB: 25,
  maxEventsPerMinute: 30,
  maxRelays: 12,
}

export interface EnvVarSpec {
  name: string
  description?: string
  required?: boolean
  secret?: boolean
  default?: string
}

/** A deployed bot node. Private key material is NEVER stored here — see vault.ts. */
export interface BotRecord {
  id: string
  name: string
  description?: string
  template: string
  runtime: RuntimeType
  executor: ExecutorType
  version: string
  /** bot identity, hex pubkey. The secret key lives in the encrypted vault. */
  pubkey: string
  relays: string[]
  triggers: string[]
  permissions: BotPermissions
  /** inbound relay gateway mode (cloudflare executor) */
  gateway: GatewayMode
  resources: BotResources
  /** non-secret environment values only */
  env: Record<string, string>
  /** names of secret env vars; their values live in the vault */
  secretNames: string[]
  /** template-specific configuration */
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface LogEntry {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
}

export interface BotEventEntry {
  ts: number
  type: 'message' | 'mention' | 'connection' | 'error' | 'lifecycle' | 'schedule' | 'publish'
  summary: string
}

export interface BotLiveState {
  status: BotStatus
  startedAt?: number
  detail?: string
  /** cloud executor reports node storage */
  storageUsedBytes?: number
  storageQuotaMB?: number
  /** inbound relay URL when the gateway is enabled */
  relayUrl?: string
}

export interface Capabilities {
  messaging: boolean
  directMessages: boolean
  publicMentions: boolean
  publishing: boolean
  communities: boolean
  reactions: boolean
  files: boolean
  moderation: boolean
  tor: boolean
  scheduling: boolean
  alwaysOn: boolean
  /** inbound per-node relay gateway */
  gateway: boolean
}

export interface RuntimeDescriptor {
  runtime: RuntimeType
  executor: ExecutorType
  label: string
  available: boolean
  reason?: string
  capabilities: Capabilities
}

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
]

export function shortKey(hex: string): string {
  return hex.slice(0, 8) + '…' + hex.slice(-4)
}

export function formatUptime(startedAt: number, now: number): string {
  let s = Math.max(0, Math.floor((now - startedAt) / 1000))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

export function uid(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
