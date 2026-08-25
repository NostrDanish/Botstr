/**
 * Web Worker entry — the browser executor's per-bot process.
 * Receives the bot config + decrypted secrets over postMessage (same-origin,
 * in-memory only), runs the shared core, streams logs/status/events back.
 */
/// <reference lib="webworker" />
import { runBot, type BotHandle } from './core'
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
type InMsg = StartMsg | StopMsg

let handle: BotHandle | null = null
let startedAt = 0

const post = (msg: Record<string, unknown>) => self.postMessage(msg)

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
      handle = await runBot(m.bot, m.secrets, template.module, {
        log: (level, msg) => post({ kind: 'log', level, msg }),
        status: (status: BotStatus, detail?: string) => post({ kind: 'status', status, detail, startedAt }),
        event: (type, summary) => post({ kind: 'event', eventType: type, summary }),
        persistState: (state) => post({ kind: 'state', state }),
        setTimer: (fn, ms) => setInterval(fn, ms),
        clearTimer: (t) => clearInterval(t as number),
      }, {
        privkey: hexToBytes(m.nsecHex),
        persistedState: m.state,
      })
    } catch (err) {
      post({ kind: 'status', status: 'failed', detail: err instanceof Error ? err.message : String(err) })
    }
  } else if (m.cmd === 'stop') {
    await handle?.stop()
    handle = null
  }
}

export {}
