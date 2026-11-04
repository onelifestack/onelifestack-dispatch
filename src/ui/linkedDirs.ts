import { useEffect, useRef } from 'react'
import { collectionToFiles, filesToCollection, literalSecrets } from '../core/fileFormat'
import type { Collection } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'

const yaml = () => import('yaml')
const invoke = async <T,>(cmd: string, args: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args)

/** Writes a collection to its folder (desktop). Returns the names of items whose literal secrets were left out. */
export async function writeCollectionDir(ws: WorkspaceApi, c: Collection, dir: string) {
  const { stringify } = await yaml()
  const files = collectionToFiles(c, ws.folders, ws.requests, (v) => stringify(v, { lineWidth: 0 }))
  await invoke('write_collection_dir', { root: dir, files: files.map((f) => [f.path, f.text]), prune: true })
  return literalSecrets(c, ws.folders, ws.requests)
}

/** Reads a collection folder, keeping this device's secrets for the same collection. */
export async function readCollectionDir(ws: WorkspaceApi, dir: string) {
  const { parse } = await yaml()
  const files = (await invoke<[string, string][]>('read_collection_dir', { root: dir })).map(([path, text]) => ({ path, text }))
  const rootId = (() => { try { return (parse(files.find((f) => f.path === 'dispatch.collection.yaml')?.text ?? '') as { id?: string })?.id } catch { return undefined } })()
  const local = ws.collections.find((c) => c.id === rootId) ?? null
  const r = filesToCollection(files, parse, { collection: local, folders: ws.folders, requests: ws.requests })
  r.collections[0].linkedDir = dir
  return r
}

export const pickFolder = () => invoke<string | null>('pick_folder', {})

/** Keeps linked collections' folders up to date as you edit (debounced, only when something changed). */
export function useLinkedDirSync(ws: WorkspaceApi, notify: (m: string) => void) {
  const last = useRef(new Map<string, string>())
  useEffect(() => {
    if (!ws.transport.unrestricted) return
    const linked = ws.collections.filter((c) => c.linkedDir)
    if (!linked.length) return
    const t = setTimeout(() => {
      void (async () => {
        const { stringify } = await yaml()
        for (const c of linked) {
          const files = collectionToFiles(c, ws.folders, ws.requests, (v) => stringify(v, { lineWidth: 0 }))
          const sig = JSON.stringify(files)
          if (last.current.get(c.id) === sig) continue
          try {
            await invoke('write_collection_dir', { root: c.linkedDir, files: files.map((f) => [f.path, f.text]), prune: true })
            last.current.set(c.id, sig)
          } catch (e) { notify(`Couldn’t write ${c.name} to ${c.linkedDir}: ${String(e)}`) }
        }
      })()
    }, 800)
    return () => clearTimeout(t)
  }, [ws.collections, ws.folders, ws.requests]) // eslint-disable-line react-hooks/exhaustive-deps
}
