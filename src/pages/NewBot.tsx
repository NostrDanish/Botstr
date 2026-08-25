import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'
import { manager } from '../lib/runtime'
import { getTemplate, TEMPLATES, TEMPLATE_CATEGORIES, type FieldSpec, type TemplateDef } from '../lib/templates'
import { manifestFromBot, manifestToYaml } from '../lib/manifest'
import type { Identity } from '../lib/identity'
import { DEFAULT_RELAYS, uid, type BotPermissions, type BotRecord, type ExecutorType, type RuntimeType } from '../lib/types'
import { Btn, Card, Field, Input, Select, Textarea, Toggle, cn } from '../components/ui'

const STEPS = ['Template', 'Name', 'Identity', 'Runtime', 'Relays', 'Permissions', 'Environment', 'Review']

interface Draft {
  template?: TemplateDef
  name: string
  description: string
  identityMode: 'generate' | 'import'
  identity: Identity | null
  executor: ExecutorType
  relays: string[]
  permissions: BotPermissions
  env: Record<string, string>
  secrets: Record<string, string>
  config: Record<string, unknown>
}

const ALL_PERMISSIONS: { key: keyof BotPermissions; label: string; help: string; vectorOnly?: boolean }[] = [
  { key: 'receiveMessages', label: 'Receive messages', help: 'Listen for encrypted DMs (NIP-17)' },
  { key: 'sendMessages', label: 'Send messages', help: 'Reply and send encrypted DMs' },
  { key: 'publicMentions', label: 'Public mentions', help: 'Watch for and answer public mentions' },
  { key: 'publishPublic', label: 'Publish publicly', help: 'Post public notes (needed for RSS/price broadcasts)' },
  { key: 'reactions', label: 'Reactions', help: 'Requires the Vector runtime', vectorOnly: true },
  { key: 'files', label: 'Files', help: 'Requires the Vector runtime', vectorOnly: true },
  { key: 'moderation', label: 'Moderation', help: 'Community kicks/bans require the Vector runtime; word-filtering works on Nostr', vectorOnly: false },
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
    relays: [...DEFAULT_RELAYS.slice(0, 2)],
    permissions: { receiveMessages: true, sendMessages: true, publicMentions: false, publishPublic: false, reactions: false, files: false, moderation: false },
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
      <h1 className="mb-1 text-2xl font-bold">Deploy a bot</h1>
      <p className="mb-6 text-sm text-muted">Eight short steps. No Rust, no servers, no protocol knowledge required.</p>

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

        {/* ------------------------------------------------ runtime */}
        {step === 3 && (
          <div className="space-y-3">
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
          </div>
        )}

        {/* ------------------------------------------------ relays */}
        {step === 4 && (
          <div>
            <p className="mb-4 text-sm text-muted">Relays carry your bot's encrypted traffic. Pick at least one.</p>
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

        {/* ------------------------------------------------ permissions */}
        {step === 5 && (
          <div className="space-y-4">
            {ALL_PERMISSIONS.map((p) => {
              const vectorRuntimeSelected = draft.executor === 'runner'
              const disabled = p.vectorOnly && !vectorRuntimeSelected
              return (
                <div key={p.key} className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="text-xs text-muted">{p.help}</div>
                  </div>
                  <Toggle
                    checked={draft.permissions[p.key] && !disabled}
                    disabled={disabled}
                    onChange={(v) => patch({ permissions: { ...draft.permissions, [p.key]: v } })}
                  />
                </div>
              )
            })}
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
                <div className="text-xs uppercase tracking-wide text-muted">Bot</div>
                <div className="mt-1 font-semibold">{draft.name}</div>
                <div className="text-xs text-muted">{template.name}</div>
              </div>
              <div className="rounded-lg border border-border bg-bg p-3">
                <div className="text-xs uppercase tracking-wide text-muted">Identity</div>
                <div className="mt-1 break-all font-mono text-xs text-accent">{draft.identity?.npub}</div>
              </div>
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
