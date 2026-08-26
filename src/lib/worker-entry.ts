/**
 * Web Worker entry — the browser executor's per-node process.
 * Receives the bot config + decrypted secrets over postMessage (same-origin,
 * in-memory only), runs the shared core, streams logs/status/events back.
 * File ops are brokered to the dashboard thread (IndexedDB) request/response style.
 */
/// <reference lib="webworker" />
import { runBot, type BotHandle, type FileOp } from './core'
import { getTemplate } from './templates'
import { hexToBytes } from './identity'
import type { BotRecord, BotStatus } from './types'

declare const self: DedicatedWorkerGlobalScope

interface StartMsg {
  cmd: 'start'
  bot: BotRecord
  nsecHex: string
  secrets: Record<string, string>
  state: Record<string, unknown>
}
interface StopMsg {
  cmd: 'stop'
}
interface FileResMsg {
  kind: 'file:res'
  reqId: string
  ok: boolean
  result?: unknown
  error?: string
}
type InMsg = StartMsg | StopMsg | FileResMsg

let handle: BotHandle | null = null
let startedAt = 0
const pendingFileOps = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

const post = (msg: Record<string, unknown>) => self.postMessage(msg)

function fileOp(op: FileOp): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36)
    pendingFileOps.set(reqId, { resolve, reject })
    post({ kind: 'file', reqId, op: op.op, name: op.name, data: op.data, contentType: op.contentType })
    setTimeout(() => {
      if (pendingFileOps.delete(reqId)) reject(new Error('file op timed out'))
    }, 15_000)
  })
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data
  if (m.cmd === 'start') {
    if (handle) await handle.stop()
    const template = getTemplate(m.bot.template)
    if (!template) {
      post({ kind: 'status', status: 'failed', detail: `unknown template "${m.bot.template}"` })
      return
    }
    startedAt = Date.now()
    try {
      handle = await runBot(
        m.bot,
        m.secrets,
        template.module,
        {
          log: (level, msg) => post({ kind: 'log', level, msg }),
          status: (status: BotStatus, detail?: string) => post({ kind: 'status', status, detail, startedAt }),
          event: (type, summary) => post({ kind: 'event', eventType: type, summary }),
          persistState: (state) => post({ kind: 'state', state }),
          setTimer: (fn, ms) => setInterval(fn, ms),
          clearTimer: (t) => clearInterval(t as number),
          fileOp,
        },
        {
          privkey: hexToBytes(m.nsecHex),
          persistedState: m.state,
        },
      )
    } catch (err) {
      post({ kind: 'status', status: 'failed', detail: err instanceof Error ? err.message : String(err) })
    }
  } else if (m.cmd === 'stop') {
    await handle?.stop()
    handle = null
  } else if (m.kind === 'file:res') {
    const pending = pendingFileOps.get(m.reqId)
    if (pending) {
      pendingFileOps.delete(m.reqId)
      if (m.ok) pending.resolve(m.result)
      else pending.reject(new Error(m.error ?? 'file op failed'))
    }
  }
}

export {}
