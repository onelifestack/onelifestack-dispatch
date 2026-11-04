import type { Auth, Collection, Environment, Example, Folder, KV, Method, RequestDef, Scripts } from './types'
import { METHODS, emptyAuth, emptyBody, kv, newCollection, newEnvironment, newFolder, newRequest, normalizeCollection, normalizeFolder, normalizeRequest, uid } from './types'
import { paramsFromUrl } from './url'
import { importHar, importOpenApi, isHar, isOpenApi } from './openapi'
import { importInsomnia, isInsomnia } from './interop'

export interface Workspace { collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environments: Environment[]; globals?: KV[] }

export const FORMAT = 'onelifestack-dispatch'

/** Secret variable values never leave the device in a backup; the rows stay so you can refill them. */
const blankSecrets = (vars: KV[]) => vars.map((v) => (v.secret ? { ...v, value: '' } : v))

/** A JSON backup of everything saved. History is left out: it can hold responses with secrets. */
export function exportWorkspace(w: Workspace): string {
  return JSON.stringify({
    format: FORMAT, version: 2, exportedAt: new Date().toISOString(),
    collections: w.collections.map((c) => ({ ...c, variables: blankSecrets(c.variables) })),
    folders: w.folders,
    requests: w.requests,
    environments: w.environments.map((e) => ({ ...e, variables: blankSecrets(e.variables) })),
    globals: blankSecrets(w.globals ?? []),
  }, null, 2)
}

/** Exports one collection (with its folders and requests) as a Dispatch file. */
export function exportCollection(w: Workspace, collectionId: string): string {
  return exportWorkspace({
    collections: w.collections.filter((c) => c.id === collectionId),
    folders: w.folders.filter((f) => f.collectionId === collectionId),
    requests: w.requests.filter((r) => r.collectionId === collectionId),
    environments: [],
  })
}

export interface ImportResult extends Workspace {
  source: 'dispatch' | 'postman-collection' | 'postman-environment' | 'openapi' | 'har' | 'insomnia' | 'bruno'
  warnings: string[]
}

/**
 * Reads a Dispatch backup, a Postman collection (v2.0/v2.1) or a Postman environment.
 * Everything gets fresh ids, so importing the same file twice gives two copies instead of overwriting edits.
 */
export function importFile(text: string): ImportResult {
  let data: any
  try { data = JSON.parse(text) } catch { throw new Error('That file isn’t valid JSON (or OpenAPI YAML).') }
  return importData(data)
}

/** Like importFile, but also reads YAML (OpenAPI specs often are). The YAML parser loads only when needed. */
export async function importFileAsync(text: string): Promise<ImportResult> {
  try { JSON.parse(text) } catch {
    const { parse } = await import('yaml')
    let data: any
    try { data = parse(text) } catch { data = undefined }
    if (!data || typeof data !== 'object') throw new Error('That file isn’t valid JSON (or OpenAPI YAML).')
    return importData(data)
  }
  return importFile(text)
}

/** Imports an already-parsed file. */
export function importData(data: any): ImportResult {
  if (data?.format === FORMAT) return importDispatch(data)
  if (isOpenApi(data)) return importOpenApi(data)
  if (isHar(data)) return importHar(data)
  if (isInsomnia(data)) return importInsomnia(data)
  if ((data?.info?.schema && String(data.info.schema).includes('collection')) || (data?.info && Array.isArray(data?.item))) return importPostmanCollection(data)
  if (Array.isArray(data?.values) && (data?._postman_variable_scope === 'environment' || typeof data?.name === 'string')) return importPostmanEnvironment(data)
  throw new Error('Unrecognised file. Import a Dispatch backup, a Postman collection (v2.1) or environment, an Insomnia export, an OpenAPI 3 / Swagger 2 spec, or a HAR file. For Bruno, import the collection folder.')
}

function importDispatch(d: any): ImportResult {
  const ids = new Map<string, string>()
  const fresh = (old: string) => { if (!ids.has(old)) ids.set(old, uid()); return ids.get(old)! }
  const remap = (old: string | null | undefined) => (old ? (ids.get(old) ?? null) : null)
  const now = Date.now()
  const collections: Collection[] = (d.collections ?? []).map((c: Collection) => normalizeCollection({ ...c, id: fresh(c.id), updatedAt: now }))
  // Folders first get ids, then parents are remapped (a parent may come after its child in the file).
  const rawFolders: Folder[] = d.folders ?? []
  rawFolders.forEach((f) => fresh(f.id))
  const folders: Folder[] = rawFolders
    .filter((f) => ids.has(f.collectionId))
    .map((f) => normalizeFolder({ ...f, id: ids.get(f.id)!, collectionId: ids.get(f.collectionId)!, parentId: remap(f.parentId), updatedAt: now }))
  const requests: RequestDef[] = (d.requests ?? []).map((r: RequestDef) => normalizeRequest({
    ...r, id: uid(), collectionId: remap(r.collectionId), folderId: remap(r.folderId), updatedAt: now,
  }))
  const environments: Environment[] = (d.environments ?? []).map((e: Environment) => ({ ...e, id: uid(), updatedAt: now }))
  return { source: 'dispatch', collections, folders, requests, environments, globals: d.globals ?? [], warnings: [] }
}

const str = (v: unknown) => (v == null ? '' : String(v))
const desc = (v: unknown) => (typeof v === 'string' ? v : typeof (v as any)?.content === 'string' ? (v as any).content : '')
const toKv = (list: any[] | undefined): KV[] => (list ?? []).filter((x) => x && typeof x === 'object')
  .map((x) => kv(str(x.key), str(x.value), !x.disabled, x.description ? { description: desc(x.description) } : {}))

function postmanAuth(a: any, warnings: string[], where: string): Auth {
  if (!a || !a.type) return emptyAuth('inherit')
  // v2.1 stores options as [{key, value}], v2.0 as an object
  const get = (k: string) => {
    const opts = a[a.type]
    if (Array.isArray(opts)) return str(opts.find((o: any) => o.key === k)?.value)
    return str(opts?.[k])
  }
  switch (a.type) {
    case 'noauth': return emptyAuth('none')
    case 'basic': return { ...emptyAuth('basic'), username: get('username'), password: get('password') }
    case 'digest': return { ...emptyAuth('digest'), username: get('username'), password: get('password') }
    case 'bearer': return { ...emptyAuth('bearer'), token: get('token') }
    case 'apikey': return { ...emptyAuth('apikey'), key: get('key'), value: get('value'), in: get('in') === 'query' ? 'query' : 'header' }
    case 'oauth2': {
      const grant = get('grant_type')
      return {
        ...emptyAuth('oauth2'),
        grant: grant === 'password_credentials' ? 'password' : grant === 'authorization_code' || grant === 'authorization_code_with_pkce' ? 'authorization_code' : 'client_credentials',
        usePkce: grant !== 'authorization_code',
        tokenUrl: get('accessTokenUrl'), authUrl: get('authUrl'), clientId: get('clientId'), clientSecret: get('clientSecret'),
        scope: get('scope'), username: get('username'), password: get('password'),
        redirectUri: get('redirect_uri') || emptyAuth().redirectUri,
        clientAuth: get('client_authentication') === 'body' ? 'body' : 'header',
        accessToken: get('accessToken'),
      }
    }
    case 'jwt': {
      const alg = get('algorithm')
      if (alg && !['HS256', 'HS384', 'HS512'].includes(alg)) warnings.push(`${where}: JWT ${alg} isn’t supported yet (only HS256/384/512).`)
      return { ...emptyAuth('jwt'), algorithm: (['HS256', 'HS384', 'HS512'].includes(alg) ? alg : 'HS256') as Auth['algorithm'], secret: get('secret'), payload: get('payload') || '{}', headerPrefix: get('headerPrefix') || 'Bearer' }
    }
    case 'awsv4': return { ...emptyAuth('awsv4'), accessKey: get('accessKey'), secretKey: get('secretKey'), sessionToken: get('sessionToken'), region: get('region') || 'us-east-1', service: get('service') || 'execute-api' }
    default:
      warnings.push(`${where}: ${a.type} auth isn’t supported yet; set it up again by hand.`)
      return emptyAuth('none')
  }
}

function postmanScripts(events: any[] | undefined): Scripts {
  const code = (listen: string) => {
    const e = (events ?? []).find((x) => x?.listen === listen)
    const exec = e?.script?.exec
    return Array.isArray(exec) ? exec.join('\n') : str(exec)
  }
  return { pre: code('prerequest'), post: code('test') }
}

function postmanUrl(u: any): string {
  if (typeof u === 'string') return u
  if (!u) return ''
  if (u.raw) return str(u.raw)
  const host = Array.isArray(u.host) ? u.host.join('.') : str(u.host)
  const path = Array.isArray(u.path) ? u.path.join('/') : str(u.path)
  const query = (u.query ?? []).filter((q: any) => !q.disabled).map((q: any) => `${q.key}=${q.value ?? ''}`).join('&')
  return `${u.protocol ? `${u.protocol}://` : ''}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`
}

function importPostmanCollection(d: any): ImportResult {
  const warnings: string[] = []
  const col = newCollection(str(d.info?.name) || 'Imported collection')
  col.variables = toKv(d.variable)
  col.auth = postmanAuth(d.auth, warnings, col.name)
  if (col.auth.kind === 'inherit') col.auth = emptyAuth('none')
  col.scripts = postmanScripts(d.event)
  col.docs = desc(d.info?.description)
  const folders: Folder[] = []
  const requests: RequestDef[] = []

  let position = 0
  const walk = (items: any[], parent: Folder | null) => {
    for (const it of items ?? []) {
      position++
      if (Array.isArray(it.item)) {
        const f = newFolder(col.id, str(it.name) || 'Folder', parent?.id ?? null)
        f.sort = position
        if (it.auth) f.auth = postmanAuth(it.auth, warnings, f.name)
        f.scripts = postmanScripts(it.event)
        f.docs = desc(it.description)
        folders.push(f)
        walk(it.item, f)
        continue
      }
      const r = it.request
      if (!r) continue
      const name = str(it.name) || 'Request'
      const method = str(typeof r === 'string' ? 'GET' : r.method || 'GET').toUpperCase() as Method
      if (!METHODS.includes(method)) { warnings.push(`${name}: method ${method} isn’t supported; skipped.`); continue }
      const url = postmanUrl(typeof r === 'string' ? r : r.url)
      const req = newRequest({ name, method, url, collectionId: col.id, folderId: parent?.id ?? null, sort: position })
      req.params = paramsFromUrl(url, [])
      req.params.push(...(r.url?.query ?? []).filter((q: any) => q.disabled).map((q: any) => kv(str(q.key), str(q.value), false)))
      req.pathVars = toKv(r.url?.variable)
      req.headers = toKv(r.header)
      req.auth = r.auth ? postmanAuth(r.auth, warnings, name) : emptyAuth('inherit')
      req.scripts = postmanScripts(it.event)
      req.docs = desc(r.description)
      const b = r.body
      if (b?.mode === 'raw') {
        const lang = str(b.options?.raw?.language)
        const ct = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''
        const kind = lang === 'json' || ct.includes('json') ? 'json' : lang === 'xml' || ct.includes('xml') ? 'xml' : lang === 'html' ? 'html' : 'text'
        req.body = { ...emptyBody(kind), text: str(b.raw) }
      } else if (b?.mode === 'urlencoded') {
        req.body = { ...emptyBody('urlencoded'), fields: toKv(b.urlencoded) }
      } else if (b?.mode === 'formdata') {
        req.body = { ...emptyBody('formdata'), fields: (b.formdata ?? []).map((x: any) => kv(str(x.key), x.type === 'file' ? '' : str(x.value), !x.disabled, { type: x.type === 'file' ? 'file' : 'text', file: null })) }
        if ((b.formdata ?? []).some((x: any) => x.type === 'file')) warnings.push(`${name}: form-data files aren’t in the export; choose them again.`)
      } else if (b?.mode === 'graphql') {
        req.body = { ...emptyBody('graphql'), text: str(b.graphql?.query), graphqlVariables: str(b.graphql?.variables) }
      } else if (b?.mode === 'file') {
        req.body = emptyBody('binary')
        warnings.push(`${name}: binary file bodies aren’t in the export; choose the file again.`)
      }
      req.examples = (it.response ?? []).map((x: any): Example => ({
        id: uid(), name: str(x.name) || 'Example', status: Number(x.code) || 200,
        headers: (x.header ?? []).map((h: any) => [str(h.key), str(h.value)] as [string, string]), body: str(x.body),
      }))
      requests.push(req)
    }
  }
  walk(d.item ?? [], null)
  return { source: 'postman-collection', collections: [col], folders, requests, environments: [], warnings: [...new Set(warnings)] }
}

function importPostmanEnvironment(d: any): ImportResult {
  const env = newEnvironment(str(d.name) || 'Imported environment')
  env.variables = (d.values ?? []).map((v: any) => kv(str(v.key), str(v.value), v.enabled !== false, v.type === 'secret' ? { secret: true } : {}))
  return { source: 'postman-environment', collections: [], folders: [], requests: [], environments: [env], warnings: [] }
}
