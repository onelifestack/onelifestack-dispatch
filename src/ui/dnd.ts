import type { Collection, Folder, RequestDef } from '../core/types'
import { collectItems } from '../core/runner'

/**
 * Drag and drop between views. The sidebar puts saved requests and folders on the drag (DND_ITEMS); request tabs
 * put their tab id (DND_TAB). Drop targets check the types during dragover (the data itself is only readable on
 * drop) and read it on drop.
 */
export type DragItem = { kind: 'request' | 'folder'; id: string }

export const DND_ITEMS = 'application/x-dispatch-items'
export const DND_TAB = 'application/x-dispatch-tab'

type DT = Pick<DataTransfer, 'types' | 'getData' | 'setData'>

export const carries = (dt: DT | null | undefined, type: string) => !!dt && Array.from(dt.types ?? []).includes(type)

export function putItems(dt: DT, items: DragItem[]) { dt.setData(DND_ITEMS, JSON.stringify(items)) }

export function takeItems(dt: DT): DragItem[] {
  try {
    const v = JSON.parse(dt.getData(DND_ITEMS) || '[]')
    return Array.isArray(v) ? v.filter((x) => x && (x.kind === 'request' || x.kind === 'folder') && typeof x.id === 'string') : []
  } catch { return [] }
}

/** Copy instead of move: Ctrl (Windows/Linux) or Alt/Option (macOS), as in file managers. */
export const wantsCopy = (e: { ctrlKey: boolean; altKey: boolean }) => e.ctrlKey || e.altKey

/**
 * The requests a drop stands for, in sidebar order: requests as they are, folders expanded to the HTTP and
 * browser-login requests inside them (what the runner and flows can send). Duplicates are dropped.
 */
export function requestsOf(items: DragItem[], ws: { collections: Collection[]; folders: Folder[]; requests: RequestDef[] }): RequestDef[] {
  const out: RequestDef[] = []
  const add = (r: RequestDef | undefined) => { if (r && !out.some((x) => x.id === r.id)) out.push(r) }
  for (const it of items) {
    if (it.kind === 'request') { const r = ws.requests.find((x) => x.id === it.id); if (r && (r.protocol === 'http' || r.protocol === 'browser')) add(r); continue }
    const fo = ws.folders.find((x) => x.id === it.id)
    const col = fo && ws.collections.find((c) => c.id === fo.collectionId)
    if (fo && col) collectItems(col, fo.id, ws.folders, ws.requests).forEach((x) => add(x.request))
  }
  return out
}
