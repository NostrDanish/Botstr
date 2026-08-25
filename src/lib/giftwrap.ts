/**
 * NIP-17 private DMs: NIP-59 giftwraps built directly on NIP-44 v2.
 *
 * rumor (kind 14, unsigned, real author) → seal (kind 13, signed by sender,
 * NIP-44 to recipient) → wrap (kind 1059, signed by a throwaway key, NIP-44 to
 * recipient, p-tagged to recipient). Timestamps are randomized within the past
 * two days per NIP-59. Implemented explicitly (rather than via a helper) so the
 * exact wire format is reviewable here.
 */
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
  verifyEvent,
  type Event as NostrEvent,
} from 'nostr-tools'

export const GIFTWRAP_KIND = 1059
export const SEAL_KIND = 13
export const DM_KIND = 14

const DAY = 86400

function randomPast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 2 * DAY)
}

/** NIP-44 v2 conversation key. Handles both known export shapes of nostr-tools. */
function conversationKey(priv: Uint8Array, pub: string): Uint8Array {
  const v2 = nip44.v2 as unknown as Record<string, unknown>
  const utils = v2.utils as Record<string, unknown> | undefined
  const fn = (utils?.getConversationKey ?? v2.getConversationKey) as
    | ((a: Uint8Array, b: string) => Uint8Array)
    | undefined
  if (!fn) throw new Error('nip44.getConversationKey unavailable')
  return fn(priv, pub)
}

export interface Rumor {
  id: string
  pubkey: string
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export function unwrapGift(wrap: NostrEvent, recipientPriv: Uint8Array): Rumor {
  if (wrap.kind !== GIFTWRAP_KIND) throw new Error('not a giftwrap')
  const seal = JSON.parse(nip44.v2.decrypt(wrap.content, conversationKey(recipientPriv, wrap.pubkey))) as NostrEvent
  if (seal.kind !== SEAL_KIND) throw new Error('wrap does not contain a seal')
  if (!verifyEvent(seal)) throw new Error('invalid seal signature')
  const rumor = JSON.parse(nip44.v2.decrypt(seal.content, conversationKey(recipientPriv, seal.pubkey))) as Rumor
  if (rumor.pubkey !== seal.pubkey) throw new Error('rumor/seal author mismatch')
  if (typeof rumor.id !== 'string' || getEventHash(rumor as never) !== rumor.id) throw new Error('invalid rumor id')
  return rumor
}

/** Build a NIP-17 DM (kind 14 rumor) giftwrapped for `recipientPub`. */
export function wrapDM(senderPriv: Uint8Array, recipientPub: string, text: string): NostrEvent {
  const senderPub = getPublicKey(senderPriv)
  const rumor: Rumor = {
    kind: DM_KIND,
    pubkey: senderPub,
    created_at: randomPast(),
    tags: [['p', recipientPub]],
    content: text,
    id: '',
  }
  rumor.id = getEventHash(rumor as never)
  const seal = finalizeEvent(
    {
      kind: SEAL_KIND,
      content: nip44.v2.encrypt(JSON.stringify(rumor), conversationKey(senderPriv, recipientPub)),
      created_at: randomPast(),
      tags: [],
    },
    senderPriv,
  )
  const ephemeral = generateSecretKey()
  return finalizeEvent(
    {
      kind: GIFTWRAP_KIND,
      content: nip44.v2.encrypt(JSON.stringify(seal), conversationKey(ephemeral, recipientPub)),
      created_at: randomPast(),
      tags: [['p', recipientPub]],
    },
    ephemeral,
  )
}
