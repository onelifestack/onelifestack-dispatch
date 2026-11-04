import { getBackup } from '../core/db'
import { exportWorkspace } from '../core/backup'
import type { WorkspaceApi } from './useWorkspace'
import { saveTextFile } from './files'

const REASON = { daily: 'Daily', manual: 'Made by you', 'before-restore': 'Before a restore' } as const

/** Local backups: a daily snapshot plus ones you make; restore replaces everything (after backing up first). */
export function BackupsView({ ws, notify, confirm }: { ws: WorkspaceApi; notify: (m: string) => void; confirm: (m: string) => Promise<boolean> }) {
  return (
    <section className="editor" aria-label="Backups">
      <p className="eyebrow">Backups</p>
      <h1 className="titleInput">Local backups</h1>
      <p className="muted small">Dispatch keeps a backup of your collections, environments and globals once a day, on this device only (the newest 10). Secrets stay encrypted inside them. Restoring replaces everything, and backs up what you have now first, so a restore can be undone too.</p>
      <div className="actions">
        <button type="button" className="btn primary" onClick={async () => { await ws.backupNow(); notify('Backup made.') }}>Back up now</button>
      </div>
      {ws.backups.length ? (
        <table className="resultTable" aria-label="Backups">
          <thead><tr><th>When</th><th>Kind</th><th>Contents</th><th /></tr></thead>
          <tbody>
            {ws.backups.map((b) => (
              <tr key={b.id}>
                <td>{new Date(b.at).toLocaleString()}</td>
                <td className="muted">{REASON[b.reason]}</td>
                <td className="small">{b.counts.collections} collections · {b.counts.requests} requests · {b.counts.environments} environments</td>
                <td className="rowActions">
                  <button type="button" className="btn small" onClick={async () => {
                    if (!(await confirm(`Restore the backup from ${new Date(b.at).toLocaleString()}? Everything you have now is replaced (and backed up first).`))) return
                    notify((await ws.restoreBackup(b.id)) ? 'Backup restored.' : 'That backup couldn’t be read.')
                  }}>Restore</button>
                  <button type="button" className="btn small ghost" onClick={async () => {
                    const data = await getBackup(b.id)
                    if (!data) return
                    if (await saveTextFile(`dispatch-backup-${new Date(b.at).toISOString().slice(0, 10)}.json`, exportWorkspace(data))) notify('Saved. Secret values are left out of downloaded backups.')
                  }}>Download</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">No backups yet. The first one is made the next time you open Dispatch with something saved, or press Back up now.</p>}
    </section>
  )
}
