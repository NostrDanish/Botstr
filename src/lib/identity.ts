/**
 * Bot identity. Every bot gets its own keypair — never the user's personal key.
 * The secret key is handled as hex in memory only, and sealed in the vault at rest.
 */
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('expected 64-char hex')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface Identity {
  /** hex secret key — keep in memory only, seal in vault */
  secretHex: string
  pubkey: string
  npub: string
  nsec: string
}

export function generateIdentity(): Identity {
  const sk = generateSecretKey()
  const secretHex = bytesToHex(sk)
  const pubkey = getPublicKey(sk)
  return { secretHex, pubkey, npub: nip19.npubEncode(pubkey), nsec: nip19.nsecEncode(sk) }
}

/** Accepts nsec1… or 64-char hex. Returns a normalized identity. */
export function importIdentity(input: string): Identity {
  const trimmed = input.trim()
  let secretHex: string
  if (trimmed.startsWith('nsec1')) {
    const dec = nip19.decode(trimmed)
    if (dec.type !== 'nsec') throw new Error('not an nsec')
    secretHex = bytesToHex(dec.data as Uint8Array)
  } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    secretHex = trimmed.toLowerCase()
  } else {
    throw new Error('expected an nsec1… key or 64-char hex')
  }
  const pubkey = getPublicKey(hexToBytes(secretHex))
  return { secretHex, pubkey, npub: nip19.npubEncode(pubkey), nsec: nip19.nsecEncode(hexToBytes(secretHex)) }
}
