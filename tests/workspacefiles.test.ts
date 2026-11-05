import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { WORKSPACE_FILE, filesToWorkspace, isWorkspaceFolder, workspaceHeader, workspaceToFiles } from '../src/core/workspaceFiles'
import { newFlow, newNode } from '../src/core/flows'
import { emptyAuth, kv, newCollection, newEnvironment, newFolder, newRequest } from '../src/core/types'

const y = (v: unknown) => stringify(v, { lineWidth: 0 })
const space = { id: 'ws-1', name: 'Payments' }
const shop = { ...newCollection('Shop API'), workspaceId: space.id, auth: { ...emptyAuth('bearer'), token: '{{token}}' } }
const shop2 = { ...newCollection('Shop API'), workspaceId: space.id }
const orders = newFolder(shop.id, 'Orders')
const list = newRequest({ name: 'List', url: '{{base}}/orders', collectionId: shop.id, folderId: orders.id })
const staging = { ...newEnvironment('Staging'), workspaceId: space.id, variables: [kv('base', 'https://s.test'), kv('token', 'secret-value', true, { secret: true })] }
const flow = (() => {
  const f = { ...newFlow('Login and orders'), workspaceId: space.id }
  const req = { ...newNode('request', 314.6, 80.2), config: { requestId: list.id } }
  return { ...f, nodes: [...f.nodes, req], edges: [{ id: 'e1', from: f.nodes[0].id, port: 'next', to: req.id }] }
})()
const content = { space, collections: [shop, shop2], folders: [orders], requests: [list], environments: [staging], flows: [flow] }

describe('workspaces as files', () => {
  const files = workspaceToFiles(content, y)

  it('lays out one file per item, with unique names', () => {
    const paths = files.map((f) => f.path).sort()
    expect(paths).toContain(WORKSPACE_FILE)
    expect(paths).toContain('environments/staging.env.yaml')
    expect(paths).toContain('flows/login-and-orders.flow.yaml')
    expect(paths.filter((p) => p.endsWith('/dispatch.collection.yaml')).sort()).toEqual(['collections/shop-api-2/dispatch.collection.yaml', 'collections/shop-api/dispatch.collection.yaml'])
    expect(isWorkspaceFolder(files)).toBe(true)
    expect(workspaceHeader(files, parse)).toEqual(space)
  })

  it('keeps secrets and timestamps out, and canvas positions whole', () => {
    const all = files.map((f) => f.text).join('\n')
    expect(all).not.toContain('secret-value')
    expect(all).not.toContain('updatedAt')
    const fl = files.find((f) => f.path.endsWith('.flow.yaml'))!.text
    expect(fl).toContain('x: 315'); expect(fl).toContain('y: 80')
  })

  it('reads back the same items, in the folder’s workspace, with this device’s secrets', () => {
    const r = filesToWorkspace(files, parse, { collections: [shop], folders: [orders], requests: [list], environments: [staging] })
    expect(r.warnings).toEqual([])
    expect(r.space).toEqual(space)
    expect(r.collections.map((c) => c.id).sort()).toEqual([shop.id, shop2.id].sort())
    expect(r.collections.every((c) => c.workspaceId === space.id && c.linkedDir === '')).toBe(true)
    expect(r.requests.map((x) => [x.id, x.folderId])).toEqual([[list.id, orders.id]])
    expect(r.environments[0].variables.map((v) => [v.key, v.value, !!v.secret])).toEqual([['base', 'https://s.test', false], ['token', 'secret-value', true]])
    expect(r.flows[0].nodes[1]).toMatchObject({ type: 'request', x: 315, y: 80, config: { requestId: list.id } })
    expect(r.flows[0].edges).toEqual(flow.edges)
  })

  it('leaves secrets blank on a device that has none, and re-ids a copied file', () => {
    const copy = files.find((f) => f.path === 'environments/staging.env.yaml')!
    const r = filesToWorkspace([...files, { path: 'environments/staging-copy.env.yaml', text: copy.text }], parse, { collections: [], folders: [], requests: [], environments: [] })
    expect(r.environments.map((e) => e.variables.find((v) => v.key === 'token')!.value)).toEqual(['', ''])
    expect(new Set(r.environments.map((e) => e.id)).size).toBe(2)
    expect(r.warnings.some((w) => w.includes('same id'))).toBe(true)
  })

  it('reports a file it can’t read (e.g. git conflict markers) and keeps going', () => {
    const broken = files.map((f) => (f.path.endsWith('.flow.yaml') ? { ...f, text: '<<<<<<< HEAD\nname: [\n=======\n' } : f))
    const r = filesToWorkspace(broken, parse, { collections: [], folders: [], requests: [], environments: [] })
    expect(r.flows).toEqual([])
    expect(r.environments).toHaveLength(1)
    expect(r.warnings.some((w) => w.startsWith('flows/login-and-orders.flow.yaml'))).toBe(true)
  })

  it('refuses a folder that isn’t a workspace', () => {
    expect(() => filesToWorkspace([{ path: 'dispatch.collection.yaml', text: 'name: A' }], parse, { collections: [], folders: [], requests: [], environments: [] })).toThrow(/isn’t a Dispatch workspace folder/)
  })
})
