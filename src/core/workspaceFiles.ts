/**
 * A workspace as a folder of plain files (docs/DESIGN-linked-workspaces.md):
 *
 *   dispatch.workspace.yaml              id, name, format version
 *   collections/<slug>/...               each collection in the collection-folder format (fileFormat.ts)
 *   environments/<slug>.env.yaml         one environment; secret values left empty
 *   flows/<slug>.flow.yaml               one flow
 *
 * Written to merge well in git: one file per item, ids kept, no timestamps, whole-number canvas positions.
 * Secrets never go into the files; reading fills the blanks from what this device has.
 */
import { type FileEntry, type Parse, type Stringify, collectionToFiles, filesToCollection, slug } from './fileFormat'
import type { Flow, FlowEdge, FlowNode } from './flows'
import type { Collection, Environment, Folder, KV, RequestDef, Space } from './types'

export const WORKSPACE_FILE = 'dispatch.workspace.yaml'
export const WORKSPACE_FORMAT = 1

export interface WorkspaceContent {
  space: Space
  collections: Collection[]
  folders: Folder[]
  requests: RequestDef[]
  environments: Environment[]
  flows: Flow[]
}

/** File names from item names, unique within a directory and stable: ties go by id, then get -2, -3… */
function names<T extends { id: string; name: string }>(items: T[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const it of [...items].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const base = slug(it.name)
    let n = base, i = 2
    while (used.has(n)) n = `${base}-${i++}`
    used.add(n); out.set(it.id, n)
  }
  return out
}

const envVars = (rows: KV[]) => rows.filter((v) => v.key.trim()).map((v) => ({ key: v.key, value: v.secret ? '' : v.value, ...(v.enabled ? {} : { enabled: false }), ...(v.secret ? { secret: true } : {}) }))
const node = (n: FlowNode) => ({ id: n.id, type: n.type, label: n.label, x: Math.round(n.x), y: Math.round(n.y), ...(Object.keys(n.config).length ? { config: n.config } : {}) })
const edge = (e: FlowEdge) => ({ id: e.id, from: e.from, port: e.port, to: e.to })

/** The files for one workspace. Only the items given are written: callers leave out collections with their own folder. */
export function workspaceToFiles(w: WorkspaceContent, stringify: Stringify): FileEntry[] {
  const files: FileEntry[] = [{ path: WORKSPACE_FILE, text: stringify({ id: w.space.id, name: w.space.name, format: WORKSPACE_FORMAT }) }]
  const colNames = names(w.collections)
  for (const c of w.collections) {
    const dir = `collections/${colNames.get(c.id)}/`
    for (const f of collectionToFiles(c, w.folders, w.requests, stringify)) files.push({ path: dir + f.path, text: f.text })
  }
  const envNames = names(w.environments)
  for (const e of w.environments) files.push({ path: `environments/${envNames.get(e.id)}.env.yaml`, text: stringify({ id: e.id, name: e.name, variables: envVars(e.variables) }) })
  const flowNames = names(w.flows)
  for (const f of w.flows) {
    files.push({ path: `flows/${flowNames.get(f.id)}.flow.yaml`, text: stringify({ id: f.id, name: f.name, ...(f.docs ? { docs: f.docs } : {}), nodes: f.nodes.map(node), edges: f.edges.map(edge) }) })
  }
  return files
}

/** What this device already has, to fill secrets the files leave blank. */
export interface LocalItems { collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environments: Environment[] }

export interface WorkspaceRead extends WorkspaceContent { warnings: string[] }

/** True when the files hold a workspace (as opposed to an empty folder or a single collection folder). */
export const isWorkspaceFolder = (files: FileEntry[]) => files.some((f) => f.path === WORKSPACE_FILE)

/** The workspace's id and name from its files, or null when they don't hold one (or it can't be read). */
export function workspaceHeader(files: FileEntry[], parse: Parse): Space | null {
  const t = files.find((f) => f.path === WORKSPACE_FILE)?.text
  if (t === undefined) return null
  try { const d = parse(t) as { id?: unknown; name?: unknown } | null; return d?.id ? { id: String(d.id), name: String(d.name ?? 'Workspace') } : null } catch { return null }
}

/**
 * Reads a workspace folder. Every item is placed in the workspace the folder names. Ids are kept, so reading the
 * same folder again updates the same items; a second file with an id already seen gets a new id (a copied file).
 */
export function filesToWorkspace(files: FileEntry[], parse: Parse, local: LocalItems): WorkspaceRead {
  const warnings: string[] = []
  const byPath = new Map(files.map((f) => [f.path.replace(/\\/g, '/').replace(/^\.\//, ''), f.text]))
  const read = (path: string): any => { try { return parse(byPath.get(path)!) ?? {} } catch (e) { warnings.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); return null } }
  const head = read(WORKSPACE_FILE)
  if (!head) throw new Error(`This folder has no readable ${WORKSPACE_FILE}; it isn’t a Dispatch workspace folder.`)
  if (Number(head.format ?? 1) > WORKSPACE_FORMAT) warnings.push(`${WORKSPACE_FILE} was written by a newer Dispatch; some things may not come across.`)
  const space: Space = { id: String(head.id ?? crypto.randomUUID()), name: String(head.name ?? 'Workspace') }
  const seen = new Set<string>()
  const fresh = (id: unknown, path: string) => {
    let s = String(id ?? '') || crypto.randomUUID()
    if (seen.has(s)) { warnings.push(`${path}: another file has the same id; this one gets a new id.`); s = crypto.randomUUID() }
    seen.add(s); return s
  }

  const out: WorkspaceRead = { space, collections: [], folders: [], requests: [], environments: [], flows: [], warnings }
  // Collections: one sub-folder each.
  const colDirs = [...new Set([...byPath.keys()].filter((p) => p.startsWith('collections/')).map((p) => p.split('/')[1]).filter(Boolean))].sort()
  for (const dir of colDirs) {
    const prefix = `collections/${dir}/`
    const sub = [...byPath].filter(([p]) => p.startsWith(prefix)).map(([p, text]) => ({ path: p.slice(prefix.length), text }))
    let rootId: string | undefined
    try { rootId = (parse(sub.find((f) => f.path === 'dispatch.collection.yaml')?.text ?? '') as { id?: string } | null)?.id } catch { /* reported below */ }
    const prev = local.collections.find((c) => c.id === rootId) ?? null
    try {
      const r = filesToCollection(sub, parse, { collection: prev, folders: local.folders, requests: local.requests })
      const c = r.collections[0]
      if (seen.has(c.id)) { warnings.push(`${prefix}: another collection has the same id; skipped.`); continue }
      seen.add(c.id)
      out.collections.push({ ...c, workspaceId: space.id, linkedDir: '' })
      out.folders.push(...r.folders); out.requests.push(...r.requests)
      warnings.push(...r.warnings.map((w) => `${prefix}${w}`))
    } catch (e) { warnings.push(`${prefix}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  // Environments.
  for (const path of [...byPath.keys()].filter((p) => /^environments\/[^/]+\.env\.yaml$/.test(p)).sort()) {
    const d = read(path)
    if (!d) continue
    const id = fresh(d.id, path)
    const prev = local.environments.find((e) => e.id === id)
    out.environments.push({
      id, name: String(d.name ?? path.slice('environments/'.length, -'.env.yaml'.length)), workspaceId: space.id, updatedAt: Date.now(),
      variables: (Array.isArray(d.variables) ? d.variables : []).map((v: any) => ({
        id: crypto.randomUUID(), key: String(v.key ?? ''), enabled: v.enabled !== false,
        value: v.secret ? (prev?.variables.find((p) => p.key === String(v.key))?.value ?? '') : String(v.value ?? ''),
        ...(v.secret ? { secret: true } : {}),
      })),
    })
  }
  // Flows.
  for (const path of [...byPath.keys()].filter((p) => /^flows\/[^/]+\.flow\.yaml$/.test(p)).sort()) {
    const d = read(path)
    if (!d) continue
    const nodes: FlowNode[] = (Array.isArray(d.nodes) ? d.nodes : []).map((n: any) => ({
      id: String(n.id ?? crypto.randomUUID()), type: n.type, label: String(n.label ?? ''), x: Number(n.x) || 0, y: Number(n.y) || 0,
      config: Object.fromEntries(Object.entries(n.config ?? {}).map(([k, v]) => [k, String(v)])),
    }))
    out.flows.push({
      id: fresh(d.id, path), name: String(d.name ?? path.slice('flows/'.length, -'.flow.yaml'.length)), docs: String(d.docs ?? ''), workspaceId: space.id, updatedAt: Date.now(), nodes,
      edges: (Array.isArray(d.edges) ? d.edges : []).map((e: any) => ({ id: String(e.id ?? crypto.randomUUID()), from: String(e.from), port: String(e.port), to: String(e.to) })),
    })
  }
  return out
}

