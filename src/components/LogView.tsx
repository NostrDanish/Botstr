import { useEffect, useRef, useState } from 'react'
import { useLogs } from '../lib/hooks'
import type { LogEntry } from '../lib/types'
import { cn } from './ui'

const LEVEL_CLS: Record<LogEntry['level'], string> = {
  debug: 'text-muted/70',
  info: 'text-accent',
  warn: 'text-warn',
  error: 'text-danger',
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function LogView({ botId, className }: { botId: string; className?: string }) {
  const logs = useLogs(botId)
  const [level, setLevel] = useState<'all' | LogEntry['level']>('all')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  const filtered = logs.filter(
    (l) => (level === 'all' || l.level === level) && (!query || l.msg.toLowerCase().includes(query.toLowerCase())),
  )

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [filtered.length, follow])

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-border text-xs">
          {(['all', 'info', 'warn', 'error'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={cn('px-2.5 py-1.5 capitalize', level === l ? 'bg-panel2 text-text' : 'text-muted hover:text-text')}
            >
              {l}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter logs…"
          className="w-44 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent/60"
        />
        <button
          onClick={() => setFollow((f) => !f)}
          className={cn('ml-auto rounded-lg border border-border px-2.5 py-1.5 text-xs', follow ? 'text-accent' : 'text-muted')}
        >
          {follow ? 'following' : 'paused'}
        </button>
      </div>
      <div
        ref={box}
        className="h-80 overflow-y-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-5"
      >
        {filtered.length === 0 && <p className="text-muted">No logs yet. Start the bot and they will stream in here.</p>}
        {filtered.map((l, i) => (
          <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="shrink-0 text-muted/60">{fmtTime(l.ts)}</span>
            <span className={cn('w-11 shrink-0 uppercase', LEVEL_CLS[l.level])}>{l.level}</span>
            <span className="text-text/90">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
