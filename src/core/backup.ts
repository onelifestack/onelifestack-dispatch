import type { Auth, Collection, Environment, KV, Method, RequestDef } from './types'
import { METHODS, emptyAuth, kv, newCollection, newEnvironment, newRequest, uid } from './types'
import { paramsFromUrl } from './url'

export interface Workspace { collections: Collection[]; requests: RequestDef[]; environments: Environment[] }

export const FORMAT = 'onelifestack-dispatch'

/** A JSON backup of everything saved. History is left out: it can hold responses with secrets. */
export function exportWorkspace(w: Workspace): string {
  return JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), ...w }, null, 2)
}

export interface ImportResult extends Workspace { source: 'dispatch' | 'postman-collection' | 'postman-environment'; warnings: string[] }

/**
 * Reads a Dispatch backup, a Postman collection (v2.0/v2.1) or a Postman environment.
 * Everything gets fresh ids, so importing the same file twice gives two copies instead of overwriting edits.
 */
export function importFile(text: string): ImportResult {
  let data: any
  try { data = JSON.parse(text) } catch { throw new Error('That file isn’t valid JSON.') }
  if (data?.format === FORMAT) return importDispatch(data)
  if ((data?.info?.schema && String(data.info.schema).includes('collection')) || (data?.info && Array.isArray(data?.item))) return importPostmanCollection(data)
  if (Array.isArray(data?.values) && (data?._postman_variable_scope === 'environment' || typeof data?.name === 'string')) return importPostmanEnvironment(data)
  throw new Error('Unrecognised file. Import a Dispatch backup, a Postman collection (v2.1) or a Postman environment.')
}

function importDispatch(d: any): ImportResult {
  const ids = new Map<string, string>()
  const fresh = (old: string) => { if (!ids.has(old)) ids.set(old, uid()); return ids.get(old)! }
  const now = Date.now()
  const collections: Collection[] = (d.collections ?? []).map((c: Collection) => ({ ...c, id: fresh(c.id), updatedAt: now }))
  const requests: RequestDef[] = (d.requests ?? []).map((r: RequestDef) => ({
    ...newRequest(), ...r, id: uid(), collectionId: r.collectionId ? (ids.get(r.collectionId) ?? null) : null, updatedAt: now,
  }))
  const environments: Environment[] = (d.environments ?? []).map((e: Environment) => ({ ...e, id: uid(), updatedAt: now }))
  return { source: 'dispatch', collections, requests, environments, warnings: [] }
}

const str = (v: unknown) => (v == null ? '' : String(v))
const toKv = (list: any[] | undefined): KV[] => (list ?? []).filter((x) => x && typeof x === 'object')
  .map((x) => kv(str(x.key), str(x.value), !x.disabled))

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
    case 'bearer': return { ...emptyAuth('bearer'), token: get('token') }
    case 'apikey': return { ...emptyAuth('apikey'), key: get('key'), value: get('value'), in: get('in') === 'query' ? 'query' : 'header' }
    default:
      warnings.push(`${where}: ${a.type} auth isn’t supported yet; set it up again by hand.`)
      return emptyAuth('none')
  }
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
  if (d.event?.length) warnings.push('Collection scripts aren’t supported yet and were skipped.')
  const requests: RequestDef[] = []

  // Folders are flattened: "Folder / Sub / Request". Folder auth applies to requests that inherit.
  const walk = (items: any[], prefix: string, folderAuth: Auth | null) => {
    for (const it of items ?? []) {
      if (Array.isArray(it.item)) {
        const fa = it.auth ? postmanAuth(it.auth, warnings, it.name) : folderAuth
        walk(it.item, `${prefix}${str(it.name)} / `, fa && fa.kind !== 'inherit' ? fa : folderAuth)
        continue
      }
      const r = it.request
      if (!r) continue
      const name = `${prefix}${str(it.name) || 'Request'}`
      const method = str(typeof r === 'string' ? 'GET' : r.method || 'GET').toUpperCase() as Method
      if (!METHODS.includes(method)) { warnings.push(`${name}: method ${method} isn’t supported; skipped.`); continue }
      const url = postmanUrl(typeof r === 'string' ? r : r.url)
      const req = newRequest({ name, method, url, collectionId: col.id })
      req.params = paramsFromUrl(url, [])
      const disabledQuery = (r.url?.query ?? []).filter((q: any) => q.disabled)
      req.params.push(...disabledQuery.map((q: any) => kv(str(q.key), str(q.value), false)))
      req.headers = toKv(r.header)
      let auth = r.auth ? postmanAuth(r.auth, warnings, name) : emptyAuth('inherit')
      if (auth.kind === 'inherit' && folderAuth) auth = folderAuth
      req.auth = auth
      const b = r.body
      if (b?.mode === 'raw') {
        const lang = str(b.options?.raw?.language)
        const ct = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''
        const isJson = lang === 'json' || ct.includes('json')
        req.body = { kind: isJson ? 'json' : 'text', text: str(b.raw), fields: [] }
      } else if (b?.mode === 'urlencoded') {
        req.body = { kind: 'urlencoded', text: '', fields: toKv(b.urlencoded) }
      } else if (b?.mode && b.mode !== 'none') {
        warnings.push(`${name}: ${b.mode} bodies aren’t supported yet; the body was skipped.`)
      }
      if (it.event?.length) warnings.push(`${name}: scripts aren’t supported yet and were skipped.`)
      requests.push(req)
    }
  }
  walk(d.item ?? [], '', null)
  return { source: 'postman-collection', collections: [col], requests, environments: [], warnings: [...new Set(warnings)] }
}

function importPostmanEnvironment(d: any): ImportResult {
  const env = newEnvironment(str(d.name) || 'Imported environment')
  env.variables = (d.values ?? []).map((v: any) => kv(str(v.key), str(v.value), v.enabled !== false))
  return { source: 'postman-environment', collections: [], requests: [], environments: [env], warnings: [] }
}
