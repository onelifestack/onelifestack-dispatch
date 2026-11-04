import { useRef, useState } from 'react'
import { type LoadStats, MAX_DURATION_MS, MAX_VUS, type Sample, runLoad, samplesCsv, verdict } from '../core/load'
import { collectItems, type RunItem } from '../core/runner'
import { parseDataFile } from '../core/csv'
import { formatBytes, formatMs } from '../core/format'
import type { WorkspaceApi } from './useWorkspace'
import { folderOptions } from './Dialogs'
import { saveTextFile } from './files'
import { LatencyChart, ThroughputChart } from './charts'

type Source = { kind: 'tab' } | { kind: 'request'; id: string } | { kind: 'flow'; collectionId: string; folderId: string | null }

const readText = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Couldn’t read that file.')); r.readAsText(file)
})
const num = (v: string, min: number, max: number, dflt: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt }

export function LoadView({ ws, notify, requestId }: { ws: WorkspaceApi; notify: (m: string) => void; requestId: string | null }) {
  const [source, setSource] = useState<Source>(() => (requestId ? { kind: 'request', id: requestId } : { kind: 'tab' }))
  const [vus, setVus] = useState(10)
  const [rampS, setRampS] = useState(5)
  const [mode, setMode] = useState<'duration' | 'iterations'>('duration')
  const [durationS, setDurationS] = useState(30)
  const [iterations, setIterations] = useState(10)
  const [thinkMs, setThinkMs] = useState(0)
  const [runScripts, setRunScripts] = useState(false)
  const [data, setData] = useState<{ name: string; rows: Record<string, string>[] } | null>(null)
  const [p95, setP95] = useState('')
  const [errPct, setErrPct] = useState('1')
  const [minRps, setMinRps] = useState('')
  const [allowed, setAllowed] = useState(false)
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState<LoadStats | null>(null)
  const [activeUsers, setActiveUsers] = useState(0)
  const [samples, setSamples] = useState<Sample[] | null>(null)
  const [showTable, setShowTable] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const items = (): RunItem[] => {
    if (source.kind === 'tab') return [{ request: ws.draft, path: 'Open tab' }]
    if (source.kind === 'request') { const r = ws.requests.find((x) => x.id === source.id); return r ? [{ request: r, path: '' }] : [] }
    const c = ws.collections.find((x) => x.id === source.collectionId)
    return c ? collectItems(c, source.folderId, ws.folders, ws.requests) : []
  }
  const thresholds = { p95Ms: p95 === '' ? null : Number(p95), errorRatePct: errPct === '' ? null : Number(errPct), minRps: minRps === '' ? null : Number(minRps) }

  const start = async () => {
    const list = items()
    if (!list.length || !list[0].request.url.trim()) { notify('Choose a request with a URL to test.'); return }
    if (!allowed) { notify('Confirm that you’re allowed to load-test this server first.'); return }
    const ctrl = new AbortController(); abort.current = ctrl
    setRunning(true); setStats(null); setSamples(null)
    try {
      const r = await runLoad({
        items: list, virtualUsers: vus, rampUpMs: rampS * 1000, mode, durationMs: durationS * 1000, iterations, thinkTimeMs: thinkMs,
        runScripts, data: data?.rows ?? null, environment: ws.environment, collections: ws.collections, folders: ws.folders, globals: ws.globals,
        settings: ws.settings, thresholds,
      }, ws.transport, ws.pipeline.current, { signal: ctrl.signal, onProgress: (s, a) => { setStats(s); setActiveUsers(a) } })
      setStats(r.stats); setSamples(r.samples)
      ws.log([{ level: 'info', at: Date.now(), source: 'load test', text: `${r.stats.count} requests in ${formatMs(r.stats.elapsedMs)}: ${r.stats.rps.toFixed(1)}/s, p95 ${r.stats.p95} ms, ${r.stats.errorRatePct.toFixed(1)}% errors` }])
    } finally {
      abort.current = null; setRunning(false); setActiveUsers(0)
    }
  }

  const v = stats ? verdict(stats, thresholds) : null
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  return (
    <section className="editor wide" aria-label="Load test">
      <p className="eyebrow">Performance</p>
      <h1 className="titleInput">Load test</h1>
      <p className="muted small">Virtual users send the request (or a flow of requests) over and over at the same time, and you see how response times and errors hold up.</p>
      {!ws.transport.unrestricted && <p className="warnLine small">In the browser, requests to one server share about six connections and must pass CORS, so results top out early. The desktop app has no such limit.</p>}

      <div className="runGrid">
        <div>
          <h2>What to test</h2>
          <div className="auth">
            <label className="field"><span>Source</span>
              <select aria-label="Load test source" value={source.kind === 'tab' ? 'tab' : source.kind === 'request' ? `r:${source.id}` : `f:${source.collectionId}`} onChange={(e) => {
                const val = e.target.value
                setSource(val === 'tab' ? { kind: 'tab' } : val.startsWith('r:') ? { kind: 'request', id: val.slice(2) } : { kind: 'flow', collectionId: val.slice(2), folderId: null })
              }}>
                <option value="tab">The open tab: {ws.draft.name}</option>
                <optgroup label="A saved request">
                  {ws.requests.filter((r) => r.protocol === 'http').map((r) => <option key={r.id} value={`r:${r.id}`}>{r.name}</option>)}
                </optgroup>
                <optgroup label="A flow (every request in order)">
                  {ws.collections.map((c) => <option key={c.id} value={`f:${c.id}`}>{c.name}</option>)}
                </optgroup>
              </select>
            </label>
            {source.kind === 'flow' && folderOptions(ws.folders, source.collectionId).length > 0 && (
              <label className="field"><span>Folder</span>
                <select value={source.folderId ?? ''} onChange={(e) => setSource({ ...source, folderId: e.target.value || null })}>
                  <option value="">Whole collection</option>
                  {folderOptions(ws.folders, source.collectionId).map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{`${'  '.repeat(depth)}${folder.name}`}</option>)}
                </select>
              </label>
            )}
            <p className="muted small">{items().length} request{items().length === 1 ? '' : 's'} per loop · environment: {ws.environment?.name ?? 'none'}</p>
            <label className="toggle"><input type="checkbox" checked={runScripts} onChange={(e) => setRunScripts(e.target.checked)} /> Run scripts and tests (failed tests count as errors; slower)</label>
            <div className="field"><span>Data file (optional; each loop takes the next row)</span>
              <span className="filePick">
                <label className="btn small">{data ? 'Change' : 'Choose file'}
                  <input type="file" className="sr" accept=".csv,.json" aria-label="Load test data file" onChange={async (e) => {
                    const f = e.target.files?.[0]; e.target.value = ''
                    if (!f) return
                    try { setData({ name: f.name, rows: parseDataFile(await readText(f), f.name) }) } catch (err) { notify(err instanceof Error ? err.message : String(err)) }
                  }} />
                </label>
                {data ? <><span className="small mono">{data.name} · {data.rows.length} rows</span><button type="button" className="btn small ghost" onClick={() => setData(null)}>Remove</button></> : <span className="small muted">None</span>}
              </span>
            </div>
          </div>
          <h2>Pass if</h2>
          <div className="thresholds">
            <label className="field"><span>p95 under (ms)</span><input type="number" min={1} value={p95} placeholder="no limit" onChange={(e) => setP95(e.target.value)} /></label>
            <label className="field"><span>Errors under (%)</span><input type="number" min={0} max={100} step={0.1} value={errPct} placeholder="no limit" onChange={(e) => setErrPct(e.target.value)} /></label>
            <label className="field"><span>At least (requests/s)</span><input type="number" min={0} value={minRps} placeholder="no limit" onChange={(e) => setMinRps(e.target.value)} /></label>
          </div>
        </div>
        <div>
          <h2>Load</h2>
          <div className="auth">
            <label className="field"><span>Virtual users (max {MAX_VUS})</span><input type="number" min={1} max={MAX_VUS} value={vus} onChange={(e) => setVus(num(e.target.value, 1, MAX_VUS, 10))} /></label>
            <label className="field"><span>Ramp-up (seconds to start all users)</span><input type="number" min={0} max={600} value={rampS} onChange={(e) => setRampS(num(e.target.value, 0, 600, 0))} /></label>
            <label className="field"><span>Run for</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'duration' | 'iterations')}>
                <option value="duration">A length of time</option><option value="iterations">A number of loops per user</option>
              </select>
            </label>
            {mode === 'duration'
              ? <label className="field"><span>Duration (seconds, max {MAX_DURATION_MS / 60000} min)</span><input type="number" min={1} max={MAX_DURATION_MS / 1000} value={durationS} onChange={(e) => setDurationS(num(e.target.value, 1, MAX_DURATION_MS / 1000, 30))} /></label>
              : <label className="field"><span>Loops per user</span><input type="number" min={1} max={100000} value={iterations} onChange={(e) => setIterations(num(e.target.value, 1, 100000, 10))} /></label>}
            <label className="field"><span>Think time between requests (ms)</span><input type="number" min={0} max={60000} step={100} value={thinkMs} onChange={(e) => setThinkMs(num(e.target.value, 0, 60000, 0))} /></label>
            <label className="toggle consent"><input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} /> I own this server or have permission to load-test it.</label>
          </div>
          <div className="actions">
            {running
              ? <button type="button" className="btn" onClick={() => abort.current?.abort()}>Stop</button>
              : <button type="button" className="btn primary" disabled={!allowed} onClick={() => void start()}>⚡ Start load test</button>}
          </div>
        </div>
      </div>

      {stats && <>
        <h2>{running ? `Running… ${activeUsers} users active` : 'Results'}</h2>
        {v && !running && v.checks.length > 0 && (
          <div className={`verdict ${v.passed ? 'pass' : 'fail'}`} role="status">
            <strong>{v.passed ? '✓ Passed' : '✗ Failed'}</strong>
            {v.checks.map((c) => <span key={c.label} className={c.passed ? 'goodText' : 'badText'}>{c.passed ? '✓' : '✗'} {c.label} ({c.actual})</span>)}
          </div>
        )}
        <div className="tiles">
          <div className="tile"><span className="tileLabel">Requests</span><span className="tileValue">{stats.count}</span><span className="tileSub">{stats.rps.toFixed(1)} per second</span></div>
          <div className="tile"><span className="tileLabel">Median</span><span className="tileValue">{stats.p50} ms</span><span className="tileSub">p90 {stats.p90} · p99 {stats.p99}</span></div>
          <div className="tile"><span className="tileLabel">p95</span><span className="tileValue">{stats.p95} ms</span><span className="tileSub">min {stats.min} · max {stats.max}</span></div>
          <div className="tile"><span className="tileLabel">Errors</span><span className={`tileValue ${stats.errors ? 'badText' : ''}`}>{stats.errorRatePct.toFixed(1)}%</span><span className="tileSub">{stats.errors} of {stats.count}</span></div>
          <div className="tile"><span className="tileLabel">Data received</span><span className="tileValue">{formatBytes(stats.bytes)}</span><span className="tileSub">in {formatMs(Math.round(stats.elapsedMs))}</span></div>
        </div>
        <div className="vizGrid">
          <LatencyChart timeline={stats.timeline} />
          <ThroughputChart timeline={stats.timeline} />
        </div>
        <div className="row-h">
          <h3>Details</h3>
          <span className="grow" />
          <label className="toggle small"><input type="checkbox" checked={showTable} onChange={(e) => setShowTable(e.target.checked)} /> Per-second table</label>
          {samples && <>
            <button type="button" className="btn small" onClick={async () => { if (await saveTextFile(`dispatch-load-${stamp()}.json`, JSON.stringify({ stats, thresholds, verdict: v }, null, 2))) notify('Results saved.') }}>Export summary</button>
            <button type="button" className="btn small" onClick={async () => { if (await saveTextFile(`dispatch-load-${stamp()}.csv`, samplesCsv(samples), 'text/csv')) notify('Samples saved.') }}>Export all samples (CSV)</button>
          </>}
        </div>
        <div className="detailGrid">
          <table className="resultTable" aria-label="Per request">
            <thead><tr><th>Request</th><th>Sent</th><th>Errors</th><th>p50</th><th>p95</th></tr></thead>
            <tbody>{stats.perRequest.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.count}</td><td className={r.errors ? 'badText' : ''}>{r.errors}</td><td className="mono">{r.p50} ms</td><td className="mono">{r.p95} ms</td></tr>)}</tbody>
          </table>
          <table className="resultTable" aria-label="Status codes">
            <thead><tr><th>Status</th><th>Count</th></tr></thead>
            <tbody>{stats.statuses.map(([k, n]) => <tr key={k}><td className="mono">{k}</td><td>{n}</td></tr>)}</tbody>
          </table>
        </div>
        {stats.errorMessages.length > 0 && <>
          <h3>Most common errors</h3>
          <ul className="small">{stats.errorMessages.map(([m, n]) => <li key={m}><span className="mono">{m}</span> <span className="muted">× {n}</span></li>)}</ul>
        </>}
        {showTable && (
          <table className="resultTable" aria-label="Per second">
            <thead><tr><th>Second</th><th>Requests</th><th>Failed</th><th>p50 (ms)</th><th>p95 (ms)</th><th>Users</th></tr></thead>
            <tbody>{stats.timeline.map((b) => <tr key={b.second}><td>{b.second}</td><td>{b.count}</td><td>{b.errors}</td><td>{b.p50}</td><td>{b.p95}</td><td>{b.activeUsers}</td></tr>)}</tbody>
          </table>
        )}
      </>}
    </section>
  )
}
