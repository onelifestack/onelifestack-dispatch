import { useCallback, useEffect, useRef, useState } from 'react'
import * as db from '../core/db'
import { type Schedule, type ScheduleRun, RUNS_KEPT, isDue, newSchedule, runFailed, runSchedule } from '../core/schedules'
import { formatMs } from '../core/format'
import { isDesktop } from '../core/transport'
import type { WorkspaceApi } from './useWorkspace'
import { folderOptions } from './Dialogs'

async function notifyFailure(title: string, body: string) {
  if (isDesktop()) {
    try { const { invoke } = await import('@tauri-apps/api/core'); await invoke('notify_desktop', { title, body }); return } catch { /* fall through */ }
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body })
}

/** Runs due schedules while the app is open (checked every 30 s). */
export function useScheduler(ws: WorkspaceApi) {
  const [schedules, setSchedulesState] = useState<Schedule[]>([])
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const wsRef = useRef(ws); wsRef.current = ws
  const busy = useRef(false)
  useEffect(() => { void (async () => { setSchedulesState(await db.getSchedules()); setRuns(await db.getScheduleRuns()) })() }, [])

  const setSchedules = useCallback(async (next: Schedule[]) => { setSchedulesState(next); await db.putSchedules(next) }, [])

  const runNow = useCallback(async (s: Schedule, list?: Schedule[]) => {
    if (busy.current) return null
    busy.current = true; setRunning(s.id)
    try {
      const w = wsRef.current
      const r = await runSchedule(s, w, w.transport, w.pipeline.current)
      const nextRuns = [r, ...(await db.getScheduleRuns())].slice(0, RUNS_KEPT)
      setRuns(nextRuns); await db.putScheduleRuns(nextRuns)
      const current = list ?? await db.getSchedules()
      await setSchedules(current.map((x) => (x.id === s.id ? { ...x, lastRunAt: r.at } : x)))
      w.log([{ level: runFailed(r) ? 'warn' : 'info', at: Date.now(), source: 'schedule', text: `${s.name}: ${r.requests} requests, ${r.testsPassed} tests passed, ${r.testsFailed} failed${r.failedRequests ? `, ${r.failedRequests} errors` : ''}` }])
      if (runFailed(r) && s.notifyOnFailure) await notifyFailure(`Dispatch: ${s.name} failed`, r.failures.slice(0, 2).map((f) => `${f.name}: ${f.reason}`).join('\n') || 'See the Schedules screen.')
      return r
    } finally { busy.current = false; setRunning(null) }
  }, [setSchedules])

  useEffect(() => {
    const tick = async () => {
      const list = await db.getSchedules()
      const due = list.find((s) => isDue(s))
      if (due) await runNow(due, list)
    }
    const t = setInterval(() => { void tick() }, 30_000)
    return () => clearInterval(t)
  }, [runNow])

  return { schedules, runs, running, setSchedules, runNow }
}

export type SchedulerApi = ReturnType<typeof useScheduler>

export function SchedulesView({ ws, sched, notify }: { ws: WorkspaceApi; sched: SchedulerApi; notify: (m: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const upd = (id: string, patch: Partial<Schedule>) => void sched.setSchedules(sched.schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  return (
    <section className="editor wide" aria-label="Schedules">
      <p className="eyebrow">Schedules</p>
      <h1 className="titleInput">Scheduled runs</h1>
      <p className="muted small">Run a collection or folder every few minutes and get a notification when a request or test fails, like a monitor. Runs happen on this device while Dispatch is open; scripts’ variable changes aren’t kept.</p>
      {typeof Notification !== 'undefined' && !isDesktop() && Notification.permission === 'default' && (
        <p className="infoLine small">Allow notifications to hear about failures: <button type="button" className="btn small" onClick={() => void Notification.requestPermission()}>Allow</button></p>
      )}
      <div className="actions">
        <button type="button" className="btn primary" disabled={!ws.collections.length} onClick={() => {
          const c = ws.collections[0]
          void sched.setSchedules([...sched.schedules, newSchedule(c.id, `${c.name} check`)])
        }}>+ New schedule</button>
        {!ws.collections.length && <span className="muted small">Save a collection first.</span>}
      </div>
      {sched.schedules.map((s) => {
        const runs = sched.runs.filter((r) => r.scheduleId === s.id)
        const last = runs[0]
        return (
          <div key={s.id} className="schedCard">
            <div className="row-h">
              <label className="toggle"><input type="checkbox" checked={s.enabled} onChange={(e) => upd(s.id, { enabled: e.target.checked })} aria-label={`Enable ${s.name}`} /></label>
              <input className="grow schedName" aria-label="Schedule name" value={s.name} onChange={(e) => upd(s.id, { name: e.target.value })} />
              {last && <span className={`pill ${runFailed(last) ? 'badPill' : ''}`}>{runFailed(last) ? 'failing' : 'passing'}</span>}
              <button type="button" className="btn small" disabled={sched.running !== null} onClick={async () => { const r = await sched.runNow(s); if (r) { const n = r.testsFailed + r.failedRequests; notify(runFailed(r) ? `${s.name}: ${n} failure${n === 1 ? '' : 's'}.` : `${s.name} passed.`) } }}>
                {sched.running === s.id ? 'Running…' : 'Run now'}
              </button>
              <button type="button" className="icon" aria-label={`Delete ${s.name}`} onClick={() => void sched.setSchedules(sched.schedules.filter((x) => x.id !== s.id))}>×</button>
            </div>
            <div className="schedGrid">
              <label className="field"><span>Collection</span>
                <select value={s.collectionId} onChange={(e) => upd(s.id, { collectionId: e.target.value, folderId: null })}>{ws.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </label>
              <label className="field"><span>Folder</span>
                <select value={s.folderId ?? ''} onChange={(e) => upd(s.id, { folderId: e.target.value || null })}>
                  <option value="">Whole collection</option>
                  {folderOptions(ws.folders, s.collectionId).map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{`${'  '.repeat(depth)}${folder.name}`}</option>)}
                </select>
              </label>
              <label className="field"><span>Environment</span>
                <select value={s.environmentId ?? ''} onChange={(e) => upd(s.id, { environmentId: e.target.value || null })}>
                  <option value="">None</option>{ws.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Every (minutes)</span>
                <input type="number" min={1} max={1440} value={s.everyMinutes} onChange={(e) => upd(s.id, { everyMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || 15)) })} />
              </label>
              <label className="toggle"><input type="checkbox" checked={s.notifyOnFailure} onChange={(e) => upd(s.id, { notifyOnFailure: e.target.checked })} /> Notify on failure</label>
            </div>
            <p className="small muted">{last ? `Last run ${new Date(last.at).toLocaleString()}: ${last.requests} requests, ${last.testsPassed} passed, ${last.testsFailed} failed, avg ${formatMs(last.avgTimeMs)}.` : 'Not run yet.'}
              {runs.length > 0 && <>{' '}<button type="button" className="linkBtn small" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide history' : `History (${runs.length})`}</button></>}</p>
            {open === s.id && (
              <table className="resultTable" aria-label={`${s.name} history`}>
                <thead><tr><th>When</th><th>Result</th><th>Tests</th><th>Avg</th><th>Failures</th></tr></thead>
                <tbody>{runs.slice(0, 30).map((r) => (
                  <tr key={r.id} className={runFailed(r) ? 'bad' : ''}>
                    <td className="small">{new Date(r.at).toLocaleString()}</td>
                    <td>{runFailed(r) ? <span className="badText">failed</span> : <span className="goodText">passed</span>}</td>
                    <td className="small">{r.testsPassed}/{r.testsPassed + r.testsFailed}</td>
                    <td className="mono small">{formatMs(r.avgTimeMs)}</td>
                    <td className="small">{r.failures.map((f) => `${f.name}: ${f.reason}`).join(' · ')}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )
      })}
    </section>
  )
}
