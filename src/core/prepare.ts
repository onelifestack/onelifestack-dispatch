import type { Auth, Collection, Environment, PreparedRequest, RequestDef } from './types'
import { interpolate, scopeOf } from './vars'
import { appendQuery, encodeComponent, withScheme } from './url'

export interface PrepareContext { collection?: Collection | null; environment?: Environment | null }

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** The auth that applies: "inherit" takes the collection's, or none outside a collection. */
export function effectiveAuth(req: RequestDef, collection?: Collection | null): Auth | null {
  if (req.auth.kind === 'inherit') return collection && collection.auth.kind !== 'inherit' ? collection.auth : null
  return req.auth
}

const has = (headers: [string, string][], name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase())

/** Applies variables, auth and the body to a request, giving exactly what goes on the wire. */
export function prepare(req: RequestDef, ctx: PrepareContext = {}): PreparedRequest {
  const scope = scopeOf(ctx.collection?.variables, ctx.environment?.variables)
  const missing = new Set<string>()
  const fill = (s: string) => interpolate(s, scope, missing)

  let url = withScheme(fill(req.url))
  const headers: [string, string][] = req.headers
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => [fill(h.key.trim()), fill(h.value)])

  const auth = effectiveAuth(req, ctx.collection)
  if (auth) {
    switch (auth.kind) {
      case 'basic':
        if (!has(headers, 'authorization')) headers.push(['Authorization', `Basic ${base64Utf8(`${fill(auth.username)}:${fill(auth.password)}`)}`])
        break
      case 'bearer':
        if (!has(headers, 'authorization') && auth.token) headers.push(['Authorization', `Bearer ${fill(auth.token)}`])
        break
      case 'apikey':
        if (auth.key) {
          if (auth.in === 'query') url = appendQuery(url, fill(auth.key), fill(auth.value))
          else if (!has(headers, auth.key)) headers.push([fill(auth.key), fill(auth.value)])
        }
        break
    }
  }

  let body: string | null = null
  const noBody = req.method === 'GET' || req.method === 'HEAD'
  if (!noBody || req.body.kind !== 'none') {
    switch (req.body.kind) {
      case 'json':
        body = fill(req.body.text)
        if (!has(headers, 'content-type')) headers.push(['Content-Type', 'application/json'])
        break
      case 'text':
        body = fill(req.body.text)
        if (!has(headers, 'content-type')) headers.push(['Content-Type', 'text/plain'])
        break
      case 'urlencoded':
        body = req.body.fields.filter((f) => f.enabled && f.key.trim())
          .map((f) => `${encodeComponent(fill(f.key.trim()))}=${encodeComponent(fill(f.value))}`)
          .join('&')
        // encodeComponent keeps {{x}} readable; after filling there are none left to protect except unresolved ones.
        if (!has(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded'])
        break
    }
  }
  if (req.method === 'HEAD') body = null

  return { method: req.method, url, headers, body, unresolved: [...missing] }
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
