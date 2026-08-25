import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { DM_KIND, GIFTWRAP_KIND, unwrapGift, wrapDM } from '../src/lib/giftwrap'
import { hexToBytes } from '../src/lib/identity'
import { bytesToHex, generateIdentity } from '../src/lib/identity'

describe('NIP-17 giftwrap', () => {
  it('wraps and unwraps a DM, recovering the exact rumor', () => {
    const alice = generateIdentity()
    const bob = generateIdentity()
    const wrap = wrapDM(hexToBytes(alice.secretHex), bob.pubkey, 'hello bob')

    expect(wrap.kind).toBe(GIFTWRAP_KIND)
    // wrap is signed by an ephemeral key, p-tagged to the recipient
    expect(wrap.tags).toContainEqual(['p', bob.pubkey])
    expect(wrap.pubkey).not.toBe(alice.pubkey)

    const rumor = unwrapGift(wrap, hexToBytes(bob.secretHex))
    expect(rumor.kind).toBe(DM_KIND)
    expect(rumor.content).toBe('hello bob')
    expect(rumor.pubkey).toBe(alice.pubkey)
    expect(rumor.tags).toContainEqual(['p', bob.pubkey])
  })

  it('fails to unwrap with the wrong recipient key', () => {
    const alice = generateIdentity()
    const bob = generateIdentity()
    const eve = generateIdentity()
    const wrap = wrapDM(hexToBytes(alice.secretHex), bob.pubkey, 'secret')
    expect(() => unwrapGift(wrap, hexToBytes(eve.secretHex))).toThrow()
  })

  it('accepts raw noble keys too (hex roundtrip sanity)', () => {
    const sk = generateSecretKey()
    const hex = bytesToHex(sk)
    expect(getPublicKey(hexToBytes(hex))).toBe(getPublicKey(sk))
  })
})
