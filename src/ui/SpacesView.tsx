import { DEFAULT_SPACE, spaceOf } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'

/** Add, rename and remove workspaces (groups of collections and environments). */
export function SpacesView({ ws, ask, notify }: { ws: WorkspaceApi; ask: (t: string, initial?: string) => Promise<string | null>; notify: (m: string) => void }) {
  return (
    <section className="editor" aria-label="Workspaces">
      <p className="eyebrow">Workspaces</p>
      <h1 className="titleInput">Workspaces</h1>
      <p className="muted small">Group collections and environments, e.g. one workspace per product or client. Switch from the top bar. Globals and history are shared by all workspaces. To move a collection or environment, use its ⋯ menu.</p>
      <table className="resultTable" aria-label="Workspaces list">
        <thead><tr><th>Name</th><th>Collections</th><th>Environments</th><th /></tr></thead>
        <tbody>
          {ws.spaces.map((x) => {
            const cols = ws.allCollections.filter((c) => spaceOf(c) === x.id).length
            const envs = ws.allEnvironments.filter((e) => spaceOf(e) === x.id).length
            return (
              <tr key={x.id} className={x.id === ws.activeSpaceId ? 'on' : ''}>
                <td><b>{x.name}</b>{x.id === ws.activeSpaceId && <span className="pill">open</span>}</td>
                <td>{cols}</td>
                <td>{envs}</td>
                <td className="rowActions">
                  {x.id !== ws.activeSpaceId && <button type="button" className="btn small" onClick={() => ws.switchSpace(x.id)}>Open</button>}
                  <button type="button" className="btn small ghost" onClick={async () => { const n = await ask('Rename workspace', x.name); if (n) await ws.renameSpace(x.id, n) }}>Rename</button>
                  {x.id !== DEFAULT_SPACE.id && <button type="button" className="btn small danger" onClick={async () => {
                    notify((await ws.removeSpace(x.id)) ? `Removed ${x.name}.` : `Move or delete ${x.name}’s collections and environments first.`)
                  }}>Remove</button>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="actions">
        <button type="button" className="btn primary" onClick={async () => { const n = await ask('New workspace'); if (n) { const sp = await ws.addSpace(n); ws.switchSpace(sp.id) } }}>+ New workspace</button>
      </div>
    </section>
  )
}
