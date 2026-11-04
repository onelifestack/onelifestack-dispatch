import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BLOCKS, type Flow, type FlowNode, type FlowNodeType, type FlowRun, type FlowStep, type NodeStatus, PORTS, checkFlow, newNode } from '../core/flows'
import { uid } from '../core/types'
import { formatMs } from '../core/format'
import type { WorkspaceApi } from './useWorkspace'
import { CodeArea } from './CodeArea'

/** Block geometry on the canvas (px). */
const W = 184
const HEAD = 46
const PORT_GAP = 24
const nodeHeight = (n: FlowNode) => HEAD + Math.max(1, PORTS[n.type].length) * PORT_GAP + 4
const outPos = (n: FlowNode, port: string) => ({ x: n.x + W, y: n.y + HEAD + PORTS[n.type].indexOf(port) * PORT_GAP + PORT_GAP / 2 })
const inPos = (n: FlowNode) => ({ x: n.x, y: n.y + HEAD / 2 })
const wirePath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2)
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`
}
const PORT_LABEL: Record<string, string> = { next: 'next', ok: 'ok', failed: 'failed', true: 'true', false: 'false', each: 'each', done: 'done' }
const ICON: Record<FlowNodeType, string> = { start: '▶', request: '⇄', script: '{ }', if: '?', set: '=', delay: '◔', forEach: '↻', end: '■' }

/** What a block does, in one line under its title. */
function summary(n: FlowNode, ws: WorkspaceApi): string {
  const c = n.config
  switch (n.type) {
    case 'start': return 'Begins here'
    case 'request': { const r = ws.requests.find((x) => x.id === c.requestId); return r ? r.name : 'Pick a request' }
    case 'script': return c.code?.trim().split('\n')[0] || 'Empty script'
    case 'if': return c.expression || 'No condition'
    case 'set': return c.name ? `${c.name} = ${c.value || '…'}` : 'Pick a name'
    case 'delay': return `${c.ms || 0} ms`
    case 'forEach': return c.source === 'data' ? `each row as {{${c.as || 'item'}}}` : `${c.path || '$[*]'} as {{${c.as || 'item'}}}`
    case 'end': return c.outcome === 'fail' ? 'Stop: failed' : 'Stop: passed'
  }
}

export function FlowView({ ws, flowId, notify, confirm }: { ws: WorkspaceApi; flowId: string; notify: (m: string) => void; confirm: (m: string) => Promise<boolean> }) {
  const stored = ws.flows.find((f) => f.id === flowId)
  const [flow, setFlow] = useState<Flow | null>(stored ?? null)
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)
  const [status, setStatus] = useState<Record<string, NodeStatus>>({})
  const [steps, setSteps] = useState<FlowStep[]>([])
  const [result, setResult] = useState<FlowRun | null>(null)
  const [running, setRunning] = useState<AbortController | null>(null)
  const [drag, setDrag] = useState<{ from: string; port: string; x: number; y: number } | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const latest = useRef(flow); latest.current = flow

  useEffect(() => { if (stored && stored.id !== flow?.id) setFlow(stored) }, [stored, flow?.id])
  // Save shortly after edits (dragging changes positions many times a second).
  const change = useCallback((fn: (f: Flow) => Flow) => {
    setFlow((f) => {
      if (!f) return f
      const next = fn(f)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void ws.updateFlow(next), 300)
      return next
    })
  }, [ws])
  useEffect(() => () => { clearTimeout(saveTimer.current); if (latest.current) void ws.updateFlow(latest.current) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const problems = useMemo(() => (flow ? checkFlow(flow, ws.requests) : []), [flow, ws.requests])
  const node = selected?.kind === 'node' ? flow?.nodes.find((n) => n.id === selected.id) : undefined
  const edge = selected?.kind === 'edge' ? flow?.edges.find((e) => e.id === selected.id) : undefined

  const setNode = (id: string, patch: Partial<FlowNode>) => change((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }))
  const setConfig = (id: string, key: string, value: string) => change((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, config: { ...n.config, [key]: value } } : n)) }))
  const connect = (from: string, port: string, to: string | null) => change((f) => {
    // One wire per output port keeps flows readable; a new wire replaces the old one.
    const edges = f.edges.filter((e) => !(e.from === from && e.port === port))
    return { ...f, edges: to && to !== from ? [...edges, { id: uid(), from, port, to }] : edges }
  })
  const removeNode = (id: string) => change((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((e) => e.from !== id && e.to !== id) }))
  const removeEdge = (id: string) => change((f) => ({ ...f, edges: f.edges.filter((e) => e.id !== id) }))

  const addBlock = (type: FlowNodeType) => {
    if (!flow) return
    const anchor = node ?? flow.nodes[flow.nodes.length - 1]
    // Next to the anchor while it fits in view, otherwise on a new row below it.
    const view = canvas.current ? canvas.current.scrollLeft + canvas.current.clientWidth : 1000
    const right = anchor && anchor.x + 2 * W + 90 <= view
    const below = Math.max(...flow.nodes.map((x) => x.y + nodeHeight(x))) + 60
    const n = newNode(type, !anchor ? 80 : right ? anchor.x + W + 70 : 60, !anchor ? 120 : right ? anchor.y : below)
    requestAnimationFrame(() => canvas.current?.querySelector(`[data-node="${n.id}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }))
    if (type === 'request') { const first = ws.requests.find((r) => !r.collectionId || ws.collections.some((c) => c.id === r.collectionId)); if (first) { n.config.requestId = first.id; n.label = first.name } }
    change((f) => {
      // Wire it after the selected (or last) block when that block's first port is free.
      const port = anchor ? PORTS[anchor.type][0] : undefined
      const free = anchor && port && !f.edges.some((e) => e.from === anchor.id && e.port === port)
      return { ...f, nodes: [...f.nodes, n], edges: free ? [...f.edges, { id: uid(), from: anchor!.id, port: port!, to: n.id }] : f.edges }
    })
    setSelected({ kind: 'node', id: n.id })
  }

  // Keyboard: Delete removes the selected block or wire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.closest('input, textarea, select, [contenteditable="true"], .cm-editor'))) return
      if (selected?.kind === 'edge') { removeEdge(selected.id); setSelected(null) }
      else if (selected?.kind === 'node' && node && node.type !== 'start') { removeNode(selected.id); setSelected(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const point = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left + canvas.current!.scrollLeft, y: e.clientY - r.top + canvas.current!.scrollTop }
  }
  const startMove = (e: React.PointerEvent, n: FlowNode) => {
    if (e.button !== 0) return
    e.preventDefault()
    setSelected({ kind: 'node', id: n.id })
    const p0 = point(e), o = { x: n.x, y: n.y }
    const move = (ev: PointerEvent) => { const p = point(ev); setNode(n.id, { x: Math.max(0, Math.round(o.x + p.x - p0.x)), y: Math.max(0, Math.round(o.y + p.y - p0.y)) }) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const startWire = (e: React.PointerEvent, n: FlowNode, port: string) => {
    e.preventDefault(); e.stopPropagation()
    setDrag({ from: n.id, port, ...point(e) })
    const move = (ev: PointerEvent) => setDrag((d) => (d ? { ...d, ...point(ev) } : d))
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-node]')?.getAttribute('data-node')
      if (target) connect(n.id, port, target)
      setDrag(null)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const run = async () => {
    if (!flow) return
    clearTimeout(saveTimer.current); await ws.updateFlow(flow)
    const ctrl = new AbortController()
    setRunning(ctrl); setStatus({}); setSteps([]); setResult(null)
    try {
      const r = await ws.runFlowNow(flow, (s) => {
        setStatus((m) => ({ ...m, [s.nodeId]: s.status }))
        if (s.status !== 'running') setSteps((l) => [...l, s])
      }, ctrl.signal)
      setResult(r)
      notify(r.ok ? `“${flow.name}” passed.` : `“${flow.name}” failed: ${r.error}`)
    } finally { setRunning(null) }
  }

  if (!flow) return <section className="editor" aria-label="Flow"><p className="muted">This flow was deleted.</p></section>

  const width = Math.max(1200, ...flow.nodes.map((n) => n.x + W + 200))
  const height = Math.max(560, ...flow.nodes.map((n) => n.y + nodeHeight(n) + 160))
  const byId = new Map(flow.nodes.map((n) => [n.id, n]))
  const reqOptions = ws.collections.map((c) => ({ c, rs: ws.requests.filter((r) => r.collectionId === c.id) })).filter((g) => g.rs.length)

  return (
    <section className="flowView" aria-label={`Flow ${flow.name}`}>
      <div className="flowHead">
        <div className="grow">
          <p className="eyebrow">Flow</p>
          <input className="titleInput" aria-label="Flow name" value={flow.name} onChange={(e) => change((f) => ({ ...f, name: e.target.value }))} />
        </div>
        {running
          ? <button type="button" className="btn" onClick={() => running.abort()}>Stop</button>
          : <button type="button" className="btn primary" disabled={problems.length > 0} onClick={() => void run()}>Run flow</button>}
        <button type="button" className="btn" onClick={async () => { if (await confirm(`Delete flow “${flow.name}”? You can undo this right after.`)) await ws.removeFlow(flow.id) }}>Delete</button>
      </div>
      <div className="flowTools" role="toolbar" aria-label="Add a block">
        <span className="muted small">Add:</span>
        {BLOCKS.map((b) => (
          <button key={b.type} type="button" className="btn small" title={b.help} onClick={() => addBlock(b.type)}><span aria-hidden="true" className="flowIcon">{ICON[b.type]}</span> {b.label}</button>
        ))}
        <span className="grow" />
        <span className="muted tiny">Drag blocks to move them; drag from a dot to wire it. Delete removes the selection.</span>
      </div>
      {problems.length > 0 && <ul className="flowProblems small">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}

      <div className="flowBody">
        <div className="flowCanvas" ref={canvas} onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as Element).tagName === 'svg') setSelected(null) }}>
          <svg className="flowWires" width={width} height={height} aria-hidden="true">
            {flow.edges.map((e) => {
              const a = byId.get(e.from), b = byId.get(e.to)
              if (!a || !b) return null
              const d = wirePath(outPos(a, e.port), inPos(b))
              const on = selected?.kind === 'edge' && selected.id === e.id
              return (
                <g key={e.id} className={`wire ${on ? 'on' : ''} port-${e.port}`} onPointerDown={(ev) => { ev.stopPropagation(); setSelected({ kind: 'edge', id: e.id }) }}>
                  <path d={d} className="wireHit" />
                  <path d={d} className="wireLine" />
                </g>
              )
            })}
            {drag && (() => { const a = byId.get(drag.from); return a ? <path className="wireLine drafting" d={wirePath(outPos(a, drag.port), drag)} /> : null })()}
          </svg>
          {flow.nodes.map((n) => {
            const st = status[n.id]
            const on = selected?.kind === 'node' && selected.id === n.id
            return (
              <div key={n.id} data-node={n.id} className={`flowNode t-${n.type} ${on ? 'on' : ''} ${st ? `s-${st}` : ''}`}
                style={{ left: n.x, top: n.y, width: W, height: nodeHeight(n) }}>
                <button type="button" className="flowNodeHead" onPointerDown={(e) => startMove(e, n)} onClick={() => setSelected({ kind: 'node', id: n.id })}
                  aria-label={`${n.label} (${n.type}${st ? `, ${st}` : ''})`}>
                  <span className="flowIcon" aria-hidden="true">{ICON[n.type]}</span>
                  <span className="flowNodeText"><span className="flowNodeTitle">{n.label}</span><span className="flowNodeSub">{summary(n, ws)}</span></span>
                </button>
                <span className="flowIn" aria-hidden="true" />
                {PORTS[n.type].map((p, i) => (
                  <span key={p} className={`flowOut port-${p}`} style={{ top: HEAD + i * PORT_GAP }} title={`Drag to wire “${p}”`}
                    onPointerDown={(e) => startWire(e, n, p)}>
                    <span className="flowPortLabel">{PORT_LABEL[p] ?? p}</span><span className="flowDot" />
                  </span>
                ))}
              </div>
            )
          })}
        </div>

        <aside className="flowSide" aria-label="Block settings">
          {node ? <>
            <p className="eyebrow">{BLOCKS.find((b) => b.type === node.type)?.label ?? 'Start'}</p>
            <label className="field"><span>Name</span><input value={node.label} onChange={(e) => setNode(node.id, { label: e.target.value })} /></label>
            {node.type === 'request' && (
              <label className="field"><span>Request</span>
                <select aria-label="Request" value={node.config.requestId ?? ''} onChange={(e) => { const r = ws.requests.find((x) => x.id === e.target.value); change((f) => ({ ...f, nodes: f.nodes.map((x) => (x.id === node.id ? { ...x, label: r && (x.label === 'Request' || ws.requests.some((q) => q.name === x.label)) ? r.name : x.label, config: { ...x.config, requestId: e.target.value } } : x)) })) }}>
                  <option value="">Pick a saved request…</option>
                  {reqOptions.map((g) => <optgroup key={g.c.id} label={g.c.name}>{g.rs.map((r) => <option key={r.id} value={r.id}>{r.protocol === 'browser' ? 'Browser login: ' : ''}{r.name}</option>)}</optgroup>)}
                </select>
              </label>
            )}
            {node.type === 'script' && <CodeArea label="Script" lang="javascript" rows={8} value={node.config.code ?? ''} onChange={(v) => setConfig(node.id, 'code', v)} placeholder={'pm.variables.set("id", pm.response.json().id)'} />}
            {node.type === 'if' && <>
              <label className="field"><span>Condition (JavaScript)</span><input className="mono" value={node.config.expression ?? ''} onChange={(e) => setConfig(node.id, 'expression', e.target.value)} /></label>
              <p className="muted tiny">Use <code>response.code</code>, <code>response.json</code>, <code>response.headers</code> (the last request) and <code>vars.name</code>.</p>
            </>}
            {node.type === 'set' && <>
              <label className="field"><span>Variable</span><input className="mono" value={node.config.name ?? ''} onChange={(e) => setConfig(node.id, 'name', e.target.value)} /></label>
              <label className="field"><span>Value</span><input className="mono" value={node.config.value ?? ''} onChange={(e) => setConfig(node.id, 'value', e.target.value)} placeholder="{{token}} or $.data.id" /></label>
              <label className="field"><span>Keep it in</span>
                <select aria-label="Keep it in" value={node.config.scope ?? 'flow'} onChange={(e) => setConfig(node.id, 'scope', e.target.value)}>
                  <option value="flow">This run only</option><option value="environment">The active environment</option>
                </select>
              </label>
            </>}
            {node.type === 'delay' && <label className="field"><span>Milliseconds</span><input type="number" min={0} value={node.config.ms ?? ''} onChange={(e) => setConfig(node.id, 'ms', e.target.value)} /></label>}
            {node.type === 'forEach' && <>
              <label className="field"><span>Repeat for</span>
                <select aria-label="Repeat for" value={node.config.source ?? 'response'} onChange={(e) => setConfig(node.id, 'source', e.target.value)}>
                  <option value="response">Items in the last response</option><option value="data">Rows of data (CSV or JSON)</option>
                </select>
              </label>
              {node.config.source === 'data'
                ? <CodeArea label="Data" rows={6} value={node.config.items ?? ''} onChange={(v) => setConfig(node.id, 'items', v)} placeholder={'email,role\nann@example.com,admin'} />
                : <label className="field"><span>JSONPath</span><input className="mono" value={node.config.path ?? ''} onChange={(e) => setConfig(node.id, 'path', e.target.value)} placeholder="$.items[*]" /></label>}
              <label className="field"><span>Call each one</span><input className="mono" value={node.config.as ?? ''} onChange={(e) => setConfig(node.id, 'as', e.target.value)} placeholder="item" /></label>
              <p className="muted tiny">Blocks on “each” run once per item with <code>{`{{${node.config.as || 'item'}}}`}</code> set (and <code>{`{{${node.config.as || 'item'}.field}}`}</code> for objects); “done” runs after the last one.</p>
            </>}
            {node.type === 'end' && <label className="field"><span>Outcome</span>
              <select aria-label="Outcome" value={node.config.outcome ?? 'pass'} onChange={(e) => setConfig(node.id, 'outcome', e.target.value)}><option value="pass">Passed</option><option value="fail">Failed</option></select>
            </label>}
            <p className="muted tiny">{BLOCKS.find((b) => b.type === node.type)?.help}</p>
            {PORTS[node.type].length > 0 && <>
              <p className="subhead">Then go to</p>
              {PORTS[node.type].map((p) => {
                const cur = flow.edges.find((e) => e.from === node.id && e.port === p)
                return (
                  <label key={p} className="field"><span>{`On “${p}”`}</span>
                    <select aria-label={`On “${p}”`} value={cur?.to ?? ''} onChange={(e) => connect(node.id, p, e.target.value || null)}>
                      <option value="">Nothing (stop)</option>
                      {flow.nodes.filter((x) => x.id !== node.id && x.type !== 'start').map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                  </label>
                )
              })}
            </>}
            {node.type !== 'start' && <button type="button" className="btn small danger" onClick={() => { removeNode(node.id); setSelected(null) }}>Remove block</button>}
          </> : edge ? <>
            <p className="eyebrow">Wire</p>
            <p className="small">From “{byId.get(edge.from)?.label}” on <b>{edge.port}</b> to “{byId.get(edge.to)?.label}”.</p>
            <button type="button" className="btn small danger" onClick={() => { removeEdge(edge.id); setSelected(null) }}>Remove wire</button>
          </> : <>
            <p className="eyebrow">Flow</p>
            <p className="muted small">Pick a block to change it, or add one from the bar above. Requests send saved requests (including browser logins) with the active environment; variables set along the way are available to later blocks as <code>{'{{name}}'}</code>.</p>
            <label className="field"><span>Notes</span><textarea rows={4} value={flow.docs} onChange={(e) => change((f) => ({ ...f, docs: e.target.value }))} /></label>
            <p className="muted tiny">Run it from a terminal: <code>dispatch-run flow workspace.json --flow "{flow.name}"</code></p>
          </>}
        </aside>
      </div>

      {(steps.length > 0 || result) && (
        <div className="flowLog" aria-label="Run log" aria-live="polite">
          {result && <p className={`small ${result.ok ? 'goodText' : 'badText'}`}><b>{result.ok ? 'Passed' : 'Failed'}</b> · {result.steps.length} steps · {formatMs(result.durationMs)}{result.error ? ` · ${result.error}` : ''}</p>}
          <ol className="flowSteps">
            {steps.map((s, i) => (
              <li key={i} className={`s-${s.status}`}>
                <button type="button" className="linkish" onClick={() => setSelected({ kind: 'node', id: s.nodeId })}>{s.label}</button>
                {s.status_code !== undefined && <span className="mono small"> {s.status_code}</span>}
                {s.port && <span className="pill">{s.port}</span>}
                <span className="muted small"> {s.detail}</span>
                {s.tests?.length ? <span className="muted tiny"> · tests {s.tests.filter((t) => t.passed).length}/{s.tests.length}</span> : null}
                <span className="muted tiny"> · {formatMs(s.ms)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

