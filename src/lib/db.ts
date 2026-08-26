/** IndexedDB persistence for bot records, logs and events. Secrets never live here — see vault.ts. */
import type { BotEventEntry, BotRecord, LogEntry } from './types'

const DB_NAME = 'botstr'
const LOG_CAP = 600
const EVENT_CAP = 300

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('bots')) db.createObjectStore('bots', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs') // key: botId → { entries: LogEntry[] }
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events') // key: botId → { entries: BotEventEntry[] }
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state') // key: botId → Record<string, unknown>
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files') // key: `${botId}:${name}` → { data, contentType, size }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function listBots(): Promise<BotRecord[]> {
  const bots = (await tx('bots', 'readonly', (s) => s.getAll())) as BotRecord[]
  return bots.sort((a, b) => b.createdAt - a.createdAt)
}

export async function putBot(bot: BotRecord): Promise<void> {
  await tx('bots', 'readwrite', (s) => s.put(bot))
}

export async function deleteBot(id: string): Promise<void> {
  await tx('bots', 'readwrite', (s) => s.delete(id))
  await tx('logs', 'readwrite', (s) => s.delete(id))
  await tx('events', 'readwrite', (s) => s.delete(id))
  await tx('state', 'readwrite', (s) => s.delete(id))
}

async function appendCapped(store: 'logs' | 'events', botId: string, entry: LogEntry | BotEventEntry, cap: number) {
  const db = await openDb()
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const s = t.objectStore(store)
    const get = s.get(botId)
    get.onsuccess = () => {
      const rec = (get.result as { entries: unknown[] } | undefined) ?? { entries: [] }
      rec.entries.push(entry)
      if (rec.entries.length > cap) rec.entries = rec.entries.slice(-cap)
      s.put(rec, botId)
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export function appendLog(botId: string, entry: LogEntry) {
  return appendCapped('logs', botId, entry, LOG_CAP)
}

export function appendEvent(botId: string, entry: BotEventEntry) {
  return appendCapped('events', botId, entry, EVENT_CAP)
}

export async function getLogs(botId: string): Promise<LogEntry[]> {
  const rec = (await tx('logs', 'readonly', (s) => s.get(botId))) as { entries: LogEntry[] } | undefined
  return rec?.entries ?? []
}

export async function getEvents(botId: string): Promise<BotEventEntry[]> {
  const rec = (await tx('events', 'readonly', (s) => s.get(botId))) as { entries: BotEventEntry[] } | undefined
  return rec?.entries ?? []
}

export async function getState(botId: string): Promise<Record<string, unknown>> {
  const rec = await tx('state', 'readonly', (s) => s.get(botId))
  return (rec as Record<string, unknown>) ?? {}
}

export async function putState(botId: string, state: Record<string, unknown>): Promise<void> {
  await tx('state', 'readwrite', (s) => s.put(state, botId))
}

export async function deleteState(botId: string): Promise<void> {
  await tx('state', 'readwrite', (s) => s.delete(botId))
}

// ---------------------------------------------------------------- node files
export interface StoredFile {
  data: ArrayBuffer
  contentType: string
  size: number
}

export async function putFile(botId: string, name: string, data: ArrayBuffer, contentType: string): Promise<void> {
  await tx('files', 'readwrite', (s) => s.put({ data, contentType, size: data.byteLength } satisfies StoredFile, `${botId}:${name}`))
}

export async function getFile(botId: string, name: string): Promise<StoredFile | null> {
  return ((await tx('files', 'readonly', (s) => s.get(`${botId}:${name}`))) as StoredFile) ?? null
}

export async function deleteFile(botId: string, name: string): Promise<void> {
  await tx('files', 'readwrite', (s) => s.delete(`${botId}:${name}`))
}

export async function listFiles(botId: string): Promise<{ name: string; size: number }[]> {
  const keys = (await tx('files', 'readonly', (s) => s.getAllKeys())) as string[]
  const prefix = `${botId}:`
  const out: { name: string; size: number }[] = []
  for (const k of keys) {
    if (k.startsWith(prefix)) {
      const f = await getFile(botId, k.slice(prefix.length))
      if (f) out.push({ name: k.slice(prefix.length), size: f.size })
    }
  }
  return out
}

export async function filesUsedBytes(botId: string): Promise<number> {
  const files = await listFiles(botId)
  return files.reduce((sum, f) => sum + f.size, 0)
}
