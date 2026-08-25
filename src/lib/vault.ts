/**
 * Vault — encrypted-at-rest secret storage.
 *
 * Bot private keys and secret environment values are AES-256-GCM encrypted with
 * a non-extractable device key before they touch IndexedDB. Secrets never appear
 * in logs, URLs, the bot record, or analytics. The same seal/open contract is
 * implemented by the Cloudflare runtime (encrypted with a platform secret), and
 * can later be backed by external providers (NIP-49 export, KMS, etc).
 */
const DB_NAME = 'botstr-vault'
const STORE = 'secrets'
const KEY_ID = 'device-key'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

let deviceKeyPromise: Promise<CryptoKey> | null = null

async function deviceKey(): Promise<CryptoKey> {
  if (!deviceKeyPromise) {
    deviceKeyPromise = (async () => {
      const db = await openDb()
      const existing = await idbGet(db, KEY_ID)
      if (existing) return existing as CryptoKey
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ])
      await idbPut(db, KEY_ID, key)
      return key
    })()
  }
  return deviceKeyPromise
}

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function sealSecret(id: string, plaintext: string): Promise<void> {
  const key = await deviceKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  const db = await openDb()
  await idbPut(db, id, { iv: b64encode(iv), ct: b64encode(ct) })
}

export async function openSecret(id: string): Promise<string | null> {
  const db = await openDb()
  const rec = (await idbGet(db, id)) as { iv: string; ct: string } | undefined
  if (!rec) return null
  const key = await deviceKey()
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(rec.iv) as BufferSource },
    key,
    b64decode(rec.ct) as BufferSource,
  )
  return new TextDecoder().decode(pt)
}

export async function deleteSecret(id: string): Promise<void> {
  const db = await openDb()
  await idbDelete(db, id)
}
