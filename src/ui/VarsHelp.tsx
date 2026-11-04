import { useMemo, useState } from 'react'
import { fakeSamples } from '../core/fake'
import type { WorkspaceApi } from './useWorkspace'

/** A "{{ }}" panel listing every variable in scope (secrets masked) and the fake-data generators. Click copies. */
export function VarsHelp({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => {
    const out = new Map<string, { value: string; from: string; secret: boolean }>()
    const add = (vars: { key: string; value: string; enabled: boolean; secret?: boolean }[] | undefined, from: string) =>
      vars?.filter((v) => v.enabled && v.key.trim()).forEach((v) => out.set(v.key.trim(), { value: v.value, from, secret: !!v.secret }))
    add(ws.globals, 'globals')
    add(ws.collection?.variables, ws.collection ? `collection` : '')
    add(ws.environment?.variables, ws.environment ? ws.environment.name : '')
    return [...out.entries()]
  }, [ws.globals, ws.collection, ws.environment])
  const samples = useMemo(() => (open ? fakeSamples() : []), [open])
  const f = q.trim().toLowerCase()
  const copy = async (name: string) => {
    try { await navigator.clipboard.writeText(`{{${name}}}`); notify(`Copied {{${name}}}.`) } catch { notify(`Type {{${name}}} where you need it.`) }
  }
  return (
    <details className="menu varsHelp" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="btn small ghost" aria-label="Variables" title="Variables you can use">{'{{ }}'}</summary>
      {open && (
        <div className="menuList right varsList" role="dialog" aria-label="Variables you can use">
          <input type="search" placeholder="Find a variable" aria-label="Find a variable" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <p className="eyebrow">In scope</p>
          {rows.filter(([k]) => !f || k.toLowerCase().includes(f)).map(([k, v]) => (
            <button key={k} type="button" className="varRow" onClick={() => copy(k)}>
              <code>{`{{${k}}}`}</code><span className="muted small">{v.secret ? '••••••' : v.value.slice(0, 40)}</span><span className="tiny muted">{v.from}</span>
            </button>
          ))}
          {!rows.length && <p className="muted small">No variables yet. Add some to an environment, the collection or Globals.</p>}
          <p className="eyebrow">Generated each time</p>
          {samples.filter(([k]) => !f || k.toLowerCase().includes(f)).map(([k, v]) => (
            <button key={k} type="button" className="varRow" onClick={() => copy(k)}>
              <code>{`{{${k}}}`}</code><span className="muted small">{v.slice(0, 40)}</span>
            </button>
          ))}
        </div>
      )}
    </details>
  )
}
