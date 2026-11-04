import { useEffect, useMemo, useRef, useState } from 'react'
import { type RunItem, type RunResult, type RunSummary, collectItems, failed, runCollection, toJUnit, toJsonReport } from '../core/runner'
import { parseDataFile } from '../core/csv'
import { formatMs, statusTone } from '../core/format'
import type { WorkspaceApi } from './useWorkspace'
import { folderOptions } from './Dialogs'
import { saveTextFile } from './files'
import { layerRows, layeredVars } from '../core/layers'

interface Target { collectionId: string; folderId: string | null }
interface Pick extends RunItem { on: boolean; key: string }

const readText = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Couldn’t read that file.')); r.readAsText(file)
})

export function RunnerView({ ws, notify, start }: { ws: WorkspaceApi; notify: (m: string) => void; start: Target | null }) {
  const [targets, setTargets] = useState<Target[]>(() => (start ? [start] : ws.collections[0] ? [{ collectionId: ws.collections[0].id, folderId: null }] : []))
  const [picks, setPicks] = useState<Pick[]>([])
  const [iterations, setIterations] = useState(1)
  const [delayMs, setDelayMs] = useState(0)
  const [stopOnFailure, setStopOnFailure] = useState(false)
  const [saveVars, setSaveVars] = useState(true)
  const [data, setData] = useState<{ name: string; rows: Record<string, string>[] } | null>(null)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<RunResult[]>([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [summary, setSummary] = useState<RunSummary | null>(null)
  const [inspect, setInspect] = useState<RunResult | null>(null)
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [perLayer, setPerLayer] = useState('')
  const layers = perLayer ? layerRows(ws.environment, perLayer) : []
  const abort = useRef<AbortController | null>(null)

  // Rebuild the request list when targets change, keeping on/off choices and order where possible.
  const targetKey = JSON.stringify(targets)
  useEffect(() => {
    const fresh: Pick[] = []
    for (const t of targets) {
      const c = ws.collections.find((x) => x.id === t.collectionId)
      if (!c) continue
      for (const it of collectItems(c, t.folderId, ws.folders, ws.requests)) fresh.push({ ...it, on: true, key: `${t.collectionId}:${t.folderId}:${it.request.id}` })
    }
    setPicks((old) => fresh.map((p) => ({ ...p, on: old.find((o) => o.key === p.key)?.on ?? true })))
  }, [targetKey, ws.collections, ws.folders, ws.requests]) // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = picks.filter((p) => p.on)
  const its = layers.length ? layers.length : data && iterations === 0 ? data.rows.length : Math.max(1, iterations)
  const move = (i: number, d: -1 | 1) => setPicks((ps) => { const n = [...ps]; const j = i + d; if (j < 0 || j >= n.length) return ps; [n[i], n[j]] = [n[j], n[i]]; return n })

  const run = async () => {
    if (!chosen.length) { notify('Pick at least one request to run.'); return }
    const ctrl = new AbortController(); abort.current = ctrl
    setRunning(true); setResults([]); setSummary(null); setInspect(null); setProgress({ done: 0, total: its * chosen.length })
    const s = await runCollection({
      items: chosen, delayMs, stopOnFailure,
      ...(layers.length
        ? { iterations: 0, data: layers.map((l) => l.row), iterationLabels: layers.map((l) => `${perLayer}: ${l.label}`) }
        : { iterations: data && iterations === 0 ? 0 : Math.max(1, iterations), data: data?.rows ?? null }),
      environment: ws.environment, collections: ws.collections, folders: ws.folders, globals: ws.globals, settings: ws.settings,
    }, ws.transport, ws.pipeline.current, {
      signal: ctrl.signal,
      onResult: (r, done, total) => { setResults((rs) => [...rs, r]); setProgress({ done, total }); ws.log(r.detail.logs) },
    })
    abort.current = null
    setRunning(false); setSummary(s)
    if (saveVars) {
      if (s.finalEnvironment && ws.environment) await ws.updateEnvironment({ ...ws.environment, variables: s.finalEnvironment })
      for (const [id, vars] of Object.entries(s.finalCollections)) {
        const c = ws.collections.find((x) => x.id === id)
        if (c && JSON.stringify(c.variables) !== JSON.stringify(vars)) await ws.updateCollection({ ...c, variables: vars })
      }
      if (JSON.stringify(s.finalGlobals) !== JSON.stringify(ws.globals)) await ws.setGlobals(s.finalGlobals)
    }
  }

  const exportReport = async (kind: 'json' | 'junit') => {
    if (!summary) return
    const name = targets.map((t) => ws.collections.find((c) => c.id === t.collectionId)?.name).filter(Boolean).join(' + ') || 'Run'
    const stamp = new Date(summary.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    try {
      const ok = kind === 'json'
        ? await saveTextFile(`dispatch-run-${stamp}.json`, toJsonReport(summary, name))
        : await saveTextFile(`dispatch-run-${stamp}.xml`, toJUnit(summary, name), 'application/xml')
      if (ok) notify('Report saved.')
    } catch (e) { notify(`Couldn’t save: ${String(e)}`) }
  }

  const shown = useMemo(() => (onlyFailed ? results.filter(failed) : results), [results, onlyFailed])
  const passed = results.reduce((n, r) => n + r.tests.filter((t) => t.passed).length, 0)
  const failedTests = results.reduce((n, r) => n + r.tests.filter((t) => !t.passed).length, 0)

  if (!ws.collections.length) {
    return <section className="editor" aria-label="Runner"><p className="eyebrow">Runner</p><h1 className="titleInput">Run a collection</h1><p className="muted">Save some requests into a collection first, then run them here in order.</p></section>
  }

  return (
    <section className="editor wide" aria-label="Runner">
      <p className="eyebrow">Runner</p>
      <h1 className="titleInput">Run collections and folders</h1>
      <p className="muted small">Requests run in order with their scripts and tests. Add more than one collection or folder to run a suite. Use a data file to run once per row; its columns become <code>{'{{variables}}'}</code>.</p>

      <div className="runGrid">
        <div>
          <h2>What to run</h2>
          {targets.map((t, i) => (
            <div key={i} className="targetRow">
              <select aria-label={`Collection ${i + 1}`} value={t.collectionId} onChange={(e) => setTargets((ts) => ts.map((x, j) => (j === i ? { collectionId: e.target.value, folderId: null } : x)))}>
                {ws.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select aria-label={`Folder ${i + 1}`} value={t.folderId ?? ''} onChange={(e) => setTargets((ts) => ts.map((x, j) => (j === i ? { ...x, folderId: e.target.value || null } : x)))}>
                <option value="">Whole collection</option>
                {folderOptions(ws.folders, t.collectionId).map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{`${'  '.repeat(depth)}${folder.name}`}</option>)}
              </select>
              {targets.length > 1 && <button type="button" className="icon" aria-label={`Remove target ${i + 1}`} onClick={() => setTargets((ts) => ts.filter((_, j) => j !== i))}>×</button>}
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => setTargets((ts) => [...ts, { collectionId: ws.collections[0].id, folderId: null }])}>+ Add to suite</button>

          <h2>Requests <span className="muted small">{chosen.length} of {picks.length}</span></h2>
          <ol className="pickList" aria-label="Requests to run">
            {picks.map((p, i) => (
              <li key={p.key} className={p.on ? '' : 'off'}>
                <input type="checkbox" checked={p.on} aria-label={`Run ${p.request.name}`} onChange={(e) => setPicks((ps) => ps.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <span className={`mtag m-${p.request.method}`}>{p.request.method}</span>
                <span className="grow"><span className="rowName">{p.request.name}</span><span className="tiny muted block">{p.path}</span></span>
                <button type="button" className="icon" aria-label={`Move ${p.request.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="icon" aria-label={`Move ${p.request.name} down`} disabled={i === picks.length - 1} onClick={() => move(i, 1)}>↓</button>
              </li>
            ))}
            {!picks.length && <li className="muted small">No HTTP requests here yet.</li>}
          </ol>
        </div>

        <div>
          <h2>Settings</h2>
          <div className="auth">
            <label className="field"><span>Iterations{data ? ' (0 = one per data row)' : ''}</span>
              <input type="number" min={data ? 0 : 1} max={10000} value={iterations} onChange={(e) => setIterations(Math.max(data ? 0 : 1, Math.min(10000, Number(e.target.value) || 0)))} />
            </label>
            <label className="field"><span>Delay between requests (ms)</span>
              <input type="number" min={0} max={60000} step={100} value={delayMs} onChange={(e) => setDelayMs(Math.max(0, Math.min(60000, Number(e.target.value) || 0)))} />
            </label>
            <div className="field"><span>Data file (CSV or JSON)</span>
              <span className="filePick">
                <label className="btn small">{data ? 'Change' : 'Choose file'}
                  <input type="file" className="sr" accept=".csv,.json,text/csv,application/json" aria-label="Data file" onChange={async (e) => {
                    const f = e.target.files?.[0]; e.target.value = ''
                    if (!f) return
                    try { const rows = parseDataFile(await readText(f), f.name); setData({ name: f.name, rows }); setIterations(0) } catch (err) { notify(err instanceof Error ? err.message : String(err)) }
                  }} />
                </label>
                {data ? <><span className="small mono">{data.name} · {data.rows.length} rows</span><button type="button" className="btn small ghost" onClick={() => { setData(null); setIterations(1) }}>Remove</button></> : <span className="small muted">None</span>}
              </span>
            </div>
            {data && (
              <div className="dataPreview">
                <table className="kv readonly"><thead><tr>{Object.keys(data.rows[0] ?? {}).map((k) => <th key={k} className="mono">{k}</th>)}</tr></thead>
                  <tbody>{data.rows.slice(0, 3).map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className="mono">{v}</td>)}</tr>)}</tbody></table>
                {data.rows.length > 3 && <p className="tiny muted">…and {data.rows.length - 3} more</p>}
              </div>
            )}
            {layeredVars(ws.environment).length > 0 && (
              <label className="field"><span>Run once per alternative of</span>
                <select aria-label="Run once per alternative of" value={perLayer} onChange={(e) => setPerLayer(e.target.value)} disabled={!!data}>
                  <option value="">(no, use the active one)</option>
                  {layeredVars(ws.environment).map((v) => <option key={v.id} value={v.key}>{`{{${v.key}}}`}: {v.options!.map((o) => o.name).join(', ')}</option>)}
                </select>
              </label>
            )}
            <label className="toggle"><input type="checkbox" checked={stopOnFailure} onChange={(e) => setStopOnFailure(e.target.checked)} /> Stop at the first failure</label>
            <label className="toggle"><input type="checkbox" checked={saveVars} onChange={(e) => setSaveVars(e.target.checked)} /> Keep variable changes from scripts</label>
            <p className="muted small">Environment: {ws.environment?.name ?? 'none'} · {its} iteration{its === 1 ? '' : 's'} × {chosen.length} request{chosen.length === 1 ? '' : 's'} = {its * chosen.length} sends</p>
          </div>
          <div className="actions">
            {running
              ? <button type="button" className="btn" onClick={() => abort.current?.abort()}>Stop</button>
              : <button type="button" className="btn primary" onClick={() => void run()} disabled={!chosen.length}>▶ Run {its * chosen.length} request{its * chosen.length === 1 ? '' : 's'}</button>}
          </div>
        </div>
      </div>

      {(running || results.length > 0) && <>
        <h2>Results</h2>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
        </div>
        <div className="statRow" role="status">
          <span className="stat"><b>{results.length}</b> sent</span>
          <span className="stat goodText"><b>{passed}</b> tests passed</span>
          <span className={`stat ${failedTests ? 'badText' : ''}`}><b>{failedTests}</b> failed</span>
          <span className="stat"><b>{results.filter((r) => r.error && !r.skipped).length}</b> errors</span>
          {summary && <span className="stat">avg <b>{formatMs(summary.avgTimeMs)}</b> · total {formatMs(summary.durationMs)}</span>}
          {summary && summary.stopped !== 'done' && <span className="stat warnText">{summary.stopped === 'cancelled' ? 'Stopped' : summary.stopped === 'failure' ? 'Stopped at the first failure' : 'Stopped: setNextRequest looped'}</span>}
          <span className="grow" />
          <label className="toggle small"><input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> Only failures</label>
          {summary && <><button type="button" className="btn small" onClick={() => void exportReport('json')}>Export JSON</button><button type="button" className="btn small" onClick={() => void exportReport('junit')}>Export JUnit</button></>}
        </div>
        <div className="runResults">
          <table className="resultTable" aria-label="Run results">
            <thead><tr><th>#</th><th>Request</th><th>Status</th><th>Time</th><th>Tests</th></tr></thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className={`${failed(r) ? 'bad' : ''} ${inspect === r ? 'on' : ''}`} onClick={() => setInspect(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setInspect(r) }}>
                  <td className="muted tiny">{r.iteration + 1}.{r.index + 1}{r.label && <span className="block">{r.label}</span>}</td>
                  <td><span className={`mtag m-${r.method}`}>{r.method}</span> {r.name}<span className="tiny muted block mono">{r.url}</span></td>
                  <td>{r.skipped ? <span className="muted">skipped</span> : r.status !== null ? <span className={`hstat ${statusTone(r.status)}`}>{r.status}</span> : <span className="badText small">{r.error}</span>}</td>
                  <td className="mono small">{r.status !== null ? formatMs(r.timeMs) : '—'}</td>
                  <td>{r.tests.length ? <span className={r.tests.every((t) => t.passed) ? 'goodText' : 'badText'}>{r.tests.filter((t) => t.passed).length}/{r.tests.length}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {inspect && (
            <aside className="inspect" aria-label="Result details">
              <div className="row-h"><strong>{inspect.name}</strong><button type="button" className="icon" aria-label="Close details" onClick={() => setInspect(null)}>×</button></div>
              {inspect.error && <p className="errorBox">{inspect.error}</p>}
              {inspect.tests.length > 0 && <ul className="testList">{inspect.tests.map((t, i) => <li key={i} className={t.passed ? 'pass' : 'fail'}><span className="testMark">{t.passed ? '✓' : '✗'}</span><span>{t.name}{t.error && <span className="testErr mono small">{t.error}</span>}</span></li>)}</ul>}
              <p className="eyebrow">Sent</p>
              <pre className="code mono out small">{`${inspect.detail.sent.method} ${inspect.detail.sent.url}\n${inspect.detail.sent.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}${inspect.detail.sent.body ? `\n\n${inspect.detail.sent.body}` : ''}`}</pre>
              {inspect.detail.response && <><p className="eyebrow">Response</p><pre className="code mono out small">{`${inspect.detail.response.status} ${inspect.detail.response.statusText}\n${inspect.detail.response.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${inspect.detail.response.body}`}</pre></>}
            </aside>
          )}
        </div>
      </>}
    </section>
  )
}
