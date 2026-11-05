/**
 * Auth that needs crypto or a round trip: JWT (HMAC), AWS Signature v4, Digest (answers the 401 challenge) and
 * OAuth 2 (client credentials, password, authorization code + PKCE, refresh). Uses WebCrypto, so it runs in
 * browsers, the desktop webview and Node alike. MD5 (needed by Digest) isn't in WebCrypto, so it's here.
 */
import type { Auth, HttpResponse, PreparedRequest, RequestDef } from './types'
import { type Pipeline, type RunContext, folderChain, prepareContext } from './runtime'
import { effectiveAuth, scopeFor } from './prepare'
import { interpolate } from './vars'
import { SendError, type SendOptions, type Transport, base64ToBytes } from './transport'

const enc = new TextEncoder()
const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new SendError('This auth type needs WebCrypto, which isn’t available here.')
  return s
}
const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const b64url = (b: ArrayBuffer | Uint8Array) => {
  let s = ''
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256(data: string | Uint8Array): Promise<ArrayBuffer> {
  return subtle().digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data)
}
export async function hmac(hash: 'SHA-256' | 'SHA-384' | 'SHA-512', key: string | ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await subtle().importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash }, false, ['sign'])
  return subtle().sign('HMAC', k, enc.encode(data))
}

/** MD5 (RFC 1321) of a UTF-8 string, as hex. Only for HTTP Digest auth. */
export function md5(input: string): string {
  const msg = enc.encode(input)
  const len = msg.length
  const words = new Uint32Array((((len + 8) >>> 6) + 1) * 16)
  for (let i = 0; i < len; i++) words[i >> 2] |= msg[i] << ((i % 4) * 8)
  words[len >> 2] |= 0x80 << ((len % 4) * 8)
  words[words.length - 2] = (len * 8) >>> 0
  words[words.length - 1] = Math.floor((len * 8) / 0x100000000)
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < words.length; off += 16) {
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f: number, g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const tmp = d; d = c; c = b
      const sum = (a + f + K[i] + words[off + g]) >>> 0
      const s = S[(i >> 4) * 4 + (i % 4)]
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0
      a = tmp
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0
  }
  return [a0, b0, c0, d0].map((v) => [0, 8, 16, 24].map((s) => ((v >>> s) & 0xff).toString(16).padStart(2, '0')).join('')).join('')
}

// ---------- JWT ----------

export async function signJwt(auth: Pick<Auth, 'algorithm' | 'secret' | 'payload'>, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  let payload: Record<string, unknown>
  try { payload = JSON.parse(auth.payload || '{}') } catch { throw new SendError('The JWT payload isn’t valid JSON.') }
  if (payload.iat === undefined) payload.iat = nowSec
  const head = b64url(enc.encode(JSON.stringify({ alg: auth.algorithm, typ: 'JWT' })))
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const hash = auth.algorithm === 'HS512' ? 'SHA-512' : auth.algorithm === 'HS384' ? 'SHA-384' : 'SHA-256'
  return `${head}.${body}.${b64url(await hmac(hash, auth.secret, `${head}.${body}`))}`
}

// ---------- AWS Signature v4 ----------

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface AwsKeys { accessKey: string; secretKey: string; sessionToken?: string; region: string; service: string }

/** Signs a prepared request (AWS SigV4, header style). `now` is for tests. */
export async function signAwsV4(p: PreparedRequest, k: AwsKeys, now = new Date()): Promise<PreparedRequest> {
  const url = new URL(p.url)
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers = p.headers.filter(([h]) => !['authorization', 'x-amz-date', 'x-amz-security-token', 'host'].includes(h.toLowerCase()))
  const add: [string, string][] = [['Host', url.host], ['X-Amz-Date', amzDate]]
  if (k.sessionToken) add.push(['X-Amz-Security-Token', k.sessionToken])
  const payloadHash = p.multipart ? 'UNSIGNED-PAYLOAD' : toHex(await sha256(p.bodyFile ? base64ToBytes(p.bodyFile.base64) : (p.body ?? '')))
  if (k.service === 's3') add.push(['X-Amz-Content-Sha256', payloadHash])
  const all = [...headers, ...add]
  const canon = new Map<string, string[]>()
  for (const [h, v] of all) { const n = h.toLowerCase().trim(); canon.set(n, [...(canon.get(n) ?? []), v.trim().replace(/\s+/g, ' ')]) }
  const names = [...canon.keys()].sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names.map((n) => `${n}:${canon.get(n)!.join(',')}\n`).join('')
  // S3 uses the path as is; other services encode each segment once more.
  const path = k.service === 's3' ? (url.pathname || '/') : (url.pathname || '/').split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/')
  const query = [...url.searchParams].map(([a, b]) => [rfc3986(a), rfc3986(b)] as const)
    .sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1)).map(([a, b]) => `${a}=${b}`).join('&')
  const canonicalRequest = [p.method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${day}/${k.region}/${k.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, toHex(await sha256(canonicalRequest))].join('\n')
  let key: ArrayBuffer = await hmac('SHA-256', `AWS4${k.secretKey}`, day)
  for (const part of [k.region, k.service, 'aws4_request']) key = await hmac('SHA-256', key, part)
  const signature = toHex(await hmac('SHA-256', key, toSign))
  return {
    ...p,
    headers: [...headers, ...add.filter(([h]) => h !== 'Host'),
      ['Authorization', `AWS4-HMAC-SHA256 Credential=${k.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`]],
  }
}

// ---------- Digest ----------

export function parseChallenge(header: string): Record<string, string> | null {
  const m = header.match(/^\s*Digest\s+(.*)$/i)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const part of m[1].matchAll(/([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi)) out[part[1].toLowerCase()] = part[2] ?? part[3]
  return out
}

/** The Authorization header answering a Digest challenge (RFC 7616: MD5, MD5-sess, SHA-256; qop auth). */
export async function digestHeader(ch: Record<string, string>, method: string, url: string, user: string, pass: string, cnonce = Math.random().toString(36).slice(2, 14), nc = '00000001'): Promise<string> {
  const alg = (ch.algorithm ?? 'MD5').toUpperCase()
  const H = async (s: string) => (alg.startsWith('SHA-256') ? toHex(await sha256(s)) : md5(s))
  const u = new URL(url)
  const uri = u.pathname + u.search
  let ha1 = await H(`${user}:${ch.realm ?? ''}:${pass}`)
  if (alg.endsWith('-SESS')) ha1 = await H(`${ha1}:${ch.nonce}:${cnonce}`)
  const ha2 = await H(`${method}:${uri}`)
  const qop = ch.qop?.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : undefined
  const response = await H(qop ? `${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}` : `${ha1}:${ch.nonce}:${ha2}`)
  const parts = [`username="${user}"`, `realm="${ch.realm ?? ''}"`, `nonce="${ch.nonce}"`, `uri="${uri}"`, `algorithm=${ch.algorithm ?? 'MD5'}`, `response="${response}"`]
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`)
  return `Digest ${parts.join(', ')}`
}

// ---------- OAuth 2 ----------

export interface TokenResult { accessToken: string; refreshToken: string; expiresAt: number; raw: Record<string, unknown> }

/** Fills {{variables}} in the auth fields. */
export function fillAuth(a: Auth, fill: (s: string) => string): Auth {
  const out = { ...a }
  for (const k of Object.keys(out) as (keyof Auth)[]) if (typeof out[k] === 'string') (out as Record<string, unknown>)[k] = fill(out[k] as string)
  return out
}

async function tokenRequest(a: Auth, params: Record<string, string>, transport: Transport, opts: SendOptions): Promise<TokenResult> {
  if (!a.tokenUrl) throw new SendError('Set the token URL first.')
  const body = new URLSearchParams(params)
  const headers: [string, string][] = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']]
  if (a.clientAuth === 'header' && a.clientId) headers.push(['Authorization', `Basic ${btoa(`${encodeURIComponent(a.clientId)}:${encodeURIComponent(a.clientSecret)}`)}`])
  else { if (a.clientId) body.set('client_id', a.clientId); if (a.clientSecret) body.set('client_secret', a.clientSecret) }
  if (a.scope && !body.has('scope') && params.grant_type !== 'authorization_code') body.set('scope', a.scope)
  const res = await transport.send({ method: 'POST', url: a.tokenUrl, headers, body: body.toString(), unresolved: [] }, opts)
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(res.body) } catch {
    // Some servers answer form-encoded.
    json = Object.fromEntries(new URLSearchParams(res.body))
  }
  if (res.status >= 400 || !json.access_token) {
    const why = json.error_description ?? json.error ?? `${res.status} ${res.statusText}`
    throw new SendError(`The token server said no: ${String(why)}`)
  }
  const expires = Number(json.expires_in)
  return {
    accessToken: String(json.access_token), refreshToken: String(json.refresh_token ?? a.refreshToken ?? ''),
    expiresAt: Number.isFinite(expires) && expires > 0 ? Date.now() + expires * 1000 : 0, raw: json,
  }
}

export function getClientToken(a: Auth, t: Transport, o: SendOptions) {
  return a.grant === 'password'
    ? tokenRequest(a, { grant_type: 'password', username: a.username, password: a.password }, t, o)
    : tokenRequest(a, { grant_type: 'client_credentials' }, t, o)
}
export function refreshToken(a: Auth, t: Transport, o: SendOptions, extra: Record<string, string> = {}) {
  return tokenRequest(a, { grant_type: 'refresh_token', refresh_token: a.refreshToken, ...extra }, t, o)
}

export interface AuthCodeStart { url: string; state: string; verifier: string }

/** The authorization URL to open (with PKCE when on). */
export async function startAuthCode(a: Auth): Promise<AuthCodeStart> {
  if (!a.authUrl) throw new SendError('Set the authorization URL first.')
  const rand = (n: number) => b64url(globalThis.crypto.getRandomValues(new Uint8Array(n)))
  const state = rand(12)
  const verifier = rand(32)
  const u = new URL(a.authUrl)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', a.clientId)
  if (a.redirectUri) u.searchParams.set('redirect_uri', a.redirectUri)
  if (a.scope) u.searchParams.set('scope', a.scope)
  u.searchParams.set('state', state)
  if (a.usePkce) {
    u.searchParams.set('code_challenge', b64url(await sha256(verifier)))
    u.searchParams.set('code_challenge_method', 'S256')
  }
  return { url: u.toString(), state, verifier }
}

/** Takes the URL the browser landed on after login (or just the code) and swaps the code for a token. */
export async function finishAuthCode(a: Auth, start: AuthCodeStart, landed: string, t: Transport, o: SendOptions, extra: Record<string, string> = {}): Promise<TokenResult> {
  let code = landed.trim()
  if (/^https?:|^[a-z][a-z0-9+.-]*:\/\//i.test(code) || code.startsWith('?')) {
    const q = new URL(code.startsWith('?') ? `http://x/${code}` : code).searchParams
    if (q.get('error')) throw new SendError(`Login failed: ${q.get('error_description') ?? q.get('error')}`)
    if (q.get('state') && q.get('state') !== start.state) throw new SendError('The login response doesn’t match this request (state mismatch). Start again.')
    code = q.get('code') ?? ''
  }
  if (!code) throw new SendError('No authorization code found in that URL.')
  const params: Record<string, string> = { grant_type: 'authorization_code', code }
  if (a.redirectUri) params.redirect_uri = a.redirectUri
  if (a.usePkce) params.code_verifier = start.verifier
  return tokenRequest(a, { ...params, ...extra }, t, o)
}

// ---------- pipeline ----------

/** Adds JWT/AWS signing, OAuth 2 refresh and the Digest round trip to a pipeline. */
export function authPipeline(base: Pipeline, transport: Transport, sendOpts?: () => SendOptions): Pipeline {
  const resolved = (req: RequestDef, ctx: RunContext) => {
    const a = effectiveAuth(req, ctx.collection, folderChain(ctx.folders, req.folderId))
    if (!a) return null
    const scope = scopeFor(prepareContext(ctx, req))
    return fillAuth(a, (s) => interpolate(s, scope))
  }
  return {
    ...base,
    async sign(p, req, ctx, ex) {
      let out = base.sign ? await base.sign(p, req, ctx, ex) : p
      const a = resolved(req, ctx)
      if (!a) return out
      const noAuthHeader = !out.headers.some(([k]) => k.toLowerCase() === 'authorization')
      if (a.kind === 'jwt' && noAuthHeader) {
        out = { ...out, headers: [...out.headers, ['Authorization', `${a.headerPrefix ? `${a.headerPrefix} ` : ''}${await signJwt(a)}`]] }
      } else if (a.kind === 'awsv4') {
        out = await signAwsV4(out, a)
      } else if (a.kind === 'oauth2' && a.refreshToken && a.expiresAt && a.expiresAt < Date.now() + 10_000) {
        // Expired: refresh for this send (the auth tab's "Get new token" saves a new one).
        const t = await refreshToken(a, transport, sendOpts?.() ?? { timeoutMs: 30_000, followRedirects: true, insecureTls: false })
        out = { ...out, headers: [...out.headers.filter(([k]) => k.toLowerCase() !== 'authorization'), ['Authorization', `Bearer ${t.accessToken}`]] }
        // Save the new token where the auth lives, and let later requests in this run reuse it.
        const patch = { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt }
        const folder = folderChain(ctx.folders, req.folderId).find((f) => f.auth.kind !== 'inherit')
        if (req.auth.kind !== 'inherit') ex.authUpdate = { owner: 'request', id: req.id, patch }
        else if (folder) {
          ex.authUpdate = { owner: 'folder', id: folder.id, patch }
          ctx.folders = ctx.folders.map((f) => (f.id === folder.id ? { ...f, auth: { ...f.auth, ...patch } } : f))
        } else if (ctx.collection) {
          ex.authUpdate = { owner: 'collection', id: ctx.collection.id, patch }
          ctx.collection = { ...ctx.collection, auth: { ...ctx.collection.auth, ...patch } }
        }
        ex.logs.push({ level: 'info', at: Date.now(), source: 'auth', text: 'OAuth 2 token expired; got a new one with the refresh token.' })
      }
      return out
    },
    async retry(p, res, req, ctx, send) {
      const prev = base.retry ? await base.retry(p, res, req, ctx, send) : null
      const r: HttpResponse = prev?.response ?? res
      const a = resolved(req, ctx)
      if (!a || a.kind !== 'digest' || r.status !== 401) return prev
      const www = r.headers.filter(([k]) => k.toLowerCase() === 'www-authenticate').map(([, v]) => v).find((v) => /^\s*digest/i.test(v))
      const ch = www ? parseChallenge(www) : null
      if (!ch) return prev
      const sent: PreparedRequest = { ...p, headers: [...p.headers.filter(([k]) => k.toLowerCase() !== 'authorization'), ['Authorization', await digestHeader(ch, p.method, p.url, a.username, a.password)]] }
      return { sent, response: await send(sent) }
    },
  }
}
