/**
 * Mock routes from saved examples: each request's examples become responses for its method + path. Shared by the
 * desktop mock server (Rust serves what this produces) and `dispatch-run mock` (Node).
 */
import type { Collection, Folder, RequestDef } from './types'
import { bySort } from './types'
import { splitUrl } from './url'

export interface MockResponse { name: string; status: number; headers: [string, string][]; body: string }
export interface MockRoute { method: string; path: string; name: string; responses: MockResponse[]; delayMs: number }

/** "{{baseUrl}}/users/:id?x=1" → "/users/:id"; {{vars}} inside the path become :params. */
export function mockPath(url: string): string {
  let { base } = splitUrl(url)
  base = base.replace(/^\{\{[^}]+\}\}/, '') // leading {{baseUrl}}
  base = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') // scheme://host:port
  const path = base.startsWith('/') ? base : `/${base}`
  return path.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, ':$1').replace(/\/+$/, '') || '/'
}

export function buildRoutes(collection: Collection, folders: Folder[], requests: RequestDef[], delayMs = 0): MockRoute[] {
  const inCol = requests.filter((r) => r.collectionId === collection.id && r.protocol === 'http' && r.examples.length)
  const folderIds = new Set(folders.filter((f) => f.collectionId === collection.id).map((f) => f.id))
  return inCol.filter((r) => !r.folderId || folderIds.has(r.folderId)).sort(bySort).map((r) => ({
    method: r.method, path: mockPath(r.url), name: r.name, delayMs,
    responses: r.examples.map((e) => ({ name: e.name, status: e.status, headers: e.headers, body: e.body })),
  }))
}

export interface MockHit { route: MockRoute; response: MockResponse; params: Record<string, string> }

/** Matches a request. Pick a non-default example with the x-mock-response-name / -code header or ?__example=. */
export function matchRoute(routes: MockRoute[], method: string, target: string, headers: Record<string, string> = {}): MockHit | null {
  const [pathPart, query = ''] = target.split('?')
  const path = (pathPart.replace(/\/+$/, '') || '/')
  const segs = path.split('/')
  const candidates: { route: MockRoute; params: Record<string, string>; score: number }[] = []
  for (const route of routes) {
    if (route.method !== method.toUpperCase() && !(method.toUpperCase() === 'HEAD' && route.method === 'GET')) continue
    const rs = route.path.split('/')
    if (rs.length !== segs.length) continue
    const params: Record<string, string> = {}
    let score = 0
    let ok = true
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].startsWith(':')) { params[rs[i].slice(1)] = decodeURIComponent(segs[i]); continue }
      if (rs[i] !== segs[i]) { ok = false; break }
      score++ // literal segments win over params ("/users/me" beats "/users/:id")
    }
    if (ok) candidates.push({ route, params, score })
  }
  if (!candidates.length) return null
  const best = candidates.sort((a, b) => b.score - a.score)[0]
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const wantName = lower['x-mock-response-name'] ?? new URLSearchParams(query).get('__example') ?? null
  const wantCode = lower['x-mock-response-code'] ? Number(lower['x-mock-response-code']) : null
  const rs = best.route.responses
  const response = (wantName ? rs.find((r) => r.name === wantName) : undefined)
    ?? (wantCode ? rs.find((r) => r.status === wantCode) : undefined)
    ?? rs.find((r) => r.status >= 200 && r.status < 300) ?? rs[0]
  return { route: best.route, response, params: best.params }
}

/** The body with {{params}} from the path filled in (e.g. an example body mentioning {{id}}). */
export function fillMockBody(body: string, params: Record<string, string>): string {
  return body.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (w, n: string) => params[n] ?? w)
}
