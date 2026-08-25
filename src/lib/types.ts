/** Botstr core types — shared by the dashboard, the browser runtime and the Cloudflare runtime. */

export type RuntimeType = 'nostr' | 'vector' | 'concord'
export type ExecutorType = 'browser' | 'cloudflare' | 'runner'

export type BotStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'crashed'
  | 'updating'

export interface BotPermissions {
  receiveMessages: boolean
  sendMessages: boolean
  publicMentions: boolean
  publishPublic: boolean
  reactions: boolean
  files: boolean
  moderation: boolean
}

export interface EnvVarSpec {
  name: string
  description?: string
  required?: boolean
  secret?: boolean
  default?: string
}

/** A deployed bot. Private key material is NEVER stored here — see vault.ts. */
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

export function uid(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
