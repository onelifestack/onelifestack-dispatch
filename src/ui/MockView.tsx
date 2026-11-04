import { useEffect, useMemo, useRef, useState } from 'react'
import { buildRoutes, fillMockBody, matchRoute } from '../core/mock'
import { isDesktop } from '../core/transport'
import type { WorkspaceApi } from './useWorkspace'

interface Hit { at: number; method: string; target: string; status: number; example: string | null }

/** Serves a collection's saved examples on 127.0.0.1 (desktop). The web version explains the CLI equivalent. */
export function MockView({ ws, notify, collectionId }: { ws: WorkspaceApi; notify: (m: string) => void; collectionId: string }) {
  const col = ws.collections.find((c) => c.id === collectionId)
  const [port, setPort] = useState(4319)
  const [delayMs, setDelayMs] = useState(0)
  const [running, setRunning] = useState(false)
  const [hits, setHits] = useState<Hit[]>([])
  const routes = useMemo(() => (col ? buildRoutes(col, ws.folders, ws.requests, delayMs) : []), [col, ws.folders, ws.requests, delayMs])
  const routesRef = useRef(routes); routesRef.current = routes
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { stopRef.current?.() }, [])

  const start = async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    try {
      await invoke('mock_start', { port })
    } catch (e) { notify(String(e)); return }
    const un = await listen<{ id: number; method: string; target: string; headers: [string, string][]; body: string }>('mock-request', async (ev) => {
      const r = ev.payload
      const hit = matchRoute(routesRef.current, r.method, r.target, Object.fromEntries(r.headers))
      if (hit?.route.delayMs) await new Promise((res) => setTimeout(res, hit.route.delayMs))
      const reply = hit
        ? { status: hit.response.status, headers: hit.response.headers, body: fillMockBody(hit.response.body, hit.params) }
        : { status: 404, headers: [['Content-Type', 'application/json']], body: JSON.stringify({ error: 'No saved example matches this request.', routes: routesRef.current.map((x) => `${x.method} ${x.path}`) }, null, 2) }
      await invoke('mock_reply', { id: r.id, reply })
      setHits((h) => [{ at: Date.now(), method: r.method, target: r.target, status: reply.status, example: hit?.response.name ?? null }, ...h].slice(0, 200))
    })
    stopRef.current = () => { un(); void invoke('mock_stop') }
    setRunning(true)
    notify(`Mock running on http://127.0.0.1:${port}`)
  }
  const stop = () => { stopRef.current?.(); stopRef.current = null; setRunning(false) }

  if (!col) return null
  return (
    <section className="editor wide" aria-label="Mock server">
      <p className="eyebrow">Mock server</p>
      <h1 className="titleInput">{col.name}</h1>
      <p className="muted small">Serves the saved examples of this collection so you can build against an API that isn’t ready yet. Add examples with <b>Save as example</b> on a response. Pick a different example with the <code>x-mock-response-name</code> or <code>x-mock-response-code</code> header, or <code>?__example=Name</code>.</p>
      {isDesktop() ? (
        <div className="actions">
          <label className="field inline"><span>Port</span><input type="number" min={1024} max={65535} value={port} disabled={running} onChange={(e) => setPort(Number(e.target.value) || 4319)} /></label>
          <label className="field inline"><span>Delay (ms)</span><input type="number" min={0} max={30000} step={50} value={delayMs} onChange={(e) => setDelayMs(Math.max(0, Number(e.target.value) || 0))} /></label>
          {running ? <button type="button" className="btn" onClick={stop}>Stop</button> : <button type="button" className="btn primary" disabled={!routes.length} onClick={() => void start()}>Start mock</button>}
          {running && <span className="pill">http://127.0.0.1:{port}</span>}
        </div>
      ) : (
        <p className="warnLine small">A web page can’t listen on a port. Use the desktop app, or the CLI: <code>dispatch-run mock your-backup.json --collection "{col.name}" --port {port}</code></p>
      )}
      <h2>Routes <span className="muted small">{routes.length}</span></h2>
      {routes.length ? (
        <table className="resultTable" aria-label="Mock routes">
          <thead><tr><th>Method</th><th>Path</th><th>Request</th><th>Examples</th></tr></thead>
          <tbody>{routes.map((r) => <tr key={`${r.method} ${r.path} ${r.name}`}><td><span className={`mtag m-${r.method}`}>{r.method}</span></td><td className="mono">{r.path}</td><td>{r.name}</td><td>{r.responses.map((x) => `${x.status} ${x.name}`).join(', ')}</td></tr>)}</tbody>
        </table>
      ) : <p className="muted">No saved examples in this collection yet.</p>}
      {hits.length > 0 && <>
        <h2>Requests received</h2>
        <table className="resultTable" aria-label="Mock requests"><tbody>{hits.map((h, i) => <tr key={i}><td className="tiny muted">{new Date(h.at).toLocaleTimeString()}</td><td><span className={`mtag m-${h.method}`}>{h.method}</span> <span className="mono">{h.target}</span></td><td>{h.status}</td><td className="muted">{h.example ?? 'no match'}</td></tr>)}</tbody></table>
      </>}
    </section>
  )
}
