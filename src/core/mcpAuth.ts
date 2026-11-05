/**
 * Signing in to protected MCP servers (MCP authorization, protocol 2025-06-18):
 *  1. the server answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`,
 *  2. protected resource metadata (RFC 9728) names the authorization server,
 *  3. authorization server metadata (RFC 8414 / OpenID discovery) gives the endpoints,
 *  4. dynamic client registration (RFC 7591), or a client ID the user registered,
 *  5. OAuth authorization code with PKCE and a `resource` indicator (RFC 8707),
 *  6. the token is sent as a bearer token and refreshed when it runs out.
 * Sign-ins are kept per environment and server, sealed in the vault, never exported.
 */
import type { Auth } from './types'
import { emptyAuth } from './types'
import { finishAuthCode, refreshToken, startAuthCode } from './auth'
import { SendError, type SendOptions, type Transport } from './transport'

/** Where the desktop app catches the login redirect (a one-shot listener on this port). */
export const MCP_REDIRECT = 'http://127.0.0.1:33418/callback'

export interface McpAuthServer {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  scopes: string[]
}
export interface McpDiscovery { resource: string; server: McpAuthServer; scope: string }

export interface McpSignIn {
  /** Environment id, or null for "no environment". */
  envId: string | null
  serverUrl: string
  resource: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  /** True when Dispatch registered the client itself. */
  registered: boolean
  redirectUri: string
  scope: string
  accessToken: string
  refreshToken: string
  /** 0 = unknown. */
  expiresAt: number
  signedInAt: number
}

/** A server URL in the form sign-ins are keyed by (no fragment, no trailing slash on the path). */
export const canonical = (url: string) => { const u = new URL(url); u.hash = ''; return u.toString().replace(/\/$/, '') }
export const findSignIn = (list: McpSignIn[], envId: string | null, url: string) => {
  let c: string; try { c = canonical(url) } catch { return undefined }
  return list.find((s) => s.envId === envId && s.serverUrl === c)
}

/** Parses `Bearer realm="x", resource_metadata="…", scope="a b"` into its parameters. */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const m of header.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = (m[2] ?? m[3]).replace(/\\(.)/g, '$1')
  return out
}

type Json = Record<string, any>
async function getJson(url: string, t: Transport, o: SendOptions): Promise<Json | null> {
  try {
    const r = await t.send({ method: 'GET', url, headers: [['Accept', 'application/json']], body: null, unresolved: [] }, o)
    if (r.status >= 400) return null
    const v = JSON.parse(r.body)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

/** Authorization server metadata, trying the RFC 8414 and OpenID locations (path-aware, as MCP asks). */
async function serverMetadata(issuer: string, t: Transport, o: SendOptions): Promise<Json | null> {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  const candidates = path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  for (const c of candidates) {
    const m = await getJson(c, t, o)
    if (m?.authorization_endpoint && m?.token_endpoint) return m
  }
  return null
}

/** Finds out where and how to sign in for an MCP server, from its 401 answer (if any). */
export async function discover(serverUrl: string, wwwAuthenticate: string | null, t: Transport, o: SendOptions): Promise<McpDiscovery> {
  const server = new URL(serverUrl)
  const www = parseWwwAuthenticate(wwwAuthenticate)
  // 1. Protected resource metadata: from the header, else the well-known locations (path first).
  const path = server.pathname.replace(/\/$/, '')
  const prmUrls = [www.resource_metadata, path ? `${server.origin}/.well-known/oauth-protected-resource${path}` : null, `${server.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[]
  let prm: Json | null = null
  for (const u of prmUrls) { prm = await getJson(u, t, o); if (prm) break }
  // 2. Authorization server: named by the metadata, else (older servers) the MCP server's own origin.
  const issuer: string = prm?.authorization_servers?.[0] ?? server.origin
  const meta = await serverMetadata(issuer, t, o)
  const as: McpAuthServer = meta
    ? { issuer: meta.issuer ?? issuer, authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, registrationEndpoint: meta.registration_endpoint ?? null, scopes: meta.scopes_supported ?? [] }
    : prm ? (() => { throw new SendError(`Couldn’t read the sign-in settings of ${issuer}.`) })()
    // MCP 2025-03-26 fallback: default endpoints on the server's origin.
    : { issuer, authorizationEndpoint: `${server.origin}/authorize`, tokenEndpoint: `${server.origin}/token`, registrationEndpoint: `${server.origin}/register`, scopes: [] }
  if (meta && meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) throw new SendError('This server’s sign-in doesn’t support PKCE (S256), which MCP requires.')
  const scope = www.scope ?? (prm?.scopes_supported ?? []).join(' ')
  return { resource: prm?.resource ?? canonical(serverUrl), server: as, scope }
}

/** Dynamic client registration (RFC 7591): Dispatch as a public client with a loopback redirect. */
export async function registerClient(endpoint: string, redirectUri: string, scope: string, t: Transport, o: SendOptions): Promise<{ clientId: string; clientSecret: string }> {
  const body = { client_name: 'Dispatch', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }
  const r = await t.send({ method: 'POST', url: endpoint, headers: [['Content-Type', 'application/json'], ['Accept', 'application/json']], body: JSON.stringify(body), unresolved: [] }, o)
  let j: Json = {}
  try { j = JSON.parse(r.body) } catch { /* */ }
  if (r.status >= 400 || !j.client_id) throw new SendError(`The server wouldn’t register Dispatch: ${j.error_description ?? j.error ?? `${r.status} ${r.statusText}`}`)
  return { clientId: String(j.client_id), clientSecret: String(j.client_secret ?? '') }
}

/** The OAuth 2 settings a sign-in uses, in the shape the shared OAuth code takes. */
export function authFor(s: Pick<McpSignIn, 'authorizationEndpoint' | 'tokenEndpoint' | 'clientId' | 'clientSecret' | 'redirectUri' | 'scope' | 'refreshToken'>): Auth {
  return { ...emptyAuth('oauth2'), grant: 'authorization_code', authUrl: s.authorizationEndpoint, tokenUrl: s.tokenEndpoint, clientId: s.clientId, clientSecret: s.clientSecret,
    redirectUri: s.redirectUri, scope: s.scope, usePkce: true, clientAuth: 'body', refreshToken: s.refreshToken }
}

export interface SignInOptions {
  serverUrl: string
  envId: string | null
  /** The WWW-Authenticate header from the server's 401, if there was one. */
  wwwAuthenticate: string | null
  transport: Transport
  opts: SendOptions
  /** An earlier sign-in for this server and environment: its client registration is reused. */
  previous?: McpSignIn
  /** Opens the login page and resolves with the address the browser came back to (the redirect). */
  openAndWait: (url: string, redirectUri: string) => Promise<string | null>
  /** Asked when the server doesn't offer registration: a client ID (and secret) the user registered with them. */
  askClient: (info: { issuer: string; redirectUri: string }) => Promise<{ clientId: string; clientSecret: string } | null>
  redirectUri?: string
}

/** The whole sign-in. Resolves with the new sign-in to save, or null when the user cancelled. */
export async function signIn(o: SignInOptions): Promise<McpSignIn | null> {
  const redirectUri = o.redirectUri ?? MCP_REDIRECT
  const d = await discover(o.serverUrl, o.wwwAuthenticate, o.transport, o.opts)
  let client: { clientId: string; clientSecret: string; registered: boolean } | null =
    o.previous && o.previous.tokenEndpoint === d.server.tokenEndpoint && o.previous.redirectUri === redirectUri
      ? { clientId: o.previous.clientId, clientSecret: o.previous.clientSecret, registered: o.previous.registered } : null
  if (!client) {
    if (d.server.registrationEndpoint) client = { ...(await registerClient(d.server.registrationEndpoint, redirectUri, d.scope, o.transport, o.opts)), registered: true }
    else { const c = await o.askClient({ issuer: d.server.issuer, redirectUri }); if (!c?.clientId.trim()) return null; client = { clientId: c.clientId.trim(), clientSecret: c.clientSecret.trim(), registered: false } }
  }
  const base = { authorizationEndpoint: d.server.authorizationEndpoint, tokenEndpoint: d.server.tokenEndpoint, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri, scope: d.scope, refreshToken: '' }
  const a = authFor(base)
  const start = await startAuthCode(a)
  const url = new URL(start.url); url.searchParams.set('resource', d.resource)
  const landed = await o.openAndWait(url.toString(), redirectUri)
  if (!landed) return null
  const tok = await finishAuthCode(a, start, landed, o.transport, o.opts, { resource: d.resource })
  return { envId: o.envId, serverUrl: canonical(o.serverUrl), resource: d.resource, issuer: d.server.issuer, ...base, registered: client.registered,
    accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: tok.expiresAt, signedInAt: Date.now() }
}

/** True when the token has run out or will within a minute. */
export const expiring = (s: McpSignIn, now = Date.now()) => !!s.expiresAt && s.expiresAt < now + 60_000

/** A fresh token from the refresh token; null when there's none or the server said no (sign in again). */
export async function refreshSignIn(s: McpSignIn, t: Transport, o: SendOptions): Promise<McpSignIn | null> {
  if (!s.refreshToken) return null
  try {
    const tok = await refreshToken(authFor(s), t, o, { resource: s.resource })
    return { ...s, accessToken: tok.accessToken, refreshToken: tok.refreshToken || s.refreshToken, expiresAt: tok.expiresAt }
  } catch { return null }
}

/** Well-known remote MCP servers to start from (addresses as their providers publish them; checked 2026-11-04). */
export const MCP_SUGGESTIONS: { name: string; url: string; signIn: 'auto' | 'client' | 'none' }[] = [
  { name: 'Linear', url: 'https://mcp.linear.app/mcp', signIn: 'auto' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp', signIn: 'auto' },
  { name: 'Atlassian (Jira, Confluence)', url: 'https://mcp.atlassian.com/v1/mcp', signIn: 'auto' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', signIn: 'auto' },
  { name: 'Stripe', url: 'https://mcp.stripe.com', signIn: 'auto' },
  { name: 'Vercel', url: 'https://mcp.vercel.com', signIn: 'auto' },
  { name: 'Supabase', url: 'https://mcp.supabase.com/mcp', signIn: 'auto' },
  { name: 'Neon', url: 'https://mcp.neon.tech/mcp', signIn: 'auto' },
  { name: 'Intercom', url: 'https://mcp.intercom.com/mcp', signIn: 'auto' },
  { name: 'Canva', url: 'https://mcp.canva.com/mcp', signIn: 'auto' },
  { name: 'PayPal', url: 'https://mcp.paypal.com/mcp', signIn: 'auto' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', signIn: 'client' },
  { name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', signIn: 'client' },
  { name: 'Hugging Face', url: 'https://huggingface.co/mcp', signIn: 'none' },
  { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', signIn: 'none' },
  { name: 'Cloudflare Docs', url: 'https://docs.mcp.cloudflare.com/mcp', signIn: 'none' },
]
