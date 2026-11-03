import { useEffect, useState } from 'react'
import type { Collection, Environment } from '../core/types'
import { KVTable } from './KVTable'
import { AuthEditor } from './AuthEditor'
import type { WorkspaceApi } from './useWorkspace'

/**
 * Edits save as you type, like settings, so there's no separate Save step to forget. Local state keeps typing
 * smooth; every change is also written straight away, so switching away never loses the last keystroke.
 */
function useSaved<T extends { id: string }>(value: T, save: (v: T) => Promise<void>) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return [local, (next: T) => { setLocal(next); void save(next) }] as const
}

interface Common { ws: WorkspaceApi; confirm: (msg: string) => Promise<boolean> }

export function CollectionEditor({ ws, confirm, collection }: Common & { collection: Collection }) {
  const [c, setC] = useSaved(collection, ws.updateCollection)
  const count = ws.requests.filter((r) => r.collectionId === c.id).length
  return (
    <section className="editor" aria-label="Collection">
      <p className="eyebrow">Collection</p>
      <input className="titleInput" value={c.name} aria-label="Collection name" onChange={(e) => setC({ ...c, name: e.target.value })} />
      <p className="muted small">{count} saved request{count === 1 ? '' : 's'}. Changes save automatically.</p>
      <h2>Auth</h2>
      <p className="muted small">Requests set to “Inherit from collection” use this.</p>
      <AuthEditor auth={c.auth} allowInherit={false} onChange={(auth) => setC({ ...c, auth })} />
      <h2>Variables</h2>
      <p className="muted small">Available to every request in this collection as <code>{'{{name}}'}</code>. The active environment overrides them.</p>
      <KVTable label="Collection variables" keyPlaceholder="Variable" rows={c.variables} onChange={(variables) => setC({ ...c, variables })} />
      <div className="actions">
        <button type="button" className="btn" onClick={() => ws.startNew(c.id)}>New request here</button>
        <button type="button" className="btn danger" onClick={async () => {
          if (await confirm(`Delete “${c.name}” and its ${count} request${count === 1 ? '' : 's'}? This can’t be undone.`)) await ws.removeCollection(c.id)
        }}>Delete collection</button>
      </div>
    </section>
  )
}

export function EnvironmentEditor({ ws, confirm, environment }: Common & { environment: Environment }) {
  const [e, setE] = useSaved(environment, ws.updateEnvironment)
  const active = ws.settings.activeEnvId === e.id
  return (
    <section className="editor" aria-label="Environment">
      <p className="eyebrow">Environment</p>
      <input className="titleInput" value={e.name} aria-label="Environment name" onChange={(ev) => setE({ ...e, name: ev.target.value })} />
      <p className="muted small">Changes save automatically. Values stay on this device.</p>
      <div className="actions">
        <button type="button" className={`btn ${active ? '' : 'primary'}`} onClick={() => ws.setSettings({ activeEnvId: active ? null : e.id })}>
          {active ? 'Stop using' : 'Use this environment'}
        </button>
      </div>
      <h2>Variables</h2>
      <KVTable label="Environment variables" keyPlaceholder="Variable" rows={e.variables} onChange={(variables) => setE({ ...e, variables })} />
      <div className="actions">
        <button type="button" className="btn danger" onClick={async () => { if (await confirm(`Delete environment “${e.name}”?`)) await ws.removeEnvironment(e.id) }}>Delete environment</button>
      </div>
    </section>
  )
}
