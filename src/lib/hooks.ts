import { useEffect, useState, useSyncExternalStore } from 'react'
import { manager, type BotWithLive } from './runtime'
import type { LogEntry } from './types'

export function useBots(): BotWithLive[] {
  return useSyncExternalStore(
    (cb) => manager.subscribe(cb),
    () => manager.getSnapshot(),
  )
}

export function useBot(id: string | undefined): BotWithLive | undefined {
  const bots = useBots()
  return bots.find((b) => b.id === id)
}

export function useLogs(botId: string | undefined): LogEntry[] {
  const [logs, setLogs] = useState<LogEntry[]>([])
  useEffect(() => {
    if (!botId) return
    let alive = true
    void manager.logs(botId).then((l) => alive && setLogs(l))
    const unsub = manager.subscribeLogs(botId, (entry) => {
      setLogs((prev) => [...prev.slice(-599), entry])
    })
    return () => {
      alive = false
      unsub()
    }
  }, [botId])
  return logs
}

/** 1Hz ticking clock for uptimes. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}
