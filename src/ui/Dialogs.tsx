import { useCallback, useEffect, useRef, useState } from 'react'
import type { Collection, Folder } from '../core/types'

export interface Place { collectionId: string | null; folderId: string | null }
export interface SaveChoice extends Place { name: string; newCollection: string | null }

type Pending =
  | { kind: 'ask'; title: string; initial: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; message: string; resolve: (v: boolean) => void }
  | { kind: 'save'; title: string; name: string | null; collections: Collection[]; folders: Folder[]; place: Place; resolve: (v: SaveChoice | null) => void }

/** Promise-based dialogs on a native <dialog>, so focus and Escape are handled by the browser. */
export function useDialogs() {
  const [pending, setPending] = useState<Pending | null>(null)
  const ask = useCallback((title: string, initial = '') => new Promise<string | null>((resolve) => setPending({ kind: 'ask', title, initial, resolve })), [])
  const confirm = useCallback((message: string) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', message, resolve })), [])
  const askSave = useCallback((name: string, collections: Collection[], folders: Folder[], place: Place) =>
    new Promise<SaveChoice | null>((resolve) => setPending({ kind: 'save', title: 'Save request', name, collections, folders, place, resolve })), [])
  /** Choose a collection + folder (no name). */
  const askPlace = useCallback((title: string, collections: Collection[], folders: Folder[], place: Place) =>
    new Promise<Place | null>((resolve) => setPending({ kind: 'save', title, name: null, collections, folders, place,
      resolve: (v) => resolve(v ? { collectionId: v.collectionId, folderId: v.folderId } : null) })), [])
  const node = pending ? <Dialog pending={pending} close={() => setPending(null)} /> : null
  return { ask, confirm, askSave, askPlace, node }
}

/** Folders of a collection in tree order, with their depth. */
export function folderOptions(folders: Folder[], collectionId: string): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    folders.filter((f) => f.collectionId === collectionId && f.parentId === parent).sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => { out.push({ folder: f, depth }); walk(f.id, depth + 1) })
  }
  walk(null, 0)
  return out
}

function Dialog({ pending, close }: { pending: Pending; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(pending.kind === 'ask' ? pending.initial : pending.kind === 'save' ? (pending.name ?? '') : '')
  const [col, setCol] = useState(pending.kind === 'save' ? (pending.place.collectionId ?? (pending.collections[0]?.id ?? (pending.name === null ? '__none' : '__new'))) : '')
  const [folder, setFolder] = useState(pending.kind === 'save' ? (pending.place.folderId ?? '') : '')
  const [newCol, setNewCol] = useState('My API')

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '') }
  }, [])

  const finish = (ok: boolean) => {
    if (pending.kind === 'ask') pending.resolve(ok && text.trim() ? text.trim() : null)
    else if (pending.kind === 'confirm') pending.resolve(ok)
    else {
      const named = pending.name === null || text.trim()
      pending.resolve(ok && named ? {
        name: text.trim(),
        collectionId: col === '__none' || col === '__new' ? null : col,
        folderId: col === '__none' || col === '__new' || !folder ? null : folder,
        newCollection: col === '__new' ? (newCol.trim() || 'My API') : null,
      } : null)
    }
    ref.current?.close?.()
    close()
  }

  const danger = pending.kind === 'confirm' && /delete|clear|discard/i.test(pending.message)
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); finish(false) }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); finish(true) }}>
        {pending.kind === 'confirm' && <p>{pending.message}</p>}
        {pending.kind === 'ask' && <label className="field"><span>{pending.title}</span><input autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>}
        {pending.kind === 'save' && <>
          <h2>{pending.title}</h2>
          {pending.name !== null && <label className="field"><span>Name</span><input autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>}
          <label className="field"><span>Collection</span>
            <select value={col} onChange={(e) => { setCol(e.target.value); setFolder('') }}>
              {pending.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {pending.name !== null && <option value="__new">New collection…</option>}
              <option value="__none">No collection</option>
            </select>
          </label>
          {col === '__new' && <label className="field"><span>New collection name</span><input value={newCol} onChange={(e) => setNewCol(e.target.value)} /></label>}
          {col !== '__new' && col !== '__none' && folderOptions(pending.folders, col).length > 0 && (
            <label className="field"><span>Folder</span>
              <select value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="">(top level)</option>
                {folderOptions(pending.folders, col).map(({ folder: f, depth }) => <option key={f.id} value={f.id}>{`${'  '.repeat(depth)}${f.name}`}</option>)}
              </select>
            </label>
          )}
        </>}
        <div className="actions end">
          <button type="button" className="btn ghost" onClick={() => finish(false)}>Cancel</button>
          <button type="submit" className={`btn ${danger ? 'danger' : 'primary'}`}>
            {pending.kind === 'confirm'
              ? (/delete/i.test(pending.message) ? 'Delete' : /clear/i.test(pending.message) ? 'Clear' : /discard/i.test(pending.message) ? 'Discard' : 'OK')
              : pending.kind === 'save' ? (pending.name === null ? 'Move' : 'Save') : 'OK'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
