import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'
import { manager } from '../lib/runtime'
import { getTemplate, TEMPLATES, TEMPLATE_CATEGORIES, type FieldSpec, type TemplateDef } from '../lib/templates'
import { capabilityReview, manifestFromBot, manifestToYaml } from '../lib/manifest'
import type { Identity } from '../lib/identity'
import {
  DEFAULT_RELAYS,
  DEFAULT_RESOURCES,
  uid,
  type BotPermissions,
  type BotRecord,
  type BotResources,
  type ExecutorType,
  type GatewayMode,
  type RuntimeType,
} from '../lib/types'
import { Btn, Card, Field, Input, Select, Textarea, Toggle, cn } from '../components/ui'

const STEPS = ['Template', 'Name', 'Identity', 'Provider', 'Relays', 'Capabilities', 'Environment', 'Review']

interface Draft {
  template?: TemplateDef
  name: string
  description: string
  identityMode: 'generate' | 'import'
  identity: Identity | null
  executor: ExecutorType
  gateway: GatewayMode
  relays: string[]
  permissions: BotPermissions
  resources: BotResources
  env: Record<string, string>
  secrets: Record<string, string>
  config: Record<string, unknown>
}

interface CapDef {
  keys: (keyof BotPermissions)[]
  name: string
  label: string
  help: string
  unavailable?: string
}
const CAP_GROUPS: { group: string; caps: CapDef[] }[] = [
  {
    group: 'Messaging',
    caps: [
      { keys: ['receiveMessages', 'sendMessages'], name: 'messaging.dm', label: 'Encrypted DMs', help: 'Receive and answer NIP-17 direct messages' },
      { keys: ['publicMentions'], name: 'messaging.public', label: 'Public mentions', help: 'Watch for and answer public mentions' },
      { keys: ['reactions'], name: 'messaging.reactions', label: 'Reactions', help: 'Requires the Vector runtime', unavailable: 'Vector runtime' },
    ],
  },
  {
    group: 'Nostr',
    caps: [{ keys: ['publishPublic'], name: 'nostr.publish', label: 'Publish public notes', help: 'Post kind-1 notes (RSS, price broadcasts)' }],
  },
  {
    group: 'Storage',
    caps: [{ keys: ['files'], name: 'storage.files', label: 'File storage', help: 'Object storage inside the node, quota-enforced' }],
  },
  {
    group: 'Network',
    caps: [{ keys: ['outboundHttp'], name: 'network.outbound_http', label: 'Outbound HTTP', help: 'Call external APIs (AI endpoints, feeds, price oracles)' }],
  },
  {
    group: 'Moderation',
    caps: [{ keys: ['moderation'], name: 'moderation.enabled', label: 'Moderation', help: 'Word filters work on Nostr; kicks/bans need the Vector runtime' }],
  },
  {
    group: 'Wallet',
    caps: [{ keys: [], name: 'wallet.zap', label: 'Zaps / wallet', help: 'Not implemented on any runtime yet', unavailable: 'not implemented yet' }],
  },
]

const GATEWAY_MODES: { id: GatewayMode; label: string; help: string }[] = [
  { id: 'private', label: 'Private', help: 'The node only dials out to relays. Its relay endpoint stays closed.' },
  { id: 'gateway', label: 'Gateway', help: 'The node gets its own relay URL. Clients can read the node’s events and send events addressed to the bot.' },
  { id: 'public', label: 'Public', help: 'The node’s relay accepts events from anyone (rate-limited). For bots that publish a public feed.' },
]

async function testRelay(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean, ws?: WebSocket) => {
      if (settled) return
      settled = true
      try {
        ws?.close()
      } catch {
        /* noop */
      }
      resolve(ok)
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      return resolve(false)
    }
    const t = setTimeout(() => finish(false, ws), 4000)
    ws.onopen = () => {
      clearTimeout(t)
      finish(true, ws)
    }
    ws.onerror = () => {
      clearTimeout(t)
      finish(false, ws)
    }
  })
}

function FieldInput({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec
  value: unknown
  onChange: (v: unknown) => void
}) {
  switch (spec.type) {
    case 'number':
      return <Input type="number" value={String(value ?? spec.default ?? '')} onChange={(e) => onChange(Number(e.target.value))} placeholder={spec.placeholder} />
    case 'textarea':
      return <Textarea value={String(value ?? spec.default ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder} />
    case 'select':
      return (
        <Select value={String(value ?? spec.default ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      )
    case 'checkbox':
      return <Toggle checked={Boolean(value ?? spec.default ?? false)} onChange={onChange} />
    case 'list':
      return (
        <Textarea
          value={Array.isArray(value) ? value.join('\n') : ((spec.default as string[]) ?? []).join('\n')}
          onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
          placeholder="one per line"
        />
      )
    default:
      return <Input type={spec.type === 'password' ? 'password' : 'text'} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder} />
  }
}

export default function NewBot() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Draft>({
    name: '',
    description: '',
    identityMode: 'generate',
    identity: null,
    executor: 'browser',
    gateway: 'private',
    relays: [...DEFAULT_RELAYS.slice(0, 2)],
    permissions: { receiveMessages: true, sendMessages: true, publicMentions: false, publishPublic: false, reactions: false, files: false, moderation: false, outboundHttp: false },
    resources: { ...DEFAULT_RESOURCES },
    env: {},
    secrets: {},
    config: {},
  })
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [relayInput, setRelayInput] = useState('')
  const [relayTests, setRelayTests] = useState<Record<string, 'testing' | 'ok' | 'fail'>>({})
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState('')

  const runtimes = manager.runtimes()
  const template = draft.template

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }))

  const selectTemplate = (t: TemplateDef) => {
    const config: Record<string, unknown> = {}
    for (const f of t.fields) if (f.default !== undefined) config[f.key] = f.default
    const env: Record<string, string> = {}
    for (const e of t.env) if (!e.secret && e.default) env[e.name] = e.default
    setDraft((d) => ({
      ...d,
      template: t,
      permissions: { ...d.permissions, ...t.defaults.permissions },
      relays: [...t.defaults.relays.slice(0, 2)],
      config,
      env,
      secrets: {},
    }))
  }

  const ensureIdentity = () => {
    if (draft.identityMode === 'generate' && !draft.identity) {
      patch({ identity: manager.newIdentity() })
    }
  }

  const stepValid = useMemo(() => {
    switch (step) {
      case 0:
        return !!template
      case 1:
        return /^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.name)
      case 2:
        return !!draft.identity
      case 3:
        return true
      case 4:
        return draft.relays.length > 0
      case 5:
        return true
      case 6:
        if (!template) return false
        for (const e of template.env) {
          if (e.required) {
            const v = e.secret ? draft.secrets[e.name] : (draft.env[e.name] ?? e.default)
            if (!v) return false
          }
        }
        for (const f of template.fields) {
          if (f.required) {
            const v = draft.config[f.key] ?? f.default
            if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return false
          }
        }
        return true
      default:
        return true
    }
  }, [step, template, draft])

  const goNext = () => {
    if (step === 1 && !draft.identity && draft.identityMode === 'generate') ensureIdentity()
    if (step + 1 === 2) setTimeout(ensureIdentity, 0)
    setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }

  const deploy = async () => {
    if (!template || !draft.identity) return
    setDeploying(true)
    setDeployError('')
    try {
      const triggers = template.defaults.triggers.filter((t) => t !== 'mention' || draft.permissions.publicMentions)
      const record: Omit<BotRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        name: draft.name,
        description: draft.description || template.tagline,
        template: template.id,
        runtime: template.runtimeSupport[0] as RuntimeType,
        executor: draft.executor,
        gateway: draft.executor === 'cloudflare' ? draft.gateway : 'private',
        resources: draft.resources,
        version: '1.0.0',
        pubkey: draft.identity.pubkey,
        relays: draft.relays,
        triggers,
        permissions: draft.permissions,
        env: draft.env,
        secretNames: Object.keys(draft.secrets),
        config: draft.config,
      }
      const bot = await manager.createBot(record, draft.identity, draft.secrets)
      void manager.start(bot.id).catch(() => {})
      nav(`/bot/${bot.id}`)
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : String(e))
      setDeploying(false)
    }
  }

  const manifestPreview = useMemo(() => {
    if (!template || !draft.identity) return ''
    const fake: BotRecord = {
      id: uid(),
      name: draft.name || 'my-bot',
      description: draft.description || template.tagline,
      template: template.id,
      runtime: 'nostr',
      executor: draft.executor,
      gateway: draft.executor === 'cloudflare' ? draft.gateway : 'private',
      resources: draft.resources,
      version: '1.0.0',
      pubkey: draft.identity.pubkey,
      relays: draft.relays,
      triggers: template.defaults.triggers,
      permissions: draft.permissions,
      env: draft.env,
      secretNames: Object.keys(draft.secrets),
      config: draft.config,
      createdAt: 0,
      updatedAt: 0,
    }
    return manifestToYaml(manifestFromBot(fake, template.env))
  }, [template, draft])

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Deploy a Bot Node</h1>
      <p className="mb-6 text-sm text-muted">
        Every node gets its own identity, runtime, database, storage quota, secrets and logs. No Rust, no servers, no
        protocol knowledge required.
      </p>

      {/* stepper */}
      <div className="mb-8 flex flex-wrap gap-1">
        {STEPS.map((s, i) => (
          <button
            key={s}
            onClick={() => i < step && setStep(i)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              i === step
                ? 'border-accent bg-accent/10 text-accent'
                : i < step
                  ? 'border-border2 text-text hover:border-accent/50'
                  : 'border-border text-muted/60',
            )}
          >
            {i + 1}. {s}
          </button>
        ))}
      </div>

      <Card className="p-6">
        {/* ------------------------------------------------ template */}
        {step === 0 && (
          <div>
            {TEMPLATE_CATEGORIES.map((cat) => {
              const items = TEMPLATES.filter((t) => t.category === cat)
              if (items.length === 0) return null
              return (
                <div key={cat} className="mb-6 last:mb-0">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{cat}</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {items.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => selectTemplate(t)}
                        className={cn(
                          'rounded-xl border p-4 text-left transition-colors',
                          template?.id === t.id ? 'border-accent bg-accent/5' : 'border-border bg-panel2 hover:border-border2',
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{t.name}</span>
                          {template?.id === t.id && <Check size={16} className="text-accent" />}
                        </div>
                        <p className="mt-1 text-xs text-muted">{t.tagline}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ------------------------------------------------ name */}
        {step === 1 && (
          <div className="space-y-5">
            <Field label="Bot name" help="Lowercase letters, digits and dashes. This becomes the bot's manifest name.">
              <Input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                placeholder="my-first-bot"
              />
            </Field>
            <Field label="Description (optional)">
              <Textarea value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder={template?.description} />
            </Field>
          </div>
        )}

        {/* ------------------------------------------------ identity */}
        {step === 2 && (
          <div>
            <p className="mb-4 text-sm text-muted">
              Every bot gets its <strong className="text-text">own identity</strong> — your personal Nostr key is never
              used. The secret key is encrypted and stored in this device's vault; it never touches logs or the network.
            </p>
            <div className="mb-5 grid gap-3 sm:grid-cols-2">
              {(['generate', 'import'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    patch({ identityMode: mode, identity: mode === 'generate' ? manager.newIdentity() : null })
                    setImportError('')
                  }}
                  className={cn(
                    'rounded-xl border p-4 text-left',
                    draft.identityMode === mode ? 'border-accent bg-accent/5' : 'border-border bg-panel2 hover:border-border2',
                  )}
                >
                  <div className="font-semibold capitalize">{mode === 'generate' ? 'Generate new identity' : 'Import existing identity'}</div>
                  <p className="mt-1 text-xs text-muted">
                    {mode === 'generate' ? 'A fresh keypair, sealed in the vault.' : 'Bring an nsec from another bot or tool.'}
                  </p>
                </button>
              ))}
            </div>

            {draft.identityMode === 'generate' && draft.identity && (
              <div className="rounded-lg border border-border bg-bg p-4">
                <div className="mb-1 text-xs uppercase tracking-wide text-muted">Bot public key</div>
                <div className="break-all font-mono text-sm text-accent">{draft.identity.npub}</div>
                <div className="mt-3">
                  <Btn size="sm" onClick={() => patch({ identity: manager.newIdentity() })}>
                    <RefreshCw size={13} /> Regenerate
                  </Btn>
                </div>
                <p className="mt-3 text-xs text-muted">
                  The nsec is sealed in the vault. You can reveal or export it later from the bot's page.
                </p>
              </div>
            )}

            {draft.identityMode === 'import' && (
              <Field label="nsec or hex secret key" help="Validated locally, encrypted at rest, never transmitted anywhere except to your own runtime.">
                <Textarea
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value)
                    if (!e.target.value.trim()) {
                      patch({ identity: null })
                      setImportError('')
                      return
                    }
                    try {
                      patch({ identity: manager.importIdentity(e.target.value) })
                      setImportError('')
                    } catch (err) {
                      patch({ identity: null })
                      setImportError(err instanceof Error ? err.message : 'invalid key')
                    }
                  }}
                  placeholder="nsec1…"
                />
              </Field>
            )}
            {importError && <p className="mt-2 text-xs text-danger">{importError}</p>}
            {draft.identityMode === 'import' && draft.identity && (
              <p className="mt-3 break-all font-mono text-xs text-accent">{draft.identity.npub}</p>
            )}
          </div>
        )}

        {/* ------------------------------------------------ provider */}
        {step === 3 && (
          <div className="space-y-3">
            <p className="mb-1 text-sm text-muted">
              <strong className="text-text">Where</strong> should the node run? (The runtime — what protocol it speaks —
              stays portable.)
            </p>
            {runtimes.map((r) => (
              <button
                key={`${r.runtime}-${r.executor}`}
                disabled={!r.available}
                onClick={() => patch({ executor: r.executor })}
                className={cn(
                  'block w-full rounded-xl border p-4 text-left',
                  !r.available && 'cursor-not-allowed opacity-50',
                  draft.executor === r.executor && r.available ? 'border-accent bg-accent/5' : 'border-border bg-panel2 hover:border-border2',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{r.label}</span>
                  {draft.executor === r.executor && r.available && <Check size={16} className="text-accent" />}
                </div>
                <p className="mt-1 text-xs text-muted">{r.reason}</p>
                <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-muted/70">
                  {Object.entries(r.capabilities)
                    .filter(([, v]) => v)
                    .map(([k]) => k.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`))
                    .join(' · ')}
                </p>
              </button>
            ))}

            {draft.executor === 'cloudflare' && (
              <div className="mt-5 border-t border-border pt-5">
                <h3 className="mb-1 text-sm font-semibold">Node gateway</h3>
                <p className="mb-3 text-xs text-muted">
                  Should this node expose its own relay endpoint (wss://…/nodes/&lt;id&gt;/relay)?
                </p>
                <div className="space-y-2">
                  {GATEWAY_MODES.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => patch({ gateway: g.id })}
                      className={cn(
                        'block w-full rounded-xl border p-3 text-left',
                        draft.gateway === g.id ? 'border-accent bg-accent/5' : 'border-border bg-panel2 hover:border-border2',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{g.label}</span>
                        {draft.gateway === g.id && <Check size={15} className="text-accent" />}
                      </div>
                      <p className="mt-0.5 text-xs text-muted">{g.help}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------ relays */}
        {step === 4 && (
          <div>
            <p className="mb-4 text-sm text-muted">Relays carry your bot's encrypted traffic. Pick at least one.</p>
            {draft.executor === 'cloudflare' && (
              <p className="mb-4 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
                Cloudflare executor: keep it to 6 relays or fewer — the platform caps outgoing connections at 6 per
                invocation.
              </p>
            )}
            <div className="space-y-2">
              {draft.relays.map((url) => (
                <div key={url} className="flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
                  {relayTests[url] === 'testing' && <span className="text-xs text-warn">testing…</span>}
                  {relayTests[url] === 'ok' && <span className="text-xs text-accent">reachable</span>}
                  {relayTests[url] === 'fail' && <span className="text-xs text-danger">unreachable</span>}
                  <Btn
                    size="sm"
                    onClick={async () => {
                      setRelayTests((t) => ({ ...t, [url]: 'testing' }))
                      const ok = await testRelay(url)
                      setRelayTests((t) => ({ ...t, [url]: ok ? 'ok' : 'fail' }))
                    }}
                  >
                    Test
                  </Btn>
                  <button className="text-muted hover:text-danger" onClick={() => patch({ relays: draft.relays.filter((r) => r !== url) })}>
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Input value={relayInput} onChange={(e) => setRelayInput(e.target.value)} placeholder="wss://your-relay.example.com" />
              <Btn
                onClick={() => {
                  const url = relayInput.trim()
                  if (!url.startsWith('wss://') || draft.relays.includes(url)) return
                  patch({ relays: [...draft.relays, url] })
                  setRelayInput('')
                }}
              >
                Add
              </Btn>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {DEFAULT_RELAYS.filter((r) => !draft.relays.includes(r)).map((r) => (
                <button
                  key={r}
                  onClick={() => patch({ relays: [...draft.relays, r] })}
                  className="rounded-full border border-border px-2.5 py-1 font-mono text-[10px] text-muted hover:border-border2 hover:text-text"
                >
                  + {r.replace('wss://', '')}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------------ capabilities */}
        {step === 5 && (
          <div className="space-y-5">
            <p className="text-sm text-muted">
              Capabilities the node requests. They land in its <span className="font-mono text-xs">bot.yaml</span> and are
              enforced by the runtime — a bot cannot exceed them.
            </p>
            {CAP_GROUPS.map((g) => (
              <div key={g.group}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{g.group}</h3>
                <div className="space-y-3">
                  {g.caps.map((c) => {
                    const disabled = !!c.unavailable
                    const checked = c.keys.length > 0 && c.keys.every((k) => draft.permissions[k]) && !disabled
                    return (
                      <div key={c.name} className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium">
                            {c.label}{' '}
                            <span className="ml-1 rounded bg-panel2 px-1.5 py-0.5 font-mono text-[10px] text-muted">{c.name}</span>
                          </div>
                          <div className="text-xs text-muted">
                            {c.help}
                            {disabled && <span className="text-warn"> — {c.unavailable}</span>}
                          </div>
                        </div>
                        <Toggle
                          checked={checked}
                          disabled={disabled}
                          onChange={(v) => {
                            const next = { ...draft.permissions }
                            for (const k of c.keys) next[k] = v
                            patch({ permissions: next })
                          }}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ------------------------------------------------ environment */}
        {step === 6 && template && (
          <div className="space-y-5">
            {template.env.length === 0 && template.fields.length === 0 && (
              <p className="text-sm text-muted">This template needs no configuration. Onward.</p>
            )}
            {template.env.map((e) => (
              <Field key={e.name} label={`${e.name}${e.required ? ' *' : ''}`} help={e.description + (e.secret ? ' · stored encrypted, never shown again' : '')}>
                {e.secret ? (
                  <Input
                    type="password"
                    value={draft.secrets[e.name] ?? ''}
                    onChange={(ev) => patch({ secrets: { ...draft.secrets, [e.name]: ev.target.value } })}
                    placeholder={e.default ? `default: ${e.default}` : ''}
                    autoComplete="off"
                  />
                ) : (
                  <Input
                    value={draft.env[e.name] ?? ''}
                    onChange={(ev) => patch({ env: { ...draft.env, [e.name]: ev.target.value } })}
                    placeholder={e.default ? `default: ${e.default}` : ''}
                  />
                )}
              </Field>
            ))}
            {template.fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} help={f.help}>
                <FieldInput spec={f} value={draft.config[f.key]} onChange={(v) => patch({ config: { ...draft.config, [f.key]: v } })} />
              </Field>
            ))}
          </div>
        )}

        {/* ------------------------------------------------ review */}
        {step === 7 && template && (
          <div>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-bg p-3">
                <div className="text-xs uppercase tracking-wide text-muted">Node</div>
                <div className="mt-1 font-semibold">{draft.name}</div>
                <div className="text-xs text-muted">
                  {template.name} · {draft.executor}
                  {draft.executor === 'cloudflare' && draft.gateway !== 'private' && ` · gateway: ${draft.gateway}`}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-bg p-3">
                <div className="text-xs uppercase tracking-wide text-muted">Identity</div>
                <div className="mt-1 break-all font-mono text-xs text-accent">{draft.identity?.npub}</div>
              </div>
            </div>

            <div className="mb-4 rounded-lg border border-border bg-bg p-3">
              <div className="mb-2 text-xs uppercase tracking-wide text-muted">This node requests</div>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {capabilityReview(draft.permissions).map((c) => (
                  <div key={c.label} className="flex items-center gap-2 text-xs">
                    {c.granted ? <Check size={13} className="shrink-0 text-accent" /> : <X size={13} className="shrink-0 text-muted/50" />}
                    <span className={c.granted ? 'text-text' : 'text-muted/60'}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="Storage quota (MB)" help="Logical quota enforced by Botstr — set against your plan's real limits.">
                <Input
                  type="number"
                  min={1}
                  value={String(draft.resources.storageMB)}
                  onChange={(e) => patch({ resources: { ...draft.resources, storageMB: Math.max(1, Number(e.target.value) || 1) } })}
                />
              </Field>
              <Field label="Max publishes / minute" help="Sliding-window rate limit. Anti-abuse, enforced by the core.">
                <Input
                  type="number"
                  min={1}
                  value={String(draft.resources.maxEventsPerMinute)}
                  onChange={(e) =>
                    patch({ resources: { ...draft.resources, maxEventsPerMinute: Math.max(1, Number(e.target.value) || 1) } })
                  }
                />
              </Field>
            </div>
            <div className="text-xs uppercase tracking-wide text-muted">bot.yaml</div>
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-bg p-4 font-mono text-xs leading-5 text-text/80">
              {manifestPreview}
            </pre>
            <p className="mt-2 text-xs text-muted">
              This manifest is your bot's portable definition. Secrets are deliberately absent — they live in the vault.
            </p>
            {deployError && <p className="mt-3 text-sm text-danger">{deployError}</p>}
          </div>
        )}

        {/* ------------------------------------------------ nav */}
        <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
          <Btn onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || deploying}>
            <ChevronLeft size={15} /> Back
          </Btn>
          {step < STEPS.length - 1 ? (
            <Btn variant="primary" onClick={goNext} disabled={!stepValid}>
              Next <ChevronRight size={15} />
            </Btn>
          ) : (
            <Btn variant="primary" onClick={() => void deploy()} disabled={deploying}>
              {deploying ? 'Deploying…' : 'Deploy'}
            </Btn>
          )}
        </div>
      </Card>
    </div>
  )
}
