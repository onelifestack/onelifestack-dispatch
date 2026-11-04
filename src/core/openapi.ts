/**
 * Imports OpenAPI 3.x / Swagger 2.0 specs and HAR captures into a collection.
 * OpenAPI: one request per operation, folders by tag, {{baseUrl}} from servers, path params as :vars, sample
 * bodies from examples or schemas, auth from security schemes, response examples kept.
 * HAR: one request per entry, with its recorded response saved as an example.
 */
import type { Auth, Example, Folder, KV, Method, RequestDef } from './types'
import { METHODS, emptyAuth, emptyBody, kv, newCollection, newFolder, newRequest, uid } from './types'
import { paramsFromUrl } from './url'
import type { ImportResult } from './backup'

type Obj = Record<string, any>

const str = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/** Follows a local $ref ("#/components/schemas/Pet"). */
function deref(spec: Obj, v: any, seen = new Set<string>()): any {
  if (!v || typeof v !== 'object' || typeof v.$ref !== 'string') return v
  if (seen.has(v.$ref) || !v.$ref.startsWith('#/')) return {}
  seen.add(v.$ref)
  const target = v.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
  return deref(spec, target, seen)
}

/** A sample value for a schema: example, default, enum, or a typed placeholder. Depth-limited for recursive schemas. */
export function sampleFromSchema(spec: Obj, schema: any, depth = 0, seen = new Set<string>()): unknown {
  if (schema?.$ref) {
    if (seen.has(schema.$ref) || depth > 6) return {}
    return sampleFromSchema(spec, deref(spec, schema), depth + 1, new Set([...seen, schema.$ref]))
  }
  const s = schema ?? {}
  if (s.example !== undefined) return s.example
  if (s.examples && Array.isArray(s.examples) && s.examples.length) return s.examples[0]
  if (s.default !== undefined) return s.default
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: any) => sampleFromSchema(spec, x, depth + 1, seen)).filter((x: unknown) => x && typeof x === 'object'))
  if (s.oneOf || s.anyOf) return sampleFromSchema(spec, (s.oneOf ?? s.anyOf)[0], depth + 1, seen)
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type
  if (type === 'object' || s.properties) {
    if (depth > 6) return {}
    return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(spec, v, depth + 1, seen)]))
  }
  if (type === 'array') return depth > 6 ? [] : [sampleFromSchema(spec, s.items, depth + 1, seen)]
  if (type === 'integer' || type === 'number') return s.minimum ?? 0
  if (type === 'boolean') return true
  if (type === 'string') {
    const f = s.format
    return f === 'date-time' ? '2026-01-01T00:00:00Z' : f === 'date' ? '2026-01-01' : f === 'email' ? 'user@example.com' : f === 'uuid' ? '00000000-0000-4000-8000-000000000000' : f === 'uri' ? 'https://example.com' : 'string'
  }
  return null
}

function authFromScheme(spec: Obj, name: string, scheme: Obj | undefined, warnings: string[]): { auth: Auth; vars: KV[] } | null {
  const s = deref(spec, scheme)
  if (!s) return null
  if (s.type === 'http' && /^bearer$/i.test(s.scheme)) return { auth: { ...emptyAuth('bearer'), token: '{{bearerToken}}' }, vars: [kv('bearerToken', '', true, { secret: true })] }
  if ((s.type === 'http' && /^basic$/i.test(s.scheme)) || s.type === 'basic') return { auth: { ...emptyAuth('basic'), username: '{{username}}', password: '{{password}}' }, vars: [kv('username', ''), kv('password', '', true, { secret: true })] }
  if (s.type === 'http' && /^digest$/i.test(s.scheme)) return { auth: { ...emptyAuth('digest'), username: '{{username}}', password: '{{password}}' }, vars: [kv('username', ''), kv('password', '', true, { secret: true })] }
  if (s.type === 'apiKey') {
    if (s.in === 'cookie') { warnings.push(`Security scheme ${name}: cookie API keys aren’t set up automatically.`); return null }
    return { auth: { ...emptyAuth('apikey'), key: s.name, value: '{{apiKey}}', in: s.in === 'query' ? 'query' : 'header' }, vars: [kv('apiKey', '', true, { secret: true })] }
  }
  if (s.type === 'oauth2') {
    const flows = s.flows ?? {}
    const auth = { ...emptyAuth('oauth2'), clientId: '{{clientId}}', clientSecret: '{{clientSecret}}' }
    if (flows.clientCredentials) Object.assign(auth, { grant: 'client_credentials', tokenUrl: flows.clientCredentials.tokenUrl, scope: Object.keys(flows.clientCredentials.scopes ?? {}).join(' ') })
    else if (flows.authorizationCode) Object.assign(auth, { grant: 'authorization_code', tokenUrl: flows.authorizationCode.tokenUrl, authUrl: flows.authorizationCode.authorizationUrl, scope: Object.keys(flows.authorizationCode.scopes ?? {}).join(' ') })
    else if (flows.password) Object.assign(auth, { grant: 'password', tokenUrl: flows.password.tokenUrl, scope: Object.keys(flows.password.scopes ?? {}).join(' ') })
    else if (s.flow) Object.assign(auth, { grant: s.flow === 'application' ? 'client_credentials' : s.flow === 'password' ? 'password' : 'authorization_code', tokenUrl: s.tokenUrl ?? '', authUrl: s.authorizationUrl ?? '' })
    return { auth, vars: [kv('clientId', ''), kv('clientSecret', '', true, { secret: true })] }
  }
  if (s.type === 'http' && s.scheme) warnings.push(`Security scheme ${name}: HTTP ${s.scheme} isn’t supported.`)
  else if (s.type === 'openIdConnect') warnings.push(`Security scheme ${name}: OpenID Connect discovery isn’t supported; use OAuth 2 by hand.`)
  return null
}

export function isOpenApi(d: any) { return !!d && typeof d === 'object' && (typeof d.openapi === 'string' || d.swagger === '2.0') && d.paths }
export function isHar(d: any) { return !!d?.log && Array.isArray(d.log.entries) }

export function importOpenApi(spec: Obj): ImportResult {
  const warnings: string[] = []
  const v2 = spec.swagger === '2.0'
  const col = newCollection(str(spec.info?.title) || 'Imported API')
  col.docs = [spec.info?.description, spec.info?.version ? `Version ${spec.info.version}` : ''].filter(Boolean).join('\n\n')
  // Base URL
  let base = ''
  if (v2) base = `${(spec.schemes?.[0] ?? 'https')}://${spec.host ?? 'localhost'}${spec.basePath ?? ''}`
  else if (spec.servers?.[0]?.url) {
    const srv = spec.servers[0]
    base = String(srv.url).replace(/\{([^}]+)\}/g, (_: string, n: string) => str(srv.variables?.[n]?.default ?? n))
  }
  base = base.replace(/\/+$/, '')
  col.variables = [kv('baseUrl', base || 'http://localhost')]
  if (spec.servers?.length > 1) warnings.push(`The spec lists ${spec.servers.length} servers; baseUrl uses the first (${base}). Add an environment per server to switch.`)

  // Auth from global security.
  const schemes = v2 ? spec.securityDefinitions ?? {} : spec.components?.securitySchemes ?? {}
  const authFor = (sec: Obj[] | undefined) => {
    if (!sec) return null
    if (!sec.length) return { auth: emptyAuth('none'), vars: [] as KV[] }
    for (const req of sec) for (const name of Object.keys(req)) { const a = authFromScheme(spec, name, schemes[name], warnings); if (a) return a }
    return null
  }
  const global = authFor(spec.security)
  if (global) { col.auth = global.auth; col.variables.push(...global.vars) }

  const folders = new Map<string, Folder>()
  const tagOrder: string[] = (spec.tags ?? []).map((t: Obj) => t.name)
  const requests: RequestDef[] = []
  let position = 0
  for (const [path, item0] of Object.entries<Obj>(spec.paths ?? {})) {
    const item = deref(spec, item0) ?? {}
    for (const m of Object.keys(item)) {
      const method = m.toUpperCase() as Method
      if (!METHODS.includes(method)) { if (!['PARAMETERS', 'SUMMARY', 'DESCRIPTION', 'SERVERS', '$REF'].includes(method)) warnings.push(`${m.toUpperCase()} ${path}: method not supported; skipped.`); continue }
      const op = item[m] as Obj
      position++
      const tag = op.tags?.[0]
      let folderId: string | null = null
      if (tag) {
        if (!folders.has(tag)) { const f = newFolder(col.id, tag); f.sort = tagOrder.includes(tag) ? tagOrder.indexOf(tag) : 1000 + folders.size; f.docs = str(spec.tags?.find((t: Obj) => t.name === tag)?.description); folders.set(tag, f) }
        folderId = folders.get(tag)!.id
      }
      const params: Obj[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(spec, p))
      const value = (p: Obj) => str(p.example ?? p.schema?.example ?? p.schema?.default ?? p.default ?? (p.schema?.enum ?? p.enum)?.[0] ?? '')
      const url = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, ':$1')}`
      const req = newRequest({ name: str(op.summary || op.operationId) || `${method} ${path}`, method, url, collectionId: col.id, folderId, sort: position })
      req.pathVars = params.filter((p) => p.in === 'path').map((p) => kv(p.name, value(p), true, p.description ? { description: p.description } : {}))
      const query = params.filter((p) => p.in === 'query')
      req.params = query.map((p) => kv(p.name, value(p), !!p.required, p.description ? { description: p.description } : {}))
      req.url = `${url}${query.some((p) => p.required) ? `?${query.filter((p) => p.required).map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(value(p))}`).join('&')}` : ''}`
      req.params = [...paramsFromUrl(req.url, []), ...req.params.filter((p) => !p.enabled)]
      req.headers = params.filter((p) => p.in === 'header').map((p) => kv(p.name, value(p), !!p.required))
      req.docs = [op.description, op.deprecated ? '**Deprecated.**' : ''].filter(Boolean).join('\n\n')
      // Body
      if (v2) {
        const bodyParam = params.find((p) => p.in === 'body')
        const formParams = params.filter((p) => p.in === 'formData')
        if (bodyParam) { req.body = { ...emptyBody('json'), text: JSON.stringify(sampleFromSchema(spec, bodyParam.schema), null, 2) }; req.headers.push(kv('Content-Type', 'application/json')) }
        else if (formParams.length) req.body = { ...emptyBody(formParams.some((p) => p.type === 'file') ? 'formdata' : 'urlencoded'), fields: formParams.map((p) => kv(p.name, p.type === 'file' ? '' : value(p), true, { type: p.type === 'file' ? 'file' : 'text', file: null })) }
      } else if (op.requestBody) {
        const rb = deref(spec, op.requestBody)
        const content: Obj = rb?.content ?? {}
        const type = Object.keys(content).find((t) => t.includes('json')) ?? Object.keys(content)[0]
        const media = content[type] ?? {}
        const example = media.example ?? (media.examples ? deref(spec, Object.values<Obj>(media.examples)[0])?.value : undefined) ?? sampleFromSchema(spec, media.schema)
        if (type?.includes('json')) req.body = { ...emptyBody('json'), text: JSON.stringify(example, null, 2) }
        else if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
          const props = deref(spec, media.schema)?.properties ?? {}
          req.body = { ...emptyBody(type === 'multipart/form-data' ? 'formdata' : 'urlencoded'), fields: Object.entries<Obj>(props).map(([k, p]) => {
            const isFile = p.format === 'binary' || p.format === 'base64'
            return kv(k, isFile ? '' : str(sampleFromSchema(spec, p)), true, { type: isFile ? 'file' : 'text', file: null })
          }) }
        } else if (type?.includes('xml')) req.body = { ...emptyBody('xml'), text: typeof example === 'string' ? example : '' }
        else if (type === 'application/octet-stream') req.body = emptyBody('binary')
        else if (type) req.body = { ...emptyBody('text'), text: typeof example === 'string' ? example : str(example) }
        if (type && !type.includes('form') && type !== 'application/octet-stream' && !req.headers.some((h) => h.key.toLowerCase() === 'content-type')) req.headers.push(kv('Content-Type', type))
      }
      // Per-operation security
      const own = authFor(op.security)
      if (own) {
        req.auth = own.auth
        for (const v of own.vars) if (!col.variables.some((x) => x.key === v.key)) col.variables.push(v)
      }
      // Response examples
      req.examples = Object.entries<Obj>(op.responses ?? {}).flatMap(([code, r0]): Example[] => {
        const r = deref(spec, r0) ?? {}
        const status = Number(code) || 200
        if (v2) return r.examples?.['application/json'] !== undefined || r.schema ? [{ id: uid(), name: r.description || code, status, headers: [['Content-Type', 'application/json']], body: JSON.stringify(r.examples?.['application/json'] ?? sampleFromSchema(spec, r.schema), null, 2) }] : []
        const ct = Object.keys(r.content ?? {})[0]
        if (!ct) return []
        const media = r.content[ct]
        const ex = media.example ?? (media.examples ? deref(spec, Object.values<Obj>(media.examples)[0])?.value : undefined) ?? sampleFromSchema(spec, media.schema)
        return [{ id: uid(), name: r.description || code, status, headers: [['Content-Type', ct]], body: typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2) }]
      })
      requests.push(req)
    }
  }
  if (!requests.length) warnings.push('The spec has no operations.')
  return { source: 'openapi', collections: [col], folders: [...folders.values()], requests, environments: [], warnings: [...new Set(warnings)] }
}

export function importHar(har: Obj): ImportResult {
  const warnings: string[] = []
  const entries: Obj[] = har.log.entries ?? []
  const col = newCollection(str(har.log.pages?.[0]?.title) || 'HAR import')
  const requests: RequestDef[] = []
  const skipHeaders = /^(:|content-length$|host$|connection$|accept-encoding$)/i
  entries.forEach((e, i) => {
    const r = e.request ?? {}
    const method = String(r.method ?? 'GET').toUpperCase() as Method
    if (!METHODS.includes(method)) { warnings.push(`${method} ${r.url}: method not supported; skipped.`); return }
    let name = `${method} ${r.url}`
    try { const u = new URL(r.url); name = `${method} ${u.pathname}` } catch { /* keep */ }
    const req = newRequest({ name, method, url: str(r.url), collectionId: col.id, sort: i })
    req.params = paramsFromUrl(req.url, [])
    req.headers = (r.headers ?? []).filter((h: Obj) => !skipHeaders.test(h.name)).map((h: Obj) => kv(h.name, str(h.value)))
    const post = r.postData
    if (post) {
      const mt = String(post.mimeType ?? '')
      if (mt.includes('x-www-form-urlencoded') && Array.isArray(post.params)) req.body = { ...emptyBody('urlencoded'), fields: post.params.map((p: Obj) => kv(p.name, str(p.value))) }
      else if (mt.includes('multipart/form-data')) {
        req.body = { ...emptyBody('formdata'), fields: (post.params ?? []).map((p: Obj) => kv(p.name, p.fileName ? '' : str(p.value), true, { type: p.fileName ? 'file' : 'text', file: null })) }
        req.headers = req.headers.filter((h) => h.key.toLowerCase() !== 'content-type')
        if ((post.params ?? []).some((p: Obj) => p.fileName)) warnings.push(`${name}: uploaded files aren’t in the HAR; choose them again.`)
      } else req.body = { ...emptyBody(mt.includes('json') ? 'json' : mt.includes('xml') ? 'xml' : 'text'), text: str(post.text) }
    }
    const res = e.response
    if (res && res.status) {
      let body = str(res.content?.text)
      if (res.content?.encoding === 'base64') body = '(binary body not kept)'
      req.examples = [{ id: uid(), name: `Recorded ${res.status}`, status: Number(res.status), headers: (res.headers ?? []).map((h: Obj) => [h.name, str(h.value)] as [string, string]), body }]
    }
    requests.push(req)
  })
  if (entries.some((e) => (e.request?.headers ?? []).some((h: Obj) => /^(cookie|authorization)$/i.test(h.name)))) warnings.push('The capture includes cookies or Authorization headers; check them before sharing this collection.')
  return { source: 'har', collections: [col], folders: [], requests, environments: [], warnings }
}
