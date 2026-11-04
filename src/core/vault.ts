/**
 * Secrets at rest: secret variable values, auth fields (passwords, tokens, keys) and sensitive headers in history
 * are encrypted with AES-GCM before they go into IndexedDB. The key is a WebCrypto key created on this device and
 * marked non-extractable, so scripts, extensions or a copied browser profile can't read it out as bytes; it can only
 * be used by this app's code, on this device. (Where a non-extractable key can't be stored, e.g. some test
 * environments, it falls back to a stored raw key and says so in `vaultMode`.)
 */
import type { Auth, Collection, Environment, Folder, HistoryEntry, KV, RequestDef } from './types'

const PREFIX = 'enc:v1:'
const AUTH_SECRET_FIELDS: (keyof Auth)[] = ['password', 'token', 'value', 'clientSecret', 'accessToken', 'refreshToken', 'secret', 'secretKey', 'sessionToken']
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i

export interface KeyStore { get(): Promise<unknown>; set(v: unknown): Promise<void> }

let keyPromise: Promise<CryptoKey> | null = null
export let vaultMode: 'device-key' | 'raw-key' = 'device-key'

/** Loads or creates the device key. */
export function vaultKey(store: KeyStore): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const subtle = globalThis.crypto.subtle
    const saved = await store.get()
    if (saved && typeof saved === 'object' && 'type' in (saved as object) && (saved as CryptoKey).algorithm) return saved as CryptoKey
    if (saved && typeof saved === 'object' && 'k' in (saved as object)) { vaultMode = 'raw-key'; return subtle.importKey('jwk', saved as JsonWebKey, 'AES-GCM', false, ['encrypt', 'decrypt']) }
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    try {
      await store.set(key)
      return key
    } catch {
      // This storage can't keep a CryptoKey object; keep a raw key instead.
      vaultMode = 'raw-key'
      const raw = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      await store.set(await subtle.exportKey('jwk', raw))
      return subtle.importKey('jwk', await subtle.exportKey('jwk', raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
    }
  })()
  return keyPromise
}
export function resetVaultForTests() { keyPromise = null; vaultMode = 'device-key' }

const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX)

export async function seal(key: CryptoKey, plain: string): Promise<string> {
  if (!plain || isSealed(plain)) return plain
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length)
  return PREFIX + b64(out)
}

export async function unseal(key: CryptoKey, v: string): Promise<string> {
  if (!isSealed(v)) return v
  try {
    const bytes = unb64(v.slice(PREFIX.length))
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
    return new TextDecoder().decode(pt)
  } catch {
    return '' // a value sealed with another device's key (e.g. a copied database) can't be read here
  }
}

type Fn = (s: string) => Promise<string>
const vars = async (rows: KV[], f: Fn) => Promise.all(rows.map(async (r) => (r.secret ? { ...r, value: await f(r.value) } : r)))
async function auth(a: Auth, f: Fn): Promise<Auth> {
  const out = { ...a }
  for (const k of AUTH_SECRET_FIELDS) if (typeof out[k] === 'string' && out[k]) (out as Record<string, unknown>)[k] = await f(out[k] as string)
  return out
}
const headers = async (hs: [string, string][], f: Fn) => Promise.all(hs.map(async ([k, v]) => [k, SENSITIVE_HEADER.test(k) ? await f(v) : v] as [string, string]))

/** Applies `f` (seal or unseal) to every secret part of a record. */
export const secretsOf = {
  environment: async (e: Environment, f: Fn): Promise<Environment> => ({ ...e, variables: await vars(e.variables, f) }),
  collection: async (c: Collection, f: Fn): Promise<Collection> => ({ ...c, variables: await vars(c.variables, f), auth: await auth(c.auth, f) }),
  folder: async (x: Folder, f: Fn): Promise<Folder> => ({ ...x, auth: await auth(x.auth, f) }),
  request: async (r: RequestDef, f: Fn): Promise<RequestDef> => ({
    ...r, auth: await auth(r.auth, f),
    headers: await Promise.all(r.headers.map(async (h) => (SENSITIVE_HEADER.test(h.key) ? { ...h, value: await f(h.value) } : h))),
  }),
  globals: (g: KV[], f: Fn) => vars(g, f),
  history: async (h: HistoryEntry, f: Fn): Promise<HistoryEntry> => ({
    ...h, request: await secretsOf.request(h.request, f), sent: { ...h.sent, headers: await headers(h.sent.headers, f) },
  }),
}
