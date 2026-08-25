import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { ChevronLeft, Download, Eye, EyeOff, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { manager, runtimeLabel } from '../lib/runtime'
import { openSecret } from '../lib/vault'
import { useBot, useNow } from '../lib/hooks'
import { getTemplate } from '../lib/templates'
import { manifestFromBot, manifestToYaml } from '../lib/manifest'
import { formatUptime, type BotEventEntry } from '../lib/types'
import { Btn, Card, CopyBtn, Field, Input, StatusPill, cn } from '../components/ui'
import { LogView } from '../components/LogView'

type Tab = 'logs' | 'events' | 'config' | 'env'

export default function BotDetail() {
  const { id } = useParams<{ id: string }>()
  const bot = useBot(id)
  const nav = useNavigate()
  const now = useNow()
  const [tab, setTab] = useState<Tab>('logs')
  const [events, setEvents] = useState<BotEventEntry[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [confirmReveal, setConfirmReveal] = useState(false)
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({})

  const template = bot ? getTemplate(bot.template) : undefined

  useEffect(() => {
    if (!id) return
    let alive = true
    const load = () => manager.events(id).then((e) => alive && setEvents([...e].reverse()))
    void load()
    const t = setInterval(load, 3000)
    const livePoll = setInterval(() => void manager.refreshLive(id), 5000)
    return () => {
      alive = false
      clearInterval(t)
      clearInterval(livePoll)
    }
  }, [id])

  const yaml = useMemo(() => {
    if (!bot || !template) return ''
    return manifestToYaml(manifestFromBot(bot, template.env))
  }, [bot, template])

  if (!bot) {
    return (
      <div className="py-24 text-center text-muted">
        <p>Bot not found.</p>
        <Link to="/" className="mt-2 inline-block text-accent hover:underline">
          Back to My Bots
        </Link>
      </div>
    )
  }

  const running = bot.live.status === 'running' || bot.live.status === 'starting'

  const downloadManifest = () => {
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'bot.yaml'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div>
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ChevronLeft size={15} /> My Bots
      </Link>

      <Card className="mb-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="truncate text-xl font-bold">{bot.name}</h1>
              <StatusPill status={bot.live.status} />
            </div>
            <p className="mt-1 text-sm text-muted">{bot.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span>
                {template?.name ?? bot.template} · {runtimeLabel(bot.runtime, bot.executor)} · v{bot.version}
              </span>
              {running && bot.live.startedAt && <span className="text-accent">{formatUptime(bot.live.startedAt, now)} uptime</span>}
            </div>
            <div className="mt-2 flex items-center gap-2 font-mono text-xs text-muted">
              <span className="truncate">{bot.pubkey}</span>
              <CopyBtn text={bot.pubkey} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <Btn onClick={() => void manager.stop(bot.id)}>
                <Square size={14} /> Stop
              </Btn>
            ) : (
              <Btn variant="primary" onClick={() => void manager.start(bot.id).catch((e) => alert(String(e)))}>
                <Play size={14} /> Start
              </Btn>
            )}
            <Btn onClick={() => void manager.restart(bot.id).catch((e) => alert(String(e)))}>
              <RotateCw size={14} /> Restart
            </Btn>
            {!confirmReveal ? (
              <Btn onClick={() => setConfirmReveal(true)}>
                <Eye size={14} /> Reveal nsec
              </Btn>
            ) : (
              <Btn
                variant="danger"
                onClick={() => {
                  void manager.revealNsec(bot.id).then((nsec) => setRevealed(nsec ?? ''))
                  setConfirmReveal(false)
                }}
              >
                Confirm reveal
              </Btn>
            )}
            {!confirmDelete ? (
              <Btn variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} /> Delete
              </Btn>
            ) : (
              <>
                <Btn
                  variant="danger"
                  onClick={() => {
                    void manager.remove(bot.id).then(() => nav('/'))
                  }}
                >
                  Really delete
                </Btn>
                <Btn onClick={() => setConfirmDelete(false)}>Cancel</Btn>
              </>
            )}
          </div>
        </div>

        {revealed !== null && (
          <div className="mt-4 rounded-lg border border-warn/30 bg-warn/5 p-3">
            {revealed === '' ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">
                  This bot's key is sealed inside its cloud runtime — it was never stored in this browser.
                </span>
                <button onClick={() => setRevealed(null)} className="text-muted hover:text-text">
                  <EyeOff size={14} />
                </button>
              </div>
            ) : (
              <>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-warn">Secret key — anyone holding this controls the bot</span>
                  <div className="flex items-center gap-2">
                    <CopyBtn text={revealed} label="copy" />
                    <button onClick={() => setRevealed(null)} className="text-muted hover:text-text">
                      <EyeOff size={14} />
                    </button>
                  </div>
                </div>
                <div className="break-all font-mono text-xs">{revealed}</div>
              </>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-1.5">
          {bot.relays.map((r) => (
            <span key={r} className="rounded-full border border-border bg-bg px-2.5 py-1 font-mono text-[10px] text-muted">
              {r.replace('wss://', '')}
            </span>
          ))}
        </div>
      </Card>

      {/* the Bot Node — every bot is its own little piece of infrastructure */}
      <Card className="mb-6 p-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
          <div>
            <div className="text-muted">🪪 Identity</div>
            <div className="mt-0.5 font-mono">{nip19.npubEncode(bot.pubkey).slice(0, 16)}…</div>
          </div>
          <div>
            <div className="text-muted">⚙️ Runtime</div>
            <div className="mt-0.5">{bot.executor === 'browser' ? 'Web Worker (this tab)' : bot.executor === 'cloudflare' ? 'Durable Object' : 'runner'}</div>
          </div>
          <div>
            <div className="text-muted">📡 Gateway</div>
            <div className="mt-0.5">{bot.relays.length} relay{bot.relays.length === 1 ? '' : 's'}</div>
          </div>
          <div>
            <div className="text-muted">🗄️ Database</div>
            <div className="mt-0.5">{bot.executor === 'browser' ? 'IndexedDB, this device' : 'Node SQLite (DO)'}</div>
          </div>
          <div>
            <div className="text-muted">📦 Storage</div>
            <div className="mt-0.5">
              {bot.executor === 'browser'
                ? 'browser runtime only'
                : bot.live.storageQuotaMB !== undefined
                  ? `${(Number(bot.live.storageUsedBytes ?? 0) / 1048576).toFixed(1)} / ${bot.live.storageQuotaMB} MB`
                  : 'not running'}
            </div>
          </div>
          <div>
            <div className="text-muted">🔐 Secrets</div>
            <div className="mt-0.5">sealed · AES-256-GCM</div>
          </div>
          <div>
            <div className="text-muted">📊 Monitoring</div>
            <div className="mt-0.5">
              {running && bot.live.startedAt ? `up ${formatUptime(bot.live.startedAt, now)}` : bot.live.status}
            </div>
          </div>
          <div>
            <div className="text-muted">📝 Logs</div>
            <div className="mt-0.5">live stream below</div>
          </div>
        </div>
      </Card>

      <div className="mb-4 flex gap-1 border-b border-border">
        {(['logs', 'events', 'config', 'env'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'border-b-2 px-4 py-2 text-sm capitalize',
              tab === t ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text',
            )}
          >
            {t === 'env' ? 'Environment' : t}
          </button>
        ))}
      </div>

      {tab === 'logs' && <LogView botId={bot.id} />}

      {tab === 'events' && (
        <div className="space-y-1.5">
          {events.length === 0 && <p className="text-sm text-muted">No events yet.</p>}
          {events.map((e, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2 text-xs">
              <span className="shrink-0 font-mono text-muted/60">{new Date(e.ts).toLocaleTimeString()}</span>
              <span
                className={cn(
                  'w-20 shrink-0 rounded px-1.5 py-0.5 text-center font-medium',
                  e.type === 'error' ? 'bg-danger/15 text-danger' : e.type === 'message' || e.type === 'mention' ? 'bg-accent/15 text-accent' : 'bg-panel2 text-muted',
                )}
              >
                {e.type}
              </span>
              <span className="text-text/90">{e.summary}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'config' && (
        <div>
          <div className="mb-3 flex justify-end">
            <Btn size="sm" onClick={downloadManifest}>
              <Download size={13} /> Export bot.yaml
            </Btn>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-bg p-4 font-mono text-xs leading-5 text-text/80">
            {yaml}
          </pre>
        </div>
      )}

      {tab === 'env' && template && (
        <div className="max-w-xl space-y-5">
          {template.env.length === 0 && <p className="text-sm text-muted">This template declares no environment variables.</p>}
          {template.env.map((e) => (
            <Field
              key={e.name}
              label={`${e.name}${e.secret ? ' (secret)' : ''}`}
              help={e.description + (e.secret ? ' · write-only: enter a new value to replace' : '')}
            >
              <Input
                type={e.secret ? 'password' : 'text'}
                disabled={running}
                placeholder={e.secret ? '••••••••  (set)' : (bot.env[e.name] ?? e.default ?? '')}
                value={e.secret ? (secretDraft[e.name] ?? '') : (envDraft[e.name] ?? bot.env[e.name] ?? '')}
                onChange={(ev) =>
                  e.secret
                    ? setSecretDraft((s) => ({ ...s, [e.name]: ev.target.value }))
                    : setEnvDraft((s) => ({ ...s, [e.name]: ev.target.value }))
                }
              />
            </Field>
          ))}
          {template.env.length > 0 && (
            <>
              {running && <p className="text-xs text-warn">Stop the bot to change its environment.</p>}
              <Btn
                variant="primary"
                disabled={running || (Object.keys(envDraft).length === 0 && Object.values(secretDraft).every((v) => !v))}
                onClick={() => {
                  void (async () => {
                    const plain = { ...bot.env, ...envDraft }
                    const secrets: Record<string, string> = {}
                    // carry over unreplaced secrets from the vault, apply new ones
                    for (const name of bot.secretNames) {
                      if (secretDraft[name]) {
                        secrets[name] = secretDraft[name]
                      } else {
                        const existing = await openSecret(`bot:${bot.id}:env:${name}`)
                        if (existing) secrets[name] = existing
                      }
                    }
                    for (const [k, v] of Object.entries(secretDraft)) if (v) secrets[k] = v
                    await manager.updateEnv(bot.id, plain, secrets)
                    setEnvDraft({})
                    setSecretDraft({})
                  })()
                }}
              >
                Save environment
              </Btn>
            </>
          )}
        </div>
      )}
    </div>
  )
}
