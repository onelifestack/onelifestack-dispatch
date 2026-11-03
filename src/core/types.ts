export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type Method = (typeof METHODS)[number]

/** One row of a key/value table (params, headers, form fields, variables). */
export interface KV { id: string; key: string; value: string; enabled: boolean }

export type BodyKind = 'none' | 'json' | 'text' | 'urlencoded'
export interface Body { kind: BodyKind; text: string; fields: KV[] }

export type AuthKind = 'inherit' | 'none' | 'basic' | 'bearer' | 'apikey'
export interface Auth {
  kind: AuthKind
  username: string
  password: string
  token: string
  key: string
  value: string
  in: 'header' | 'query'
}

export interface RequestDef {
  id: string
  name: string
  method: Method
  /** The full URL, including the query string built from the enabled params. */
  url: string
  /** Every query param, including disabled ones that are not in `url`. */
  params: KV[]
  headers: KV[]
  body: Body
  auth: Auth
  collectionId: string | null
  updatedAt: number
}

export interface Collection { id: string; name: string; auth: Auth; variables: KV[]; updatedAt: number }
export interface Environment { id: string; name: string; variables: KV[]; updatedAt: number }

/** What was actually sent, after variables and auth were applied. */
export interface PreparedRequest {
  method: Method
  url: string
  headers: [string, string][]
  body: string | null
  /** Variable names that had no value; they are left in place as {{name}}. */
  unresolved: string[]
}

export interface HttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  /** Body as text when it is text; empty for binary bodies. */
  body: string
  /** True when the body was not valid text (an image, a zip...). */
  binary: boolean
  /** Body size in bytes. */
  size: number
  timeMs: number
}

export interface HistoryEntry {
  id: string
  at: number
  request: RequestDef
  sent: PreparedRequest
  response: HttpResponse | null
  error: string | null
}

export interface Settings {
  activeEnvId: string | null
  theme: 'system' | 'light' | 'dark'
  timeoutMs: number
  followRedirects: boolean
  /** Desktop only: skip TLS certificate checks (self-signed homelab certs). */
  insecureTls: boolean
}

export const defaultSettings: Settings = {
  activeEnvId: null, theme: 'system', timeoutMs: 30_000, followRedirects: true, insecureTls: false,
}

let counter = 0
export function uid(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const kv = (key = '', value = '', enabled = true): KV => ({ id: uid(), key, value, enabled })

export const emptyAuth = (kind: AuthKind = 'inherit'): Auth =>
  ({ kind, username: '', password: '', token: '', key: '', value: '', in: 'header' })

export function newRequest(partial: Partial<RequestDef> = {}): RequestDef {
  return {
    id: uid(), name: 'New request', method: 'GET', url: '', params: [], headers: [],
    body: { kind: 'none', text: '', fields: [] }, auth: emptyAuth(), collectionId: null, updatedAt: Date.now(),
    ...partial,
  }
}

export function newCollection(name = 'New collection'): Collection {
  return { id: uid(), name, auth: emptyAuth('none'), variables: [], updatedAt: Date.now() }
}

export function newEnvironment(name = 'New environment'): Environment {
  return { id: uid(), name, variables: [], updatedAt: Date.now() }
}
