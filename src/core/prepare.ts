import type { Auth, Collection, Environment, Folder, KV, PreparedPart, PreparedRequest, RequestDef } from './types'
import { kv } from './types'
import { interpolate, scopeOf } from './vars'
import { appendQuery, encodeComponent, splitUrl, withScheme } from './url'

export interface PrepareContext {
  collection?: Collection | null
  environment?: Environment | null
  /** The request's folder and its parents, nearest first. */
  folders?: Folder[]
  globals?: KV[]
  /** Data-file row for this iteration (runner). */
  data?: Record<string, string> | null
  /** Variables set by scripts for this run only. */
  locals?: Map<string, string> | null
}

/** Variable lookup for a request, lowest priority first: globals, collection, environment, data row, locals. */
export function scopeFor(ctx: PrepareContext): Map<string, string> {
  const scope = scopeOf(ctx.globals, ctx.collection?.variables, ctx.environment?.variables)
  if (ctx.data) for (const [k, v] of Object.entries(ctx.data)) scope.set(k, v)
  if (ctx.locals) for (const [k, v] of ctx.locals) scope.set(k, v)
  return scope
}

export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** The auth that applies: "inherit" walks up the folders, then the collection; none outside a collection. */
export function effectiveAuth(req: RequestDef, collection?: Collection | null, folders: Folder[] = []): Auth | null {
  if (req.auth.kind !== 'inherit') return req.auth
  for (const f of folders) if (f.auth.kind !== 'inherit') return f.auth
  return collection && collection.auth.kind !== 'inherit' ? collection.auth : null
}

const has = (headers: [string, string][], name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase())

/** The path part of a URL ("/users/:id"), without scheme, host, port, query or hash. */
function pathOf(url: string): string {
  const { base } = splitUrl(url)
  const m = base.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\{\{[^}]*\}\}|[^/])*(.*)$/i)
  return m ? m[1] : base
}

/** Names of :params in the URL path, in order. Ports ("host:8080") aren't path segments, so they're ignored. */
export function pathVarNames(url: string): string[] {
  return [...new Set([...pathOf(url).matchAll(/\/:([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]))]
}

/** The path-variable table after the URL changed: one row per :name, keeping existing values. */
export function pathVarsFromUrl(url: string, existing: KV[]): KV[] {
  return pathVarNames(url).map((name) => existing.find((p) => p.key === name) ?? kv(name, ''))
}

function fillPath(url: string, vars: KV[], fill: (s: string) => string): string {
  const { base, query, hash } = splitUrl(url)
  const m = base.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i)
  const origin = m ? m[1] : ''
  const path = m ? m[2] : base
  const filled = path.replace(/(^|\/):([A-Za-z_][A-Za-z0-9_-]*)/g, (whole, slash: string, name: string) => {
    const v = vars.find((p) => p.key === name)
    return v && v.value !== '' ? `${slash}${encodeComponent(fill(v.value))}` : whole
  })
  return origin + filled + (query ? `?${query}` : '') + hash
}

/** Applies variables, auth and the body to a request, giving exactly what goes on the wire (before signing). */
export function prepare(req: RequestDef, ctx: PrepareContext = {}): PreparedRequest {
  const scope = scopeFor(ctx)
  const missing = new Set<string>()
  const fill = (s: string) => interpolate(s, scope, missing)

  let url = withScheme(fill(fillPath(req.url, req.pathVars, fill)))
  const headers: [string, string][] = req.headers
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => [fill(h.key.trim()), fill(h.value)])

  const auth = effectiveAuth(req, ctx.collection, ctx.folders)
  if (auth) {
    switch (auth.kind) {
      case 'basic':
        if (!has(headers, 'authorization')) headers.push(['Authorization', `Basic ${base64Utf8(`${fill(auth.username)}:${fill(auth.password)}`)}`])
        break
      case 'bearer':
        if (!has(headers, 'authorization') && auth.token) headers.push(['Authorization', `Bearer ${fill(auth.token)}`])
        break
      case 'oauth2':
        if (!has(headers, 'authorization') && auth.accessToken) headers.push(['Authorization', `Bearer ${auth.accessToken}`])
        break
      case 'apikey':
        if (auth.key) {
          if (auth.in === 'query') url = appendQuery(url, fill(auth.key), fill(auth.value))
          else if (!has(headers, auth.key)) headers.push([fill(auth.key), fill(auth.value)])
        }
        break
      // jwt and awsv4 are signed in sign(); digest answers a 401 challenge in the send pipeline.
    }
  }

  let body: string | null = null
  let multipart: PreparedPart[] | null = null
  let bodyFile: PreparedRequest['bodyFile'] = null
  const ct = (v: string) => { if (!has(headers, 'content-type')) headers.push(['Content-Type', v]) }
  switch (req.body.kind) {
    case 'json': body = fill(req.body.text); ct('application/json'); break
    case 'text': body = fill(req.body.text); ct('text/plain'); break
    case 'xml': body = fill(req.body.text); ct('application/xml'); break
    case 'html': body = fill(req.body.text); ct('text/html'); break
    case 'urlencoded':
      body = req.body.fields.filter((f) => f.enabled && f.key.trim())
        .map((f) => `${encodeComponent(fill(f.key.trim()))}=${encodeComponent(fill(f.value))}`)
        .join('&')
      ct('application/x-www-form-urlencoded')
      break
    case 'formdata':
      // The transport sets Content-Type with the boundary.
      multipart = req.body.fields.filter((f) => f.enabled && f.key.trim()).map((f) => (
        f.type === 'file'
          ? { name: fill(f.key.trim()), file: f.file ? { name: f.file.name, type: f.file.type || 'application/octet-stream', base64: f.file.base64 } : { name: '', type: 'application/octet-stream', base64: '' } }
          : { name: fill(f.key.trim()), value: fill(f.value) }))
      break
    case 'binary':
      if (req.body.file) { bodyFile = { name: req.body.file.name, type: req.body.file.type, base64: req.body.file.base64 }; ct(req.body.file.type || 'application/octet-stream') }
      break
    case 'graphql': {
      let variables: unknown = undefined
      const vt = fill(req.body.graphqlVariables).trim()
      if (vt) { try { variables = JSON.parse(vt) } catch { variables = undefined } }
      body = JSON.stringify(variables === undefined ? { query: fill(req.body.text) } : { query: fill(req.body.text), variables })
      ct('application/json')
      break
    }
  }
  if (req.method === 'HEAD') { body = null; multipart = null; bodyFile = null }

  return { method: req.method, url, headers, body, multipart, bodyFile, unresolved: [...missing] }
}

/** Checks JSON body text; returns an error message or null. Bodies with {{variables}} are checked after a stand-in fill. */
export function jsonProblem(text: string): string | null {
  if (!text.trim()) return null
  try {
    JSON.parse(text.replace(/\{\{[^{}]*\}\}/g, '0'))
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
