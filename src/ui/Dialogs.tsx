import { useCallback, useEffect, useRef, useState } from 'react'
import type { Collection } from '../core/types'

type Pending =
  | { kind: 'ask'; title: string; initial: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; message: string; resolve: (v: boolean) => void }
  | { kind: 'save'; name: string; collections: Collection[]; collectionId: string | null; resolve: (v: { name: string; collectionId: string | null; newCollection: string | null } | null) => void }

/** Promise-based dialogs on a native <dialog>, so focus and Escape are handled by the browser. */
export function useDialogs() {
  const [pending, setPending] = useState<Pending | null>(null)
  const ask = useCallback((title: string, initial = '') => new Promise<string | null>((resolve) => setPending({ kind: 'ask', title, initial, resolve })), [])
  const confirm = useCallback((message: string) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', message, resolve })), [])
  const askSave = useCallback((name: string, collections: Collection[], collectionId: string | null) =>
    new Promise<{ name: string; collectionId: string | null; newCollection: string | null } | null>((resolve) =>
      setPending({ kind: 'save', name, collections, collectionId, resolve })), [])
  const node = pending ? <Dialog pending={pending} close={() => setPending(null)} /> : null
  return { ask, confirm, askSave, node }
}

function Dialog({ pending, close }: { pending: Pending; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(pending.kind === 'ask' ? pending.initial : pending.kind === 'save' ? pending.name : '')
  const [col, setCol] = useState(pending.kind === 'save' ? (pending.collectionId ?? (pending.collections[0]?.id ?? '__new')) : '')
  const [newCol, setNewCol] = useState('My API')

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '') }
  }, [])

  const finish = (ok: boolean) => {
    if (pending.kind === 'ask') pending.resolve(ok && text.trim() ? text.trim() : null)
    else if (pending.kind === 'confirm') pending.resolve(ok)
    else pending.resolve(ok && text.trim() ? {
      name: text.trim(),
      collectionId: col === '__none' || col === '__new' ? null : col,
      newCollection: col === '__new' ? (newCol.trim() || 'My API') : null,
    } : null)
    ref.current?.close?.()
    close()
  }

  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); finish(false) }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); finish(true) }}>
        {pending.kind === 'confirm' && <p>{pending.message}</p>}
        {pending.kind === 'ask' && <label className="field"><span>{pending.title}</span><input autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>}
        {pending.kind === 'save' && <>
          <h2>Save request</h2>
          <label className="field"><span>Name</span><input autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>
          <label className="field"><span>Collection</span>
            <select value={col} onChange={(e) => setCol(e.target.value)}>
              {pending.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new">New collection…</option>
              <option value="__none">No collection</option>
            </select>
          </label>
          {col === '__new' && <label className="field"><span>New collection name</span><input value={newCol} onChange={(e) => setNewCol(e.target.value)} /></label>}
        </>}
        <div className="actions end">
          <button type="button" className="btn ghost" onClick={() => finish(false)}>Cancel</button>
          <button type="submit" className={`btn ${pending.kind === 'confirm' && /delete|clear/i.test(pending.message) ? 'danger' : 'primary'}`}>
            {pending.kind === 'confirm' ? (/delete/i.test(pending.message) ? 'Delete' : /clear/i.test(pending.message) ? 'Clear' : 'OK') : pending.kind === 'save' ? 'Save' : 'OK'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
