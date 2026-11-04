/**
 * Other tools' formats: export a collection as Postman v2.1 (and environments as Postman environments), import
 * Insomnia v4 exports and Bruno collection folders (.bru files).
 */
import type { Auth, Collection, Environment, Folder, KV, Method, RequestDef } from './types'
import { METHODS, bySort, emptyAuth, emptyBody, kv, newCollection, newEnvironment, newFolder, newRequest, uid } from './types'
import { paramsFromUrl, splitUrl } from './url'
import { pathVarsFromUrl } from './prepare'
import type { ImportResult } from './backup'

type Obj = Record<string, any>

// ---------- Postman export ----------

function pmAuth(a: Auth): Obj | undefined {
  const list = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value, type: 'string' }))
  switch (a.kind) {
    case 'inherit': return undefined
    case 'none': return { type: 'noauth' }
    case 'basic': return { type: 'basic', basic: list({ username: a.username, password: a.password }) }
    case 'digest': return { type: 'digest', digest: list({ username: a.username, password: a.password }) }
    case 'bearer': return { type: 'bearer', bearer: list({ token: a.token }) }
    case 'apikey': return { type: 'apikey', apikey: list({ key: a.key, value: a.value, in: a.in }) }
    case 'jwt': return { type: 'jwt', jwt: list({ algorithm: a.algorithm, secret: a.secret, payload: a.payload, headerPrefix: a.headerPrefix, addTokenTo: 'header' }) }
    case 'awsv4': return { type: 'awsv4', awsv4: list({ accessKey: a.accessKey, secretKey: a.secretKey, sessionToken: a.sessionToken, region: a.region, service: a.service }) }
    case 'oauth2': return { type: 'oauth2', oauth2: list({
      grant_type: a.grant === 'password' ? 'password_credentials' : a.grant === 'authorization_code' ? (a.usePkce ? 'authorization_code_with_pkce' : 'authorization_code') : 'client_credentials',
      accessTokenUrl: a.tokenUrl, authUrl: a.authUrl, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope,
      redirect_uri: a.redirectUri, client_authentication: a.clientAuth, username: a.username, password: a.password,
    }) }
  }
}
const pmEvents = (s: { pre: string; post: string }) => {
  const ev: Obj[] = []
  if (s.pre.trim()) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: s.pre.split('\n') } })
  if (s.post.trim()) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: s.post.split('\n') } })
  return ev.length ? ev : undefined
}
const pmVars = (rows: KV[]) => rows.filter((v) => v.key.trim()).map((v) => ({ key: v.key, value: v.secret ? '' : v.value, ...(v.enabled ? {} : { disabled: true }), ...(v.secret ? { type: 'secret' } : {}) }))
const pmKv = (rows: KV[]) => rows.filter((v) => v.key.trim()).map((v) => ({ key: v.key, value: v.value, ...(v.enabled ? {} : { disabled: true }), ...(v.description ? { description: v.description } : {}) }))

function pmRequest(r: RequestDef): Obj {
  const { base } = splitUrl(r.url)
  const url: Obj = { raw: r.url, query: pmKv(r.params) }
  if (r.pathVars.length) url.variable = pmKv(r.pathVars)
  const m = base.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]*)(\/.*)?$/i)
  if (m) { if (m[1]) url.protocol = m[1]; url.host = m[2] ? m[2].split('.') : []; url.path = (m[3] ?? '').split('/').filter(Boolean) }
  const b = r.body
  let body: Obj | undefined
  if (['json', 'text', 'xml', 'html'].includes(b.kind)) body = { mode: 'raw', raw: b.text, options: { raw: { language: b.kind === 'text' ? 'text' : b.kind } } }
  else if (b.kind === 'urlencoded') body = { mode: 'urlencoded', urlencoded: pmKv(b.fields) }
  else if (b.kind === 'formdata') body = { mode: 'formdata', formdata: b.fields.filter((f) => f.key.trim()).map((f) => (f.type === 'file' ? { key: f.key, type: 'file', src: f.file?.name ?? '' } : { key: f.key, value: f.value, type: 'text', ...(f.enabled ? {} : { disabled: true }) })) }
  else if (b.kind === 'graphql') body = { mode: 'graphql', graphql: { query: b.text, variables: b.graphqlVariables } }
  else if (b.kind === 'binary') body = { mode: 'file', file: { src: b.file?.name ?? '' } }
  return {
    method: r.method, header: pmKv(r.headers), url,
    ...(body ? { body } : {}), ...(pmAuth(r.auth) ? { auth: pmAuth(r.auth) } : {}), ...(r.docs.trim() ? { description: r.docs } : {}),
  }
}

/** A Postman v2.1 collection. Secret variable values are left out; binary/form files are referenced by name only. */
export function toPostmanCollection(c: Collection, folders: Folder[], requests: RequestDef[]): string {
  const items = (parent: string | null): Obj[] => {
    const fs = folders.filter((f) => f.collectionId === c.id && f.parentId === parent).map((f) => ({ sort: f.sort, name: f.name, item: () => ({
      name: f.name, item: items(f.id), ...(f.docs.trim() ? { description: f.docs } : {}), ...(pmAuth(f.auth) ? { auth: pmAuth(f.auth) } : {}), ...(pmEvents(f.scripts) ? { event: pmEvents(f.scripts) } : {}),
    }) }))
    const rs = requests.filter((r) => r.collectionId === c.id && (r.folderId ?? null) === parent && r.protocol === 'http').map((r) => ({ sort: r.sort, name: r.name, item: () => ({
      name: r.name, request: pmRequest(r), ...(pmEvents(r.scripts) ? { event: pmEvents(r.scripts) } : {}),
      response: r.examples.map((e) => ({ name: e.name, code: e.status, status: '', header: e.headers.map(([key, value]) => ({ key, value })), body: e.body, originalRequest: pmRequest(r) })),
    }) }))
    return [...fs, ...rs].sort(bySort).map((x) => x.item())
  }
  return JSON.stringify({
    info: { _postman_id: uid(), name: c.name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', ...(c.docs.trim() ? { description: c.docs } : {}) },
    item: items(null),
    ...(pmAuth(c.auth) ? { auth: pmAuth(c.auth) } : {}),
    ...(pmEvents(c.scripts) ? { event: pmEvents(c.scripts) } : {}),
    variable: pmVars(c.variables),
  }, null, 2)
}

export function toPostmanEnvironment(e: Environment): string {
  return JSON.stringify({ id: uid(), name: e.name, _postman_variable_scope: 'environment', values: e.variables.filter((v) => v.key.trim()).map((v) => ({ key: v.key, value: v.secret ? '' : v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled })) }, null, 2)
}

// ---------- Insomnia v4 ----------

export const isInsomnia = (d: any) => d?._type === 'export' && Array.isArray(d.resources) && String(d.__export_source ?? '').includes('insomnia')

const insomniaVars = (s: string) => s.replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}') // {{ _.base }} → {{base}}

export function importInsomnia(d: Obj): ImportResult {
  const warnings: string[] = []
  const res: Obj[] = d.resources
  const workspace = res.find((r) => r._type === 'workspace')
  const col = newCollection(workspace?.name || 'Insomnia import')
  const folders: Folder[] = []
  const folderIds = new Map<string, string>()
  const requests: RequestDef[] = []
  const environments: Environment[] = []
  // Base environment → collection variables; sub-environments → environments.
  const baseEnv = res.find((r) => r._type === 'environment' && r.parentId === workspace?._id)
  const envVars = (data: Obj | undefined) => Object.entries(data ?? {}).map(([k, v]) => kv(k, typeof v === 'string' ? insomniaVars(v) : JSON.stringify(v)))
  col.variables = envVars(baseEnv?.data)
  for (const e of res.filter((r) => r._type === 'environment' && r.parentId === baseEnv?._id)) environments.push({ ...newEnvironment(e.name || 'Environment'), variables: envVars(e.data) })
  const groups = res.filter((r) => r._type === 'request_group')
  // Groups may come in any order; resolve parents iteratively.
  for (let pass = 0; pass < 10 && folderIds.size < groups.length; pass++) {
    for (const g of groups) {
      if (folderIds.has(g._id)) continue
      const parentKnown = g.parentId === workspace?._id || folderIds.has(g.parentId)
      if (!parentKnown) continue
      const f = newFolder(col.id, g.name || 'Folder', g.parentId === workspace?._id ? null : folderIds.get(g.parentId)!)
      f.sort = Number(g.metaSortKey) || 0
      f.docs = g.description ?? ''
      folders.push(f); folderIds.set(g._id, f.id)
    }
  }
  const auth = (a: Obj | undefined): Auth => {
    if (!a || !a.type) return emptyAuth('inherit')
    if (a.disabled) return emptyAuth('none')
    switch (a.type) {
      case 'basic': return { ...emptyAuth('basic'), username: insomniaVars(a.username ?? ''), password: insomniaVars(a.password ?? '') }
      case 'digest': return { ...emptyAuth('digest'), username: insomniaVars(a.username ?? ''), password: insomniaVars(a.password ?? '') }
      case 'bearer': return { ...emptyAuth('bearer'), token: insomniaVars(a.token ?? '') }
      case 'apikey': return { ...emptyAuth('apikey'), key: a.key ?? '', value: insomniaVars(a.value ?? ''), in: a.addTo === 'queryParams' ? 'query' : 'header' }
      case 'none': return emptyAuth('none')
      default: warnings.push(`${a.type} auth isn’t imported from Insomnia; set it up again.`); return emptyAuth('none')
    }
  }
  for (const r of res.filter((x) => x._type === 'request')) {
    const method = String(r.method ?? 'GET').toUpperCase() as Method
    if (!METHODS.includes(method)) { warnings.push(`${r.name}: method ${method} isn’t supported.`); continue }
    const url = insomniaVars(r.url ?? '')
    const req = newRequest({ name: r.name || url, method, url, collectionId: col.id, folderId: folderIds.get(r.parentId) ?? null, sort: Number(r.metaSortKey) || 0 })
    const qs = (r.parameters ?? []).map((p: Obj) => kv(p.name, insomniaVars(p.value ?? ''), !p.disabled))
    req.params = [...paramsFromUrl(url, []), ...qs]
    if (qs.some((p: KV) => p.enabled)) req.url = `${url}${url.includes('?') ? '&' : '?'}${qs.filter((p: KV) => p.enabled).map((p: KV) => `${p.key}=${p.value}`).join('&')}`
    req.pathVars = pathVarsFromUrl(req.url, [])
    req.headers = (r.headers ?? []).map((h: Obj) => kv(h.name, insomniaVars(h.value ?? ''), !h.disabled))
    req.auth = auth(r.authentication)
    req.docs = r.description ?? ''
    const b = r.body ?? {}
    const mt = String(b.mimeType ?? '')
    if (mt === 'application/json') req.body = { ...emptyBody('json'), text: insomniaVars(b.text ?? '') }
    else if (mt === 'application/x-www-form-urlencoded') req.body = { ...emptyBody('urlencoded'), fields: (b.params ?? []).map((p: Obj) => kv(p.name, insomniaVars(p.value ?? ''), !p.disabled)) }
    else if (mt === 'multipart/form-data') req.body = { ...emptyBody('formdata'), fields: (b.params ?? []).map((p: Obj) => kv(p.name, p.type === 'file' ? '' : insomniaVars(p.value ?? ''), !p.disabled, { type: p.type === 'file' ? 'file' : 'text', file: null })) }
    else if (mt === 'application/graphql') { try { const g = JSON.parse(b.text ?? '{}'); req.body = { ...emptyBody('graphql'), text: g.query ?? '', graphqlVariables: g.variables ? JSON.stringify(g.variables, null, 2) : '' } } catch { req.body = { ...emptyBody('text'), text: b.text ?? '' } } }
    else if (mt.includes('xml')) req.body = { ...emptyBody('xml'), text: b.text ?? '' }
    else if (b.text) req.body = { ...emptyBody('text'), text: insomniaVars(b.text) }
    requests.push(req)
  }
  const other = new Set(res.map((r) => r._type).filter((t) => !['workspace', 'environment', 'request_group', 'request', 'cookie_jar', 'api_spec'].includes(t)))
  if (other.size) warnings.push(`Skipped Insomnia items: ${[...other].join(', ')}.`)
  return { source: 'insomnia', collections: [col], folders, requests, environments, warnings }
}

// ---------- Bruno ----------

/** Splits a .bru file into its blocks: "name { … }". Dictionary blocks become key/value maps; text blocks stay text. */
export function parseBru(text: string): Map<string, string> {
  const blocks = new Map<string, string>()
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w:-]+)\s*\{\s*$/)
    if (!m) continue
    const body: string[] = []
    i++
    while (i < lines.length && lines[i] !== '}') body.push(lines[i++])
    blocks.set(m[1], body.map((l) => l.replace(/^ {2}/, '')).join('\n'))
  }
  return blocks
}

const bruDict = (s: string | undefined): KV[] => (s ?? '').split('\n').filter((l) => l.trim()).map((l) => {
  const off = l.trimStart().startsWith('~')
  const t = l.trim().replace(/^~/, '')
  const i = t.indexOf(':')
  return kv(i >= 0 ? t.slice(0, i).trim() : t, i >= 0 ? t.slice(i + 1).trim() : '', !off)
})
const bruGet = (s: string | undefined, key: string) => bruDict(s).find((k) => k.key === key)?.value ?? ''

export interface BruFile { path: string; text: string }

/** Imports a Bruno collection folder (bruno.json, *.bru requests, folder.bru, environments/*.bru). */
export function importBruno(files: BruFile[]): ImportResult {
  const warnings: string[] = []
  const norm = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/') }))
  const rootFile = norm.find((f) => /(^|\/)bruno\.json$/.test(f.path))
  const root = rootFile ? rootFile.path.replace(/bruno\.json$/, '') : (norm[0]?.path.split('/').slice(0, -1).join('/') ?? '') + '/'
  let name = 'Bruno import'
  if (rootFile) { try { name = JSON.parse(rootFile.text).name || name } catch { /* keep */ } }
  const col = newCollection(name)
  const folders = new Map<string, Folder>()
  const folderFor = (dir: string): string | null => {
    if (!dir) return null
    if (folders.has(dir)) return folders.get(dir)!.id
    const parts = dir.split('/')
    const parent = folderFor(parts.slice(0, -1).join('/'))
    const f = newFolder(col.id, parts[parts.length - 1], parent)
    folders.set(dir, f)
    return f.id
  }
  const environments: Environment[] = []
  const requests: RequestDef[] = []
  const auth = (blocks: Map<string, string>, mode: string): Auth => {
    switch (mode) {
      case 'basic': return { ...emptyAuth('basic'), username: bruGet(blocks.get('auth:basic'), 'username'), password: bruGet(blocks.get('auth:basic'), 'password') }
      case 'digest': return { ...emptyAuth('digest'), username: bruGet(blocks.get('auth:digest'), 'username'), password: bruGet(blocks.get('auth:digest'), 'password') }
      case 'bearer': return { ...emptyAuth('bearer'), token: bruGet(blocks.get('auth:bearer'), 'token') }
      case 'awsv4': { const b = blocks.get('auth:awsv4'); return { ...emptyAuth('awsv4'), accessKey: bruGet(b, 'accessKeyId'), secretKey: bruGet(b, 'secretAccessKey'), sessionToken: bruGet(b, 'sessionToken'), region: bruGet(b, 'region'), service: bruGet(b, 'service') } }
      case 'none': return emptyAuth('none')
      case 'inherit': case '': return emptyAuth('inherit')
      default: warnings.push(`${mode} auth isn’t imported from Bruno; set it up again.`); return emptyAuth('none')
    }
  }
  for (const f of norm) {
    const rel = f.path.startsWith(root) ? f.path.slice(root.length) : f.path
    if (!rel.endsWith('.bru')) continue
    const blocks = parseBru(f.text)
    if (rel.startsWith('environments/')) {
      environments.push({ ...newEnvironment(rel.replace(/^environments\//, '').replace(/\.bru$/, '')), variables: [...bruDict(blocks.get('vars')), ...bruDict(blocks.get('vars:secret')).map((v) => ({ ...v, secret: true, value: '' }))] })
      continue
    }
    if (rel === 'collection.bru' || rel.endsWith('/folder.bru')) {
      const target = rel === 'collection.bru' ? null : folders.get(rel.replace(/\/folder\.bru$/, ''))
      const scripts = { pre: blocks.get('script:pre-request') ?? '', post: [blocks.get('script:post-response'), blocks.get('tests')].filter(Boolean).join('\n\n') }
      if (rel === 'collection.bru') { col.scripts = scripts; col.docs = blocks.get('docs') ?? ''; col.variables = bruDict(blocks.get('vars:pre-request')); const a = auth(blocks, bruGet(blocks.get('auth'), 'mode')); if (a.kind !== 'inherit') col.auth = a }
      else if (target) { target.scripts = scripts; target.docs = blocks.get('docs') ?? '' }
      else { folderFor(rel.replace(/\/folder\.bru$/, '')); const t2 = folders.get(rel.replace(/\/folder\.bru$/, ''))!; t2.scripts = scripts; t2.docs = blocks.get('docs') ?? ''; t2.sort = Number(bruGet(blocks.get('meta'), 'seq')) || 0 }
      continue
    }
    const meta = blocks.get('meta')
    const type = bruGet(meta, 'type') || 'http'
    const verbBlock = [...blocks.keys()].find((k) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k))
    if (!verbBlock) { if (type !== 'http') warnings.push(`${rel}: ${type} requests aren’t imported.`); continue }
    const v = blocks.get(verbBlock)
    const url = bruGet(v, 'url')
    const dir = rel.split('/').slice(0, -1).join('/')
    const req = newRequest({
      name: bruGet(meta, 'name') || rel.replace(/\.bru$/, ''), method: verbBlock.toUpperCase() as Method, url,
      collectionId: col.id, folderId: folderFor(dir), sort: Number(bruGet(meta, 'seq')) || 0,
    })
    req.params = [...paramsFromUrl(url, []), ...bruDict(blocks.get('params:query')).filter((p) => !p.enabled)]
    req.pathVars = bruDict(blocks.get('params:path'))
    req.headers = bruDict(blocks.get('headers'))
    req.auth = auth(blocks, bruGet(v, 'auth'))
    const bodyMode = bruGet(v, 'body')
    if (bodyMode === 'json') req.body = { ...emptyBody('json'), text: blocks.get('body:json') ?? '' }
    else if (bodyMode === 'text') req.body = { ...emptyBody('text'), text: blocks.get('body:text') ?? '' }
    else if (bodyMode === 'xml') req.body = { ...emptyBody('xml'), text: blocks.get('body:xml') ?? '' }
    else if (bodyMode === 'formUrlEncoded') req.body = { ...emptyBody('urlencoded'), fields: bruDict(blocks.get('body:form-urlencoded')) }
    else if (bodyMode === 'multipartForm') req.body = { ...emptyBody('formdata'), fields: bruDict(blocks.get('body:multipart-form')).map((x) => (x.value.startsWith('@file(') ? { ...x, value: '', type: 'file' as const, file: null } : { ...x, type: 'text' as const })) }
    else if (bodyMode === 'graphql') req.body = { ...emptyBody('graphql'), text: blocks.get('body:graphql') ?? '', graphqlVariables: blocks.get('body:graphql:vars') ?? '' }
    req.scripts = { pre: blocks.get('script:pre-request') ?? '', post: [blocks.get('script:post-response'), blocks.get('tests')].filter(Boolean).join('\n\n') }
    req.docs = blocks.get('docs') ?? ''
    if ([...blocks.keys()].some((k) => k.startsWith('assert'))) warnings.push(`${req.name}: Bruno assertions aren’t imported; write them as tests.`)
    if (req.scripts.post.includes('res.') || req.scripts.pre.includes('bru.')) warnings.push(`${req.name}: Bruno's script API (bru., res.) differs from pm.; review the scripts.`)
    requests.push(req)
  }
  if (!requests.length && !environments.length) throw new Error('No Bruno requests found. Choose the collection folder (the one with bruno.json).')
  return { source: 'bruno', collections: [col], folders: [...folders.values()], requests, environments, warnings: [...new Set(warnings)] }
}
