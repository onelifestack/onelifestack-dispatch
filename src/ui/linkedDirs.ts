/**
 * Linked folders (desktop): a workspace or a single collection kept as files, for git. The app's own storage stays
 * the working copy; the folder mirrors it. A file changed outside the app since the app last saw it is never
 * overwritten or deleted: it is reported as a conflict until the user picks a side. See
 * docs/DESIGN-linked-workspaces.md.
 */
import { useEffect, useRef } from 'react'
import * as db from '../core/db'
import { type FileEntry, collectionToFiles, filesToCollection, literalSecrets } from '../core/fileFormat'
import { type WorkspaceContent, filesToWorkspace, reIdTaken, workspaceHeader, workspaceToFiles } from '../core/workspaceFiles'
import { type Collection, DEFAULT_SPACE, type Space, folderIdOf, spaceOf } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'

const yaml = () => import('yaml')
const dump = async () => { const { stringify } = await yaml(); return (v: unknown) => stringify(v, { lineWidth: 0 }) }

/** The file operations linking needs; the desktop app's are below, tests pass their own. */
export interface FolderApi {
  pick(): Promise<string | null>
  /** Dispatch files under the folder (empty when it doesn't exist). */
  read(root: string): Promise<{ path: string; text: string; hash: string }[]>
  /** Writes `files`, leaving anything changed outside the app alone (`known: null` = overwrite regardless). */
  sync(root: string, files: FileEntry[], known: Record<string, string> | null): Promise<{ known: Record<string, string>; conflicts: string[] }>
}

const invoke = async <T,>(cmd: string, args: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args)
export const desktopFolders: FolderApi = {
  pick: () => invoke<string | null>('pick_folder', {}),
  read: async (root) => (await invoke<[string, string, string][]>('read_folder', { root })).map(([path, text, hash]) => ({ path, text, hash })),
  sync: (root, files, known) => invoke('sync_folder', { root, files: files.map((f) => [f.path, f.text]), known }),
}

export const spaceKey = (id: string) => `space:${id}`
export const collectionKey = (id: string) => `collection:${id}`

/** What a linked workspace writes: everything in it except collections that have a folder of their own. */
export function spaceContent(ws: WorkspaceApi, space: Space): WorkspaceContent {
  const collections = ws.allCollections.filter((c) => spaceOf(c) === space.id && !c.linkedDir)
  const ids = new Set(collections.map((c) => c.id))
  return {
    space: { id: folderIdOf(space), name: space.name }, collections,
    folders: ws.folders.filter((f) => ids.has(f.collectionId)), requests: ws.requests.filter((r) => !!r.collectionId && ids.has(r.collectionId)),
    environments: ws.allEnvironments.filter((e) => spaceOf(e) === space.id), flows: ws.allFlows.filter((f) => spaceOf(f) === space.id),
  }
}

/** Writes one linked folder and records what happened. Returns the conflicts. */
async function syncOne(ws: WorkspaceApi, fs: FolderApi, key: string, dir: string, files: FileEntry[], force = false) {
  const state = force ? 'force' : (await db.getFolderState(key)) ?? {}
  try {
    if (state !== 'force') files = await holdBackRenames(fs, dir, files, state)
    const r = await fs.sync(dir, files, state === 'force' ? null : state)
    await db.putFolderState(key, r.known)
    ws.setFolderStatus(key, { conflicts: r.conflicts, at: Date.now() })
    return r.conflicts
  } catch (e) {
    ws.setFolderStatus(key, { conflicts: [], error: String(e), at: Date.now() })
    throw e
  }
}

/** An item file's own id (its top-level `id:` line). */
const fileId = (text: string) => /^id: *["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1]

/**
 * A rename writes the item under a new file name and deletes the old file. If the old file changed outside the
 * app, it can't be deleted, and writing the new one would leave two files for one item. Until the user picks a
 * side, such renamed files are not written (the old file is reported as a conflict by the sync).
 */
async function holdBackRenames(fs: FolderApi, dir: string, files: FileEntry[], known: Record<string, string>) {
  const wanted = new Set(files.map((f) => f.path))
  const disk = await fs.read(dir)
  const onDisk = new Set(disk.map((f) => f.path))
  const stuck = new Set(disk.filter((f) => !wanted.has(f.path) && known[f.path] !== f.hash).map((f) => fileId(f.text)).filter(Boolean))
  if (!stuck.size) return files
  return files.filter((f) => onDisk.has(f.path) || !stuck.has(fileId(f.text)))
}

export async function syncSpace(ws: WorkspaceApi, fs: FolderApi, space: Space, force = false) {
  if (!space.linkedDir) return []
  return syncOne(ws, fs, spaceKey(space.id), space.linkedDir, workspaceToFiles(spaceContent(ws, space), await dump()), force)
}
export async function syncCollection(ws: WorkspaceApi, fs: FolderApi, c: Collection, force = false) {
  if (!c.linkedDir) return []
  return syncOne(ws, fs, collectionKey(c.id), c.linkedDir, collectionToFiles(c, ws.folders, ws.requests, await dump()), force)
}

const remember = (files: { path: string; hash: string }[]) => Object.fromEntries(files.map((f) => [f.path, f.hash]))

/** "Use the folder's version": the workspace becomes what the folder holds (after a backup). Returns warnings. */
export async function reloadSpace(ws: WorkspaceApi, fs: FolderApi, space: Space, read?: Awaited<ReturnType<FolderApi['read']>>) {
  if (!space.linkedDir) return []
  const files = read ?? await fs.read(space.linkedDir)
  const { parse } = await yaml()
  // Only this workspace's own items may lend their secrets or keep their ids; another workspace's never move here.
  const cols = ws.allCollections.filter((c) => spaceOf(c) === space.id)
  const colIds = new Set(cols.map((c) => c.id))
  const own = {
    collections: cols, folders: ws.folders.filter((f) => colIds.has(f.collectionId)),
    requests: ws.requests.filter((q) => q.collectionId !== null && colIds.has(q.collectionId)),
    environments: ws.allEnvironments.filter((e) => spaceOf(e) === space.id),
  }
  const mine = new Set([...own.collections, ...own.folders, ...own.requests, ...own.environments, ...ws.allFlows.filter((f) => spaceOf(f) === space.id)].map((x) => x.id))
  const taken = new Set([...ws.allCollections, ...ws.folders, ...ws.requests, ...ws.allEnvironments, ...ws.allFlows].map((x) => x.id).filter((x) => !mine.has(x)))
  const r = reIdTaken(filesToWorkspace(files, parse, own), taken)
  if (r.space.id !== folderIdOf(space)) throw new Error(`That folder now holds a different workspace (“${r.space.name}”).`)
  await ws.backupNow('before-folder')
  const here = <T extends { workspaceId?: string }>(x: T) => ({ ...x, workspaceId: space.id })
  await ws.replaceSpaceContents(space.id, { ...r, collections: r.collections.map(here), environments: r.environments.map(here), flows: r.flows.map(here) })
  await db.putFolderState(spaceKey(space.id), remember(files))
  ws.setFolderStatus(spaceKey(space.id), { conflicts: [], at: Date.now() })
  return r.warnings
}

/** "Use the folder's version" for a collection with its own folder. */
export async function reloadCollection(ws: WorkspaceApi, fs: FolderApi, c: Collection) {
  const files = await fs.read(c.linkedDir)
  if (!files.some((f) => f.path === 'dispatch.collection.yaml')) throw new Error(`${c.linkedDir} has no dispatch.collection.yaml.`)
  const { parse } = await yaml()
  const r = filesToCollection(files, parse, { collection: c, folders: ws.folders, requests: ws.requests })
  r.collections[0] = { ...r.collections[0], linkedDir: c.linkedDir, workspaceId: c.workspaceId }
  await ws.replaceCollection(r)
  await db.putFolderState(collectionKey(c.id), remember(files))
  ws.setFolderStatus(collectionKey(c.id), { conflicts: [], at: Date.now() })
  return r
}

/** Opens a collection folder (the ☰ menu): adds or updates that collection and keeps it linked. */
export async function openCollectionFolder(ws: WorkspaceApi, fs: FolderApi, dir: string) {
  const files = await fs.read(dir)
  if (!files.some((f) => f.path === 'dispatch.collection.yaml')) throw new Error(`${dir} has no dispatch.collection.yaml.`)
  const { parse } = await yaml()
  const rootId = (parse(files.find((f) => f.path === 'dispatch.collection.yaml')!.text) as { id?: string } | null)?.id
  const local = ws.allCollections.find((c) => c.id === rootId) ?? null
  const r = filesToCollection(files, parse, { collection: local, folders: ws.folders, requests: ws.requests })
  r.collections[0] = { ...r.collections[0], linkedDir: dir, workspaceId: local?.workspaceId ?? ws.activeSpaceId }
  await ws.replaceCollection(r)
  await db.putFolderState(collectionKey(r.collections[0].id), remember(files))
  return r
}

/** Links a collection to a folder ("Save to a folder…"): writes it there, replacing what the folder had. */
export async function linkCollection(ws: WorkspaceApi, fs: FolderApi, c: Collection, dir: string) {
  await syncOne(ws, fs, collectionKey(c.id), dir, collectionToFiles(c, ws.folders, ws.requests, await dump()), true)
  return literalSecrets(c, ws.folders, ws.requests)
}

type Ask = (message: string) => Promise<boolean>

/**
 * "Link to a folder…" on a workspace. An empty folder gets the workspace written into it. A folder that already
 * holds this workspace (linked before) asks which side wins. Anything else is refused. Returns a message for the user.
 */
export async function linkSpace(ws: WorkspaceApi, fs: FolderApi, space: Space, dir: string, confirm: Ask): Promise<string> {
  const other = ws.spaces.find((x) => x.linkedDir === dir && x.id !== space.id)
  if (other) return `That folder is already linked to the workspace “${other.name}”.`
  const files = await fs.read(dir)
  const { parse } = await yaml()
  const head = workspaceHeader(files, parse)
  if (files.length && !head) return 'That folder holds other Dispatch files (a collection folder?). Pick an empty folder, or a folder this workspace was linked to before.'
  if (head && head.id !== folderIdOf(space)) return `That folder holds the workspace “${head.name}”. Use “Open a workspace folder…” to add it.`
  if (space.id === DEFAULT_SPACE.id && !space.folderId) { space = { ...space, folderId: crypto.randomUUID() }; await ws.setSpaceFolderId(space.id, space.folderId!) }

  const own = ws.allCollections.filter((c) => spaceOf(c) === space.id && c.linkedDir)
  let moved = 0
  if (own.length && await confirm(`${own.length === 1 ? `“${own[0].name}” already has` : `${own.length} collections in this workspace already have`} a folder of its own. Move ${own.length === 1 ? 'it' : 'them'} into the workspace folder? The old folders stay as they are.`)) {
    for (const c of own) { await ws.updateCollection({ ...c, linkedDir: '' }); await db.putFolderState(collectionKey(c.id), undefined); ws.setFolderStatus(collectionKey(c.id), null) }
    moved = own.length
  }
  const linked = { ...space, linkedDir: dir }
  if (head) {
    if (await confirm(`This folder already holds “${head.name}”. Use the folder’s version? (A backup is taken first.) Cancel keeps this workspace’s version and overwrites the files.`)) {
      await ws.setSpaceFolder(space.id, dir)
      const warnings = await reloadSpace(ws, fs, linked, files)
      return `Linked to ${dir} and read the folder.${warnings.length ? ` ${warnings[0]}` : ''}`
    }
    await db.putFolderState(spaceKey(space.id), 'force')
  } else {
    await db.putFolderState(spaceKey(space.id), {})
  }
  await ws.setSpaceFolder(space.id, dir) // the folder sync writes it shortly
  return `Linked to ${dir}. Changes are written there as you work${moved ? `; ${moved} collection${moved > 1 ? 's' : ''} moved in` : ''}. Secret values stay on this device.`
}

/** "Open a workspace folder…": adds the workspace a folder holds (or re-links the one this device has) and opens it. */
export async function openSpaceFolder(ws: WorkspaceApi, fs: FolderApi, dir: string, confirm: Ask): Promise<string> {
  const already = ws.spaces.find((x) => x.linkedDir === dir)
  if (already) { ws.switchSpace(already.id); return `“${already.name}” is already linked to that folder.` }
  const files = await fs.read(dir)
  const { parse } = await yaml()
  const head = workspaceHeader(files, parse)
  if (!head) return 'That folder isn’t a Dispatch workspace folder (it has no dispatch.workspace.yaml).'
  const mine = ws.spaces.find((x) => folderIdOf(x) === head.id)
  if (mine && !await confirm(`You already have this workspace (“${mine.name}”). Link it to this folder and use the folder’s version? A backup is taken first.`)) return 'Nothing changed.'
  const space: Space = { ...(mine ?? head), linkedDir: dir }
  await ws.addSpaceFrom(space)
  await ws.setSpaceFolder(space.id, dir)
  const warnings = await reloadSpace(ws, fs, space, files)
  ws.switchSpace(space.id)
  return `Opened “${space.name}” from ${dir}.${warnings.length ? ` ${warnings.length} note${warnings.length > 1 ? 's' : ''}: ${warnings[0]}` : ''}`
}

export async function unlinkSpace(ws: WorkspaceApi, space: Space) {
  await ws.setSpaceFolder(space.id, undefined)
  await db.putFolderState(spaceKey(space.id), undefined)
  ws.setFolderStatus(spaceKey(space.id), null)
}
export async function unlinkCollection(ws: WorkspaceApi, c: Collection) {
  await ws.updateCollection({ ...c, linkedDir: '' })
  await db.putFolderState(collectionKey(c.id), undefined)
  ws.setFolderStatus(collectionKey(c.id), null)
}

/**
 * Keeps every linked folder up to date as you edit (debounced; only folders whose files changed). Also runs once
 * at start, which is when changes made outside the app while it was closed show up as conflicts.
 */
export function useFolderSync(ws: WorkspaceApi, notify: (m: string) => void, fs: FolderApi = desktopFolders) {
  const last = useRef(new Map<string, string>())
  useEffect(() => {
    if (!ws.transport.unrestricted || !ws.ready) return
    const spaces = ws.spaces.filter((x) => x.linkedDir)
    const cols = ws.allCollections.filter((c) => c.linkedDir)
    if (!spaces.length && !cols.length) return
    const t = setTimeout(() => {
      void (async () => {
        const stringify = await dump()
        const jobs: { key: string; dir: string; name: string; files: FileEntry[] }[] = [
          ...spaces.map((x) => ({ key: spaceKey(x.id), dir: x.linkedDir!, name: x.name, files: workspaceToFiles(spaceContent(ws, x), stringify) })),
          ...cols.map((c) => ({ key: collectionKey(c.id), dir: c.linkedDir, name: c.name, files: collectionToFiles(c, ws.folders, ws.requests, stringify) })),
        ]
        for (const j of jobs) {
          const sig = `${j.dir}\n${JSON.stringify(j.files)}`
          if (last.current.get(j.key) === sig) continue
          const before = ws.folderStatus[j.key]?.conflicts.length ?? 0
          try {
            const conflicts = await syncOne(ws, fs, j.key, j.dir, j.files)
            last.current.set(j.key, sig)
            if (conflicts.length && conflicts.length !== before) notify(`${conflicts.length} file${conflicts.length > 1 ? 's' : ''} in ${j.dir} changed outside Dispatch and ${conflicts.length > 1 ? 'were' : 'was'} left alone. Choose which version to keep on ${j.key.startsWith('space:') ? 'the Workspaces page' : `the “${j.name}” collection page`}.`)
          } catch (e) { notify(`Couldn’t write ${j.name} to ${j.dir}: ${String(e)}`) }
        }
      })()
    }, 800)
    return () => clearTimeout(t)
  }, [ws.ready, ws.spaces, ws.allCollections, ws.folders, ws.requests, ws.allEnvironments, ws.allFlows]) // eslint-disable-line react-hooks/exhaustive-deps
}
