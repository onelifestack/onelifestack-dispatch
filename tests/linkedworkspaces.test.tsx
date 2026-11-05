/** Linked workspaces (docs/DESIGN-linked-workspaces.md), against an in-memory folder with the same rules as sync_folder. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useWorkspace } from '../src/ui/useWorkspace'
import { type FolderApi, linkSpace, openSpaceFolder, reloadSpace, useFolderSync } from '../src/ui/linkedDirs'
import { resetForTests } from '../src/core/db'
import { kv, newCollection, newRequest } from '../src/core/types'
import { newFlow, newNode } from '../src/core/flows'
import type { Transport } from '../src/core/transport'

/** Folders in memory. The "hash" is the text itself; the compare-before-write rules match the Rust side. */
class MemFolders implements FolderApi {
  dirs = new Map<string, Map<string, string>>()
  dir(root: string) { if (!this.dirs.has(root)) this.dirs.set(root, new Map()); return this.dirs.get(root)! }
  async pick() { return null }
  async read(root: string) { return [...this.dir(root)].sort().map(([path, text]) => ({ path, text, hash: text })) }
  async sync(root: string, files: { path: string; text: string }[], known: Record<string, string> | null) {
    const d = this.dir(root), out: Record<string, string> = {}, conflicts: string[] = []
    for (const f of files) {
      const disk = d.get(f.path)
      if (disk === f.text) { out[f.path] = f.text; continue }
      if (known && disk !== known[f.path]) { conflicts.push(f.path); if (known[f.path] !== undefined) out[f.path] = known[f.path]; continue }
      d.set(f.path, f.text); out[f.path] = f.text
    }
    for (const [p, text] of [...d]) {
      if (files.some((f) => f.path === p)) continue
      if (!known || text === known[p]) d.delete(p); else { conflicts.push(p); if (known[p] !== undefined) out[p] = known[p] }
    }
    return { known: out, conflicts: conflicts.sort() }
  }
}

const desktop: Transport = { label: 'fake', unrestricted: true, send: async () => { throw new Error('no network') } }
const yes = async () => true
let fs: MemFolders
beforeEach(async () => { await resetForTests(); fs = new MemFolders() })
afterEach(() => cleanup())

function mount() {
  const notes: string[] = []
  const h = renderHook(() => { const ws = useWorkspace({ transport: desktop }); useFolderSync(ws, (m) => notes.push(m), fs); return ws })
  return { h, notes }
}
const filesIn = (root: string) => [...fs.dir(root).keys()].sort()

describe('linked workspaces', () => {
  it('writes the workspace, leaves outside edits alone, and takes the folder’s version on request', async () => {
    const { h, notes } = mount()
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    await act(async () => {
      await h.result.current.addCollection('Shop API')
      const env = await h.result.current.addEnvironment('Staging')
      await h.result.current.updateEnvironment({ ...env, variables: [kv('base', 'https://s.test'), kv('token', 'top-secret', true, { secret: true })] })
      await h.result.current.addFlow('Smoke')
    })
    const space = h.result.current.spaces[0]
    let msg = ''
    await act(async () => { msg = await linkSpace(h.result.current, fs, space, '/repo', yes) })
    expect(msg).toMatch(/^Linked to \/repo/)

    await waitFor(() => expect(filesIn('/repo')).toContain('flows/smoke.flow.yaml'), { timeout: 3000 })
    expect(filesIn('/repo')).toEqual(['collections/shop-api/dispatch.collection.yaml', 'dispatch.workspace.yaml', 'environments/staging.env.yaml', 'flows/smoke.flow.yaml'])
    expect([...fs.dir('/repo').values()].join('\n')).not.toContain('top-secret')

    // Someone edits the flow outside the app (git pull), then the app edits it too.
    const outside = fs.dir('/repo').get('flows/smoke.flow.yaml')!.replace('name: Smoke', 'name: Smoke from git')
    fs.dir('/repo').set('flows/smoke.flow.yaml', outside)
    await act(async () => { const f = h.result.current.allFlows[0]; await h.result.current.updateFlow({ ...f, name: 'Smoke edited here' }) })
    await waitFor(() => expect(h.result.current.folderStatus['space:' + space.id]?.conflicts).toEqual(['flows/smoke.flow.yaml']), { timeout: 3000 })
    expect(fs.dir('/repo').get('flows/smoke.flow.yaml')).toBe(outside) // left alone
    expect(filesIn('/repo').filter((p) => p.startsWith('flows/'))).toEqual(['flows/smoke.flow.yaml']) // the renamed copy is held back
    expect(notes.some((n) => n.includes('changed outside Dispatch'))).toBe(true)

    // "Use the folder's version": the app now has git's flow; the device's secret survives.
    await act(async () => { await reloadSpace(h.result.current, fs, h.result.current.spaces[0]) })
    expect(h.result.current.allFlows.map((f) => f.name)).toEqual(['Smoke from git'])
    expect(h.result.current.folderStatus['space:' + space.id]?.conflicts).toEqual([])
    expect(h.result.current.allEnvironments[0].variables.find((v) => v.key === 'token')?.value).toBe('top-secret')
    expect(h.result.current.backups[0]?.reason).toBe('before-folder')
  })

  it('opens a workspace folder on another device, without secrets', async () => {
    // Device A links and writes.
    const a = mount()
    await waitFor(() => expect(a.h.result.current.ready).toBe(true))
    await act(async () => {
      const env = await a.h.result.current.addEnvironment('Staging')
      await a.h.result.current.updateEnvironment({ ...env, variables: [kv('token', 'top-secret', true, { secret: true })] })
      await a.h.result.current.renameSpace(a.h.result.current.spaces[0].id, 'Payments')
    })
    await act(async () => { await linkSpace(a.h.result.current, fs, a.h.result.current.spaces[0], '/repo', yes) })
    await waitFor(() => expect(filesIn('/repo')).toContain('environments/staging.env.yaml'), { timeout: 3000 })
    a.h.unmount()

    // Device B: fresh storage, same folder (a clone).
    await resetForTests()
    fs.dirs.set('/clone', new Map(fs.dir('/repo')))
    const b = mount()
    await waitFor(() => expect(b.h.result.current.ready).toBe(true))
    let msg = ''
    await act(async () => { msg = await openSpaceFolder(b.h.result.current, fs, '/clone', yes) })
    expect(msg).toMatch(/^Opened “Payments”/)
    // Its own workspace, not device B's first one (every device's first workspace has the id "default").
    const opened = b.h.result.current.spaces.find((x) => x.linkedDir === '/clone')!
    expect(opened.name).toBe('Payments')
    expect(opened.id).not.toBe('default')
    expect(b.h.result.current.spaces.find((x) => x.id === 'default')?.name).toBe('My workspace')
    expect(b.h.result.current.activeSpaceId).toBe(opened.id)
    const env = b.h.result.current.allEnvironments.find((e) => e.name === 'Staging')!
    expect(env.variables.map((v) => [v.key, v.value, !!v.secret])).toEqual([['token', '', true]])
  })

  it('opens a copied folder with a new workspace id as copies, leaving the original workspace alone', async () => {
    // Windows round 3: a copy of a linked folder, with only the workspace id edited, moved the original's records
    // (and their secrets) into the new workspace, because the record ids matched.
    const { h } = mount()
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    const col = newCollection('Shop API')
    const req = newRequest({ name: 'Orders', collectionId: col.id, url: 'https://s.test/orders' })
    const flow = newFlow('Smoke')
    const node = { ...newNode('request', 200, 140), config: { requestId: req.id } }
    await act(async () => {
      await h.result.current.importWorkspace({ collections: [col], folders: [], requests: [req], environments: [], flows: [{ ...flow, nodes: [...flow.nodes, node], edges: [{ id: 'e1', from: flow.nodes[0].id, port: 'next', to: node.id }] }] })
      const env = await h.result.current.addEnvironment('Staging')
      await h.result.current.updateEnvironment({ ...env, variables: [kv('token', 'top-secret', true, { secret: true })] })
    })
    const original = h.result.current.spaces[0]
    await act(async () => { await linkSpace(h.result.current, fs, original, '/repo', yes) })
    await waitFor(() => expect(filesIn('/repo')).toContain('flows/smoke.flow.yaml'), { timeout: 3000 })

    // The copy: same files, but someone gave the workspace a new id and name.
    const copy = new Map(fs.dir('/repo'))
    const head = copy.get('dispatch.workspace.yaml')!
    copy.set('dispatch.workspace.yaml', head.replace(/^id: .*$/m, 'id: copied-workspace').replace(/^name: .*$/m, 'name: Copy'))
    fs.dirs.set('/copy', copy)
    let msg = ''
    await act(async () => { msg = await openSpaceFolder(h.result.current, fs, '/copy', yes) })
    expect(msg).toMatch(/^Opened “Copy”/)

    const ws = h.result.current
    const copySpace = ws.spaces.find((x) => x.linkedDir === '/copy')!
    const inSpace = (id: string) => ({
      cols: ws.allCollections.filter((c) => (c.workspaceId ?? 'default') === id),
      envs: ws.allEnvironments.filter((e) => (e.workspaceId ?? 'default') === id),
      flows: ws.allFlows.filter((f) => (f.workspaceId ?? 'default') === id),
    })
    // The original keeps everything, with its secret and its own ids.
    const a = inSpace(original.id)
    expect([a.cols.length, a.envs.length, a.flows.length]).toEqual([1, 1, 1])
    expect(a.cols[0].id).toBe(col.id)
    expect(a.envs[0].variables[0].value).toBe('top-secret')
    expect(ws.requests.filter((r) => r.collectionId === col.id).map((r) => r.id)).toEqual([req.id])
    // The copy has its own records, no secret values, and its flow points at its own request.
    const b = inSpace(copySpace.id)
    expect([b.cols.length, b.envs.length, b.flows.length]).toEqual([1, 1, 1])
    expect(b.cols[0].id).not.toBe(col.id)
    expect(b.envs[0].id).not.toBe(a.envs[0].id)
    expect(b.envs[0].variables.map((v) => [v.key, v.value])).toEqual([['token', '']])
    const copyReqs = ws.requests.filter((r) => r.collectionId === b.cols[0].id)
    expect(copyReqs.map((r) => r.name)).toEqual(['Orders'])
    expect(copyReqs[0].id).not.toBe(req.id)
    expect(b.flows[0].id).not.toBe(a.flows[0].id)
    expect(b.flows[0].nodes.find((n) => n.type === 'request')?.config.requestId).toBe(copyReqs[0].id)
    expect(a.flows[0].nodes.find((n) => n.type === 'request')?.config.requestId).toBe(req.id)
  })

  it('refuses folders that hold something else', async () => {
    const { h } = mount()
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    fs.dir('/col').set('dispatch.collection.yaml', 'name: A\n')
    expect(await linkSpace(h.result.current, fs, h.result.current.spaces[0], '/col', yes)).toMatch(/other Dispatch files/)
    expect(await openSpaceFolder(h.result.current, fs, '/col', yes)).toMatch(/isn’t a Dispatch workspace folder/)
    expect(h.result.current.spaces[0].linkedDir).toBeUndefined()
  })
})
