import { useState } from 'react'
import { DEFAULT_SPACE, type Space, spaceOf } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'

/** Add, rename and remove workspaces (groups of collections, environments and flows), and link them to folders. */
export function SpacesView({ ws, ask, confirm, notify }: { ws: WorkspaceApi; ask: (t: string, initial?: string) => Promise<string | null>; confirm: (m: string) => Promise<boolean>; notify: (m: string) => void }) {
  const desktop = ws.transport.unrestricted
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<string | void>) => async () => {
    if (busy) return
    setBusy(true)
    try { const m = await fn(); if (m) notify(m) } catch (e) { notify(String(e)) } finally { setBusy(false) }
  }
  const dirs = () => import('./linkedDirs')
  const link = (x: Space) => run(async () => {
    const { desktopFolders, linkSpace } = await dirs()
    const dir = await desktopFolders.pick(); if (!dir) return
    return linkSpace(ws, desktopFolders, x, dir, confirm)
  })
  const useFolder = (x: Space) => run(async () => {
    const { desktopFolders, reloadSpace } = await dirs()
    const warnings = await reloadSpace(ws, desktopFolders, x)
    return `Read “${x.name}” from ${x.linkedDir}. A backup was taken first.${warnings.length ? ` ${warnings.length} note${warnings.length > 1 ? 's' : ''}: ${warnings[0]}` : ''}`
  })
  const keepMine = (x: Space) => run(async () => {
    const { desktopFolders, syncSpace } = await dirs()
    await syncSpace(ws, desktopFolders, x, true)
    return `Wrote this device’s version of “${x.name}” to ${x.linkedDir}.`
  })
  const unlink = (x: Space) => run(async () => {
    const { unlinkSpace } = await dirs()
    await unlinkSpace(ws, x)
    return `Unlinked “${x.name}”; the files stay where they are.`
  })

  return (
    <section className="editor" aria-label="Workspaces">
      <p className="eyebrow">Workspaces</p>
      <h1 className="titleInput">Workspaces</h1>
      <p className="muted small">Group collections, environments and flows, e.g. one workspace per product or client. Switch from the top bar. Globals and history are shared by all workspaces. To move a collection or environment, use its ⋯ menu.</p>
      <table className="resultTable" aria-label="Workspaces list">
        <thead><tr><th>Name</th><th>Collections</th><th>Environments</th><th>Flows</th><th>Folder</th><th /></tr></thead>
        <tbody>
          {ws.spaces.map((x) => {
            const cols = ws.allCollections.filter((c) => spaceOf(c) === x.id).length
            const envs = ws.allEnvironments.filter((e) => spaceOf(e) === x.id).length
            const flows = ws.allFlows.filter((f) => spaceOf(f) === x.id).length
            const st = ws.folderStatus[`space:${x.id}`]
            return (
              <tr key={x.id} className={x.id === ws.activeSpaceId ? 'on' : ''}>
                <td style={{ whiteSpace: 'nowrap' }}><b>{x.name}</b>{x.id === ws.activeSpaceId && <span className="pill">open</span>}</td>
                <td>{cols}</td>
                <td>{envs}</td>
                <td>{flows}</td>
                <td className="small">
                  {x.linkedDir ? <>
                    <code style={{ overflowWrap: 'anywhere' }}>{x.linkedDir}</code>
                    {st?.error ? <p className="badText">Couldn’t write: {st.error}</p>
                      : st?.conflicts.length ? <div className="note warn" role="status">
                        <p><b>{st.conflicts.length} file{st.conflicts.length > 1 ? 's' : ''} changed outside Dispatch</b> and {st.conflicts.length > 1 ? 'were' : 'was'} left alone: <code>{st.conflicts.slice(0, 3).join(', ')}{st.conflicts.length > 3 ? ', …' : ''}</code></p>
                        <div className="actions">
                          <button type="button" className="btn small" disabled={busy} onClick={useFolder(x)}>Use the folder’s version</button>
                          <button type="button" className="btn small" disabled={busy} onClick={keepMine(x)}>Keep mine</button>
                        </div>
                      </div>
                      : st ? <p className="muted">In step with the folder.</p> : null}
                  </> : <span className="muted">—</span>}
                </td>
                <td className="rowActions">
                  {x.id !== ws.activeSpaceId && <button type="button" className="btn small" onClick={() => ws.switchSpace(x.id)}>Open</button>}
                  <button type="button" className="btn small ghost" onClick={async () => { const n = await ask('Rename workspace', x.name); if (n) await ws.renameSpace(x.id, n) }}>Rename</button>
                  {desktop && (x.linkedDir
                    ? <>
                      {!st?.conflicts.length && <button type="button" className="btn small ghost" disabled={busy} onClick={useFolder(x)}>Reload from folder</button>}
                      <button type="button" className="btn small ghost" disabled={busy} onClick={unlink(x)}>Unlink</button>
                    </>
                    : <button type="button" className="btn small ghost" disabled={busy} onClick={link(x)}>Link to a folder…</button>)}
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
        {desktop && <button type="button" className="btn" disabled={busy} onClick={run(async () => {
          const { desktopFolders, openSpaceFolder } = await dirs()
          const dir = await desktopFolders.pick(); if (!dir) return
          return openSpaceFolder(ws, desktopFolders, dir, confirm)
        })}>Open a workspace folder…</button>}
      </div>
      <p className="muted small">
        {desktop
          ? <>A workspace linked to a folder is kept there as plain files, one per request, environment and flow, ready for git. Secret values, history and schedules stay on this device. If a file changes outside Dispatch (an editor, <code>git pull</code>), Dispatch leaves it alone and asks which version to keep.</>
          : <>Linking a workspace to a folder of files needs the desktop app.</>}
      </p>
    </section>
  )
}
