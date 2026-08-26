import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bot, Play, Plus, RotateCw, Square, Upload } from 'lucide-react'
import { useBots, useNow } from '../lib/hooks'
import { manager, runtimeLabel, type BotWithLive } from '../lib/runtime'
import { getTemplate } from '../lib/templates'
import { formatUptime } from '../lib/types'
import { Btn, Card, EmptyState, StatusPill } from '../components/ui'

function BotCard({ bot }: { bot: BotWithLive }) {
  const now = useNow()
  const running = bot.live.status === 'running' || bot.live.status === 'starting'
  const template = getTemplate(bot.template)

  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/bot/${bot.id}`} className="block truncate text-base font-semibold hover:text-accent">
            {bot.name}
          </Link>
          <p className="mt-0.5 text-xs text-muted">
            {template?.name ?? bot.template} · {runtimeLabel(bot.runtime, bot.executor)}
          </p>
        </div>
        <StatusPill status={bot.live.status} />
      </div>

      <p className="mt-3 line-clamp-2 min-h-8 text-sm text-muted">{bot.description || template?.tagline || ''}</p>

      <div className="mt-2 font-mono text-xs text-muted/70">
        {running && bot.live.startedAt ? `${formatUptime(bot.live.startedAt, now)} uptime` : 'not running'}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
        <Link to={`/bot/${bot.id}`}>
          <Btn variant="primary" size="sm">
            Open
          </Btn>
        </Link>
        {running ? (
          <Btn size="sm" onClick={() => void manager.stop(bot.id)}>
            <Square size={13} /> Stop
          </Btn>
        ) : (
          <Btn size="sm" onClick={() => void manager.start(bot.id).catch((e) => alert(String(e)))}>
            <Play size={13} /> Start
          </Btn>
        )}
        <Btn size="sm" onClick={() => void manager.restart(bot.id).catch((e) => alert(String(e)))}>
          <RotateCw size={13} /> Restart
        </Btn>
      </div>
    </Card>
  )
}

export default function Home() {
  const bots = useBots()
  const nav = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const importBundle = async (file: File) => {
    setImporting(true)
    try {
      const bot = await manager.importBot(await file.text(), 'browser')
      nav(`/bot/${bot.id}`)
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Bot Nodes</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Every node gets its own identity, runtime, database, storage and logs. Pick a template, deploy, and it
            answers real Nostr traffic — your keys, your relays, your rules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importBundle(f)
              e.target.value = ''
            }}
          />
          <Btn onClick={() => fileRef.current?.click()} disabled={importing}>
            <Upload size={15} /> {importing ? 'Importing…' : 'Import bundle'}
          </Btn>
          <Link to="/new">
            <Btn variant="primary">
              <Plus size={16} /> Deploy Bot Node
            </Btn>
          </Link>
        </div>
      </div>

      {bots.length === 0 ? (
        <EmptyState title="No bot nodes yet.">
          <Link to="/new" className="mt-4">
            <Btn variant="primary">
              <Bot size={15} className="mr-1" /> Deploy your first node
            </Btn>
          </Link>
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((b) => (
            <BotCard key={b.id} bot={b} />
          ))}
        </div>
      )}
    </div>
  )
}
