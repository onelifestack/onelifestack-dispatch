export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type Method = (typeof METHODS)[number]

/** One row of a key/value table (params, headers, form fields, variables). */
export interface KV {
  id: string
  key: string
  value: string
  enabled: boolean
  /** Form-data rows only: a file instead of text. */
  type?: 'text' | 'file'
  file?: FileData | null
  /** Variables only: hide the value on screen and leave it out of exports. */
  secret?: boolean
  description?: string
}

/** A file kept with the request (form-data part or binary body). Stored as base64 in IndexedDB. */
export interface FileData { name: string; type: string; size: number; base64: string }

export type BodyKind = 'none' | 'json' | 'text' | 'xml' | 'html' | 'urlencoded' | 'formdata' | 'binary' | 'graphql'
export interface Body {
  kind: BodyKind
  /** json/text/xml/html raw text; GraphQL query. */
  text: string
  /** urlencoded and form-data rows. */
  fields: KV[]
  /** GraphQL variables as JSON text. */
  graphqlVariables: string
  /** Binary body. */
  file: FileData | null
}

export type AuthKind = 'inherit' | 'none' | 'basic' | 'bearer' | 'apikey' | 'digest' | 'oauth2' | 'jwt' | 'awsv4'
export type OAuth2Grant = 'client_credentials' | 'password' | 'authorization_code'
export interface Auth {
  kind: AuthKind
  username: string
  password: string
  token: string
  key: string
  value: string
  in: 'header' | 'query'
  /** OAuth 2 */
  grant: OAuth2Grant
  tokenUrl: string
  authUrl: string
  clientId: string
  clientSecret: string
  scope: string
  redirectUri: string
  usePkce: boolean
  /** Where client id/secret go when asking for a token. */
  clientAuth: 'header' | 'body'
  /** Last token obtained (OAuth 2) — kept so requests can use it until it expires. */
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** JWT */
  algorithm: 'HS256' | 'HS384' | 'HS512'
  secret: string
  payload: string
  headerPrefix: string
  /** AWS SigV4 */
  accessKey: string
  secretKey: string
  sessionToken: string
  region: string
  service: string
}

export type Protocol = 'http' | 'ws' | 'mqtt' | 'grpc'

export interface RequestSettings {
  /** null = use the app setting. */
  timeoutMs: number | null
  followRedirects: boolean | null
  insecureTls: boolean | null
}

export interface Scripts { pre: string; post: string }

/** A saved response, shown in docs and served by the mock server. */
export interface Example {
  id: string
  name: string
  status: number
  headers: [string, string][]
  body: string
}

export interface WsConfig { messages: KV[] }
export interface MqttConfig { clientId: string; topics: KV[]; publishTopic: string; payload: string; qos: 0 | 1 | 2; retain: boolean }
export interface GrpcConfig { method: string; proto: string; useReflection: boolean; message: string; metadata: KV[]; tls: boolean }

export interface RequestDef {
  id: string
  name: string
  protocol: Protocol
  method: Method
  /** The full URL, including the query string built from the enabled params. */
  url: string
  /** Every query param, including disabled ones that are not in `url`. */
  params: KV[]
  /** Values for :name segments in the URL path. */
  pathVars: KV[]
  headers: KV[]
  body: Body
  auth: Auth
  scripts: Scripts
  settings: RequestSettings
  docs: string
  examples: Example[]
  collectionId: string | null
  folderId: string | null
  ws: WsConfig
  mqtt: MqttConfig
  grpc: GrpcConfig
  updatedAt: number
}

export interface Folder {
  id: string
  name: string
  collectionId: string
  parentId: string | null
  auth: Auth
  scripts: Scripts
  docs: string
  updatedAt: number
}

export interface Collection { id: string; name: string; auth: Auth; variables: KV[]; scripts: Scripts; docs: string; updatedAt: number }
export interface Environment { id: string; name: string; variables: KV[]; updatedAt: number }

export interface PreparedFile { name: string; type: string; base64: string }
/** A form-data part after variables were filled in. */
export interface PreparedPart { name: string; value?: string; file?: PreparedFile }

/** What was actually sent, after variables and auth were applied. */
export interface PreparedRequest {
  method: Method
  url: string
  headers: [string, string][]
  /** Text body (most kinds). */
  body: string | null
  /** Multipart parts (form-data); the transport builds the boundary. */
  multipart?: PreparedPart[] | null
  /** Binary body. */
  bodyFile?: PreparedFile | null
  /** Variable names that had no value; they are left in place as {{name}}. */
  unresolved: string[]
}

export interface Timings {
  /** Until response headers arrived. */
  ttfbMs: number
  /** Reading the body. */
  downloadMs: number
}

export interface HttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  /** Body as text when it is text; empty for binary bodies. */
  body: string
  /** True when the body was not valid text (an image, a zip...). */
  binary: boolean
  /** Raw body (base64) for binary bodies, so they can be previewed or saved. */
  base64?: string
  /** Body size in bytes. */
  size: number
  timeMs: number
  timings?: Timings
}

export interface TestResult { name: string; passed: boolean; error?: string }
export interface LogLine { level: 'log' | 'info' | 'warn' | 'error'; text: string; at: number; source?: string }

export interface HistoryEntry {
  id: string
  at: number
  request: RequestDef
  sent: PreparedRequest
  response: HttpResponse | null
  error: string | null
  tests?: TestResult[]
}

export interface Settings {
  activeEnvId: string | null
  theme: 'system' | 'light' | 'dark'
  timeoutMs: number
  followRedirects: boolean
  /** Desktop only: skip TLS certificate checks (self-signed homelab certs). */
  insecureTls: boolean
  /** Keep cookies from responses and send them back (desktop). */
  cookieJar: boolean
}

export const defaultSettings: Settings = {
  activeEnvId: null, theme: 'system', timeoutMs: 30_000, followRedirects: true, insecureTls: false, cookieJar: true,
}

let counter = 0
export function uid(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const kv = (key = '', value = '', enabled = true, extra: Partial<KV> = {}): KV => ({ id: uid(), key, value, enabled, ...extra })

export const emptyAuth = (kind: AuthKind = 'inherit'): Auth => ({
  kind, username: '', password: '', token: '', key: '', value: '', in: 'header',
  grant: 'client_credentials', tokenUrl: '', authUrl: '', clientId: '', clientSecret: '', scope: '',
  redirectUri: 'http://127.0.0.1:45719/callback', usePkce: true, clientAuth: 'header', accessToken: '', refreshToken: '', expiresAt: 0,
  algorithm: 'HS256', secret: '', payload: '{\n  "sub": "1234"\n}', headerPrefix: 'Bearer',
  accessKey: '', secretKey: '', sessionToken: '', region: 'us-east-1', service: 'execute-api',
})

export const emptyBody = (kind: BodyKind = 'none'): Body => ({ kind, text: '', fields: [], graphqlVariables: '', file: null })
export const emptyScripts = (): Scripts => ({ pre: '', post: '' })
export const emptySettings = (): RequestSettings => ({ timeoutMs: null, followRedirects: null, insecureTls: null })

export function newRequest(partial: Partial<RequestDef> = {}): RequestDef {
  return normalizeRequest({ id: uid(), name: 'New request', updatedAt: Date.now(), ...partial })
}

/** Fills every field, so records saved by older versions (and imports) have the current shape. */
export function normalizeRequest(r: Partial<RequestDef> & { id: string }): RequestDef {
  return {
    name: 'New request', protocol: 'http', method: 'GET', url: '', params: [], pathVars: [], headers: [],
    docs: '', examples: [], collectionId: null, folderId: null, updatedAt: Date.now(),
    ...r,
    body: { ...emptyBody(), ...r.body },
    auth: { ...emptyAuth(), ...r.auth },
    scripts: { ...emptyScripts(), ...r.scripts },
    settings: { ...emptySettings(), ...r.settings },
    ws: { messages: [], ...r.ws },
    mqtt: { clientId: '', topics: [], publishTopic: '', payload: '', qos: 0, retain: false, ...r.mqtt },
    grpc: { method: '', proto: '', useReflection: true, message: '{}', metadata: [], tls: false, ...r.grpc },
  }
}

export function newCollection(name = 'New collection'): Collection {
  return normalizeCollection({ id: uid(), name })
}
export function normalizeCollection(c: Partial<Collection> & { id: string }): Collection {
  return { name: 'Collection', variables: [], docs: '', updatedAt: Date.now(), ...c, auth: { ...emptyAuth('none'), ...c.auth }, scripts: { ...emptyScripts(), ...c.scripts } }
}

export function newFolder(collectionId: string, name = 'New folder', parentId: string | null = null): Folder {
  return normalizeFolder({ id: uid(), name, collectionId, parentId })
}
export function normalizeFolder(f: Partial<Folder> & { id: string; collectionId: string }): Folder {
  return { name: 'Folder', parentId: null, docs: '', updatedAt: Date.now(), ...f, auth: { ...emptyAuth('inherit'), ...f.auth }, scripts: { ...emptyScripts(), ...f.scripts } }
}

export function newEnvironment(name = 'New environment'): Environment {
  return { id: uid(), name, variables: [], updatedAt: Date.now() }
}

/** The id under which global variables are stored (as an environment that's always active). */
export const GLOBALS_ID = '__globals'
