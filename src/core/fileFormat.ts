/**
 * Collections as a folder of plain files, made to live in a git repo and be reviewed in pull requests:
 *
 *   dispatch.collection.yaml        name, docs, auth, variables, scripts
 *   <folder>/_folder.yaml           a folder's name, position, auth, scripts, docs
 *   <folder>/<request>.req.yaml     one request
 *
 * Ids are kept in the files so a collection keeps its identity when reopened. Literal secrets are never written:
 * secret variables are written without a value, and auth fields only keep {{variable}} references. Reading merges
 * those blanks back from what's on this device.
 */
import type { Auth, Collection, Folder, KV, RequestDef } from './types'
import { normalizeCollection, normalizeFolder, normalizeRequest } from './types'
import type { ImportResult } from './backup'

export interface FileEntry { path: string; text: string }
export const ROOT_FILE = 'dispatch.collection.yaml'
const SECRET_AUTH: (keyof Auth)[] = ['password', 'token', 'value', 'clientSecret', 'accessToken', 'refreshToken', 'secret', 'secretKey', 'sessionToken']
const onlyRefs = (s: string) => /^\s*(\{\{[^{}]+\}\}\s*)+$/.test(s)

export function slug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'
}

/** Auth for files: literal secrets dropped, {{refs}} kept, OAuth tokens never written. */
function fileAuth(a: Auth): Partial<Auth> {
  const out: Partial<Auth> = { kind: a.kind }
  const defaults = { username: '', password: '', token: '', key: '', value: '', in: 'header', grant: 'client_credentials', tokenUrl: '', authUrl: '', clientId: '', clientSecret: '', scope: '', redirectUri: '', usePkce: true, clientAuth: 'header', algorithm: 'HS256', secret: '', payload: '', headerPrefix: 'Bearer', accessKey: '', secretKey: '', sessionToken: '', region: '', service: '' } as Record<string, unknown>
  for (const [k, v] of Object.entries(a) as [keyof Auth, unknown][]) {
    if (k === 'kind' || k === 'accessToken' || k === 'refreshToken' || k === 'expiresAt') continue
    if (SECRET_AUTH.includes(k) && typeof v === 'string' && v && !onlyRefs(v)) continue
    if (v !== defaults[k] && v !== '' && v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}
const fileVars = (rows: KV[]) => rows.filter((v) => v.key.trim()).map((v) => ({ key: v.key, value: v.secret ? '' : v.value, ...(v.enabled ? {} : { enabled: false }), ...(v.secret ? { secret: true } : {}) }))
const fileKv = (rows: KV[]) => rows.filter((v) => v.key.trim()).map((v) => ({ key: v.key, value: v.value, ...(v.enabled ? {} : { enabled: false }), ...(v.description ? { description: v.description } : {}) }))
const clean = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))) as Partial<T>

export interface Stringify { (v: unknown): string }

/** The files for a collection. `stringify` is YAML (or JSON) — passed in so this file has no parser dependency. */
export function collectionToFiles(c: Collection, folders: Folder[], requests: RequestDef[], stringify: Stringify): FileEntry[] {
  const files: FileEntry[] = []
  const lit = (a: Auth) => SECRET_AUTH.some((k) => typeof a[k] === 'string' && a[k] && !onlyRefs(a[k] as string))
  const warn: string[] = []
  files.push({ path: ROOT_FILE, text: stringify(clean({ dispatch: 1, id: c.id, name: c.name, docs: c.docs, auth: fileAuth(c.auth), variables: fileVars(c.variables), scripts: clean({ ...c.scripts }) })) })
  if (lit(c.auth)) warn.push(c.name)
  // Folder paths: slugs, made unique among siblings.
  const dirOf = new Map<string | null, string>([[null, '']])
  const used = new Map<string, Set<string>>()
  const unique = (dir: string, base: string, ext: string) => {
    const set = used.get(dir) ?? new Set<string>(); used.set(dir, set)
    let n = base; let i = 2
    while (set.has(n + ext)) n = `${base}-${i++}`
    set.add(n + ext)
    return n
  }
  const walk = (parent: string | null) => {
    const dir = dirOf.get(parent)!
    for (const f of folders.filter((x) => x.collectionId === c.id && x.parentId === parent)) {
      const name = unique(dir, slug(f.name), '/')
      const sub = `${dir}${name}/`
      dirOf.set(f.id, sub)
      files.push({ path: `${sub}_folder.yaml`, text: stringify(clean({ id: f.id, name: f.name, sort: f.sort, docs: f.docs, auth: f.auth.kind === 'inherit' ? undefined : fileAuth(f.auth), scripts: clean({ ...f.scripts }) })) })
      if (lit(f.auth)) warn.push(f.name)
      walk(f.id)
    }
    for (const r of requests.filter((x) => x.collectionId === c.id && (x.folderId ?? null) === parent)) {
      const name = unique(dir, slug(r.name), '.req.yaml')
      const body = r.body.kind === 'none' ? undefined : clean({
        kind: r.body.kind, text: r.body.text, graphqlVariables: r.body.graphqlVariables,
        fields: r.body.fields.length ? r.body.fields.filter((x) => x.key.trim()).map((x) => clean({ key: x.key, value: x.type === 'file' ? undefined : x.value, type: x.type === 'file' ? 'file' : undefined, enabled: x.enabled ? undefined : false })) : undefined,
        file: r.body.file ? r.body.file.name : undefined,
      })
      files.push({ path: `${dir}${name}.req.yaml`, text: stringify(clean({
        id: r.id, name: r.name, sort: r.sort, protocol: r.protocol === 'http' ? undefined : r.protocol, method: r.method, url: r.url,
        params: fileKv(r.params.filter((p) => !p.enabled)), pathVars: fileKv(r.pathVars), headers: fileKv(r.headers), body,
        auth: r.auth.kind === 'inherit' ? undefined : fileAuth(r.auth), scripts: clean({ ...r.scripts }), docs: r.docs,
        settings: clean({ ...r.settings } as Record<string, unknown>), examples: r.examples.length ? r.examples : undefined,
        ws: r.protocol === 'ws' ? r.ws : undefined, mqtt: r.protocol === 'mqtt' ? r.mqtt : undefined, grpc: r.protocol === 'grpc' ? r.grpc : undefined,
      })) })
      if (lit(r.auth)) warn.push(r.name)
    }
  }
  walk(null)
  return files
}

/** Which items hold literal secrets that files leave out (to tell the user once). */
export function literalSecrets(c: Collection, folders: Folder[], requests: RequestDef[]): string[] {
  const lit = (a: Auth) => SECRET_AUTH.some((k) => typeof a[k] === 'string' && a[k] && !onlyRefs(a[k] as string) && !['accessToken', 'refreshToken'].includes(k))
  return [...(lit(c.auth) ? [c.name] : []), ...folders.filter((f) => f.collectionId === c.id && lit(f.auth)).map((f) => f.name), ...requests.filter((r) => r.collectionId === c.id && lit(r.auth)).map((r) => r.name)]
}

export interface Parse { (text: string): unknown }

/**
 * Reads a collection folder. `local` is what this device has for the same collection (if any): blank secrets in
 * the files are filled from it, so secrets never need to be in the repo.
 */
export function filesToCollection(files: FileEntry[], parse: Parse, local?: { collection: Collection | null; folders: Folder[]; requests: RequestDef[] }): ImportResult {
  const warnings: string[] = []
  const byPath = new Map(files.map((f) => [f.path.replace(/\\/g, '/').replace(/^\.\//, ''), f.text]))
  const rootText = byPath.get(ROOT_FILE)
  if (!rootText) throw new Error(`This folder has no ${ROOT_FILE}; it isn’t a Dispatch collection folder.`)
  const read = (path: string): any => { try { return parse(byPath.get(path)!) ?? {} } catch (e) { warnings.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); return null } }
  const mergeAuth = (a: any, prev: Auth | undefined): Partial<Auth> => {
    const out = { ...(a ?? {}) }
    if (prev && prev.kind === out.kind) for (const k of [...SECRET_AUTH]) if (!out[k] && prev[k]) out[k] = prev[k]
    return out
  }
  const root = read(ROOT_FILE) ?? {}
  const prevCol = local?.collection ?? null
  const collection = normalizeCollection({
    id: String(root.id ?? prevCol?.id ?? crypto.randomUUID()), name: String(root.name ?? 'Collection'), docs: root.docs ?? '',
    auth: { ...(mergeAuth(root.auth, prevCol?.auth) as Auth), kind: root.auth?.kind ?? 'none' }, scripts: root.scripts ?? {},
    variables: (root.variables ?? []).map((v: any) => ({ id: crypto.randomUUID(), key: String(v.key), value: v.secret ? (prevCol?.variables.find((p) => p.key === v.key)?.value ?? '') : String(v.value ?? ''), enabled: v.enabled !== false, ...(v.secret ? { secret: true } : {}) })),
  })
  const folders: Folder[] = []
  const folderByDir = new Map<string, string>([['', '']])
  const dirs = [...byPath.keys()].filter((p) => p.endsWith('/_folder.yaml')).map((p) => p.slice(0, -'_folder.yaml'.length)).sort((a, b) => a.split('/').length - b.split('/').length)
  for (const dir of dirs) {
    const d = read(`${dir}_folder.yaml`)
    if (!d) continue
    const parentDir = dir.split('/').slice(0, -2).join('/')
    const parentId = parentDir ? folderByDir.get(`${parentDir}/`) ?? null : null
    const prev = local?.folders.find((f) => f.id === d.id)
    const f = normalizeFolder({ id: String(d.id ?? crypto.randomUUID()), collectionId: collection.id, parentId, name: String(d.name ?? dir.split('/').slice(-2)[0]), sort: Number(d.sort) || 0, docs: d.docs ?? '', scripts: d.scripts ?? {},
      auth: d.auth ? (mergeAuth(d.auth, prev?.auth) as Auth) : undefined })
    folders.push(f)
    folderByDir.set(dir, f.id)
  }
  const requests: RequestDef[] = []
  const toKv = (rows: any[] | undefined): KV[] => (rows ?? []).map((x) => ({ id: crypto.randomUUID(), key: String(x.key), value: String(x.value ?? ''), enabled: x.enabled !== false, ...(x.description ? { description: x.description } : {}) }))
  for (const [path] of byPath) {
    if (!path.endsWith('.req.yaml')) continue
    const d = read(path)
    if (!d) continue
    const dir = path.split('/').slice(0, -1).join('/')
    const folderId = dir ? folderByDir.get(`${dir}/`) ?? null : null
    if (dir && folderId === undefined) warnings.push(`${path}: its folder has no _folder.yaml; put at the top level.`)
    const prev = local?.requests.find((r) => r.id === d.id)
    const url = String(d.url ?? '')
    const r = normalizeRequest({
      id: String(d.id ?? crypto.randomUUID()), name: String(d.name ?? path.split('/').pop()!.replace(/\.req\.yaml$/, '')), sort: Number(d.sort) || 0,
      protocol: d.protocol ?? 'http', method: d.method ?? 'GET', url, collectionId: collection.id, folderId: folderId ?? null,
      params: [], pathVars: toKv(d.pathVars), headers: toKv(d.headers), docs: d.docs ?? '', scripts: d.scripts ?? {}, settings: d.settings ?? {},
      examples: d.examples ?? [], auth: d.auth ? (mergeAuth(d.auth, prev?.auth) as Auth) : undefined,
      ws: d.ws, mqtt: d.mqtt, grpc: d.grpc,
      body: d.body ? { kind: d.body.kind, text: d.body.text ?? '', graphqlVariables: d.body.graphqlVariables ?? '',
        fields: (d.body.fields ?? []).map((x: any) => ({ id: crypto.randomUUID(), key: String(x.key), value: String(x.value ?? ''), enabled: x.enabled !== false, ...(x.type === 'file' ? { type: 'file', file: prev?.body.fields.find((p) => p.key === x.key)?.file ?? null } : { type: 'text' }) })),
        file: d.body.file ? (prev?.body.file ?? null) : null } : undefined,
    })
    // Enabled query params live in the URL; disabled ones are listed in the file.
    const q = url.split('?')[1]?.split('#')[0] ?? ''
    const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')) } catch { return x } }
    r.params = [...q.split('&').filter(Boolean).map((pair) => { const i = pair.indexOf('='); return { id: crypto.randomUUID(), key: dec(i >= 0 ? pair.slice(0, i) : pair), value: i >= 0 ? dec(pair.slice(i + 1)) : '', enabled: true } }), ...toKv(d.params).map((p) => ({ ...p, enabled: false }))]
    requests.push(r)
  }
  return { source: 'dispatch', collections: [collection], folders, requests, environments: [], warnings }
}
