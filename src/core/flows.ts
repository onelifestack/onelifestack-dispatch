/**
 * Flows: a graph of blocks (start, request, script, if, set variable, delay, for each, end) joined by wires from
 * an output port to the next block. Requests reuse saved requests (HTTP, browser login, …) and the normal run
 * pipeline; variables flow between blocks. Shared by the app and dispatch-run.
 */
import type { Collection, Environment, Folder, HttpResponse, KV, LogLine, RequestDef, Settings, TestResult } from './types'
import { uid } from './types'
import type { Transport } from './transport'
import { type Pipeline, type RunContext, execute, sendOptions } from './runtime'
import type { ScriptEngine } from './scriptPipeline'
import type { PmResponseData } from './scripts'
import { interpolate } from './vars'
import { scopeFor } from './prepare'
import { prepareContext } from './runtime'
import { queryJson } from './jsonpath'
import { parseDataFile } from './csv'

export type FlowNodeType = 'start' | 'request' | 'script' | 'if' | 'set' | 'delay' | 'forEach' | 'end'

export interface FlowNode {
  id: string
  type: FlowNodeType
  x: number
  y: number
  label: string
  /** request: requestId · script: code · if: expression · set: name, value, scope · delay: ms · forEach: source, items, path, as · end: outcome */
  config: Record<string, string>
}
export interface FlowEdge { id: string; from: string; port: string; to: string }
export interface Flow { id: string; name: string; nodes: FlowNode[]; edges: FlowEdge[]; workspaceId?: string; docs: string; updatedAt: number }

/** Output ports per block type (the first is the usual path). */
export const PORTS: Record<FlowNodeType, string[]> = {
  start: ['next'], request: ['ok', 'failed'], script: ['next'], if: ['true', 'false'], set: ['next'], delay: ['next'], forEach: ['each', 'done'], end: [],
}

export const BLOCKS: { type: FlowNodeType; label: string; help: string }[] = [
  { type: 'request', label: 'Request', help: 'Send a saved request (HTTP, browser login…). Goes to “ok”, or “failed” on an error, a 4xx/5xx or a failing test.' },
  { type: 'if', label: 'If', help: 'A JavaScript condition, e.g. response.code === 200 or vars.role === "admin".' },
  { type: 'script', label: 'Script', help: 'Run JavaScript with pm (pm.variables, pm.environment, pm.response of the last request).' },
  { type: 'set', label: 'Set variable', help: 'Set a variable from text with {{variables}}, or a JSONPath into the last response ($.id).' },
  { type: 'forEach', label: 'For each', help: 'Repeat the “each” branch for every row of data or every item a JSONPath finds in the last response.' },
  { type: 'delay', label: 'Delay', help: 'Wait some milliseconds.' },
  { type: 'end', label: 'End', help: 'Stop here, as passed or failed.' },
]

export function newFlow(name = 'New flow'): Flow {
  const start: FlowNode = { id: uid(), type: 'start', x: 60, y: 140, label: 'Start', config: {} }
  return { id: uid(), name, nodes: [start], edges: [], docs: '', updatedAt: Date.now() }
}
export function newNode(type: FlowNodeType, x: number, y: number): FlowNode {
  const config: Record<string, string> = type === 'delay' ? { ms: '1000' } : type === 'set' ? { name: '', value: '', scope: 'flow' }
    : type === 'forEach' ? { source: 'response', path: '$[*]', items: '', as: 'item' } : type === 'end' ? { outcome: 'pass' }
    : type === 'if' ? { expression: 'response.code === 200' } : {}
  return { id: uid(), type, x, y, label: BLOCKS.find((b) => b.type === type)?.label ?? type, config }
}

export type NodeStatus = 'running' | 'ok' | 'failed' | 'skipped'
export interface FlowStep {
  nodeId: string
  label: string
  status: NodeStatus
  port: string | null
  ms: number
  detail: string
  /** Request blocks: the response summary and tests. */
  status_code?: number
  tests?: TestResult[]
}
export interface FlowRun { ok: boolean; error: string | null; steps: FlowStep[]; logs: LogLine[]; environment: KV[] | null; globals: KV[]; vars: Record<string, string>; durationMs: number }

export interface FlowWorld {
  collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environment: Environment | null; globals: KV[]; settings: Settings
}

export interface FlowHooks {
  onStep?: (s: FlowStep) => void
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

const MAX_STEPS = 10_000
const respData = (r: HttpResponse | null): PmResponseData | null => r ? { code: r.status, status: r.statusText, headers: r.headers, body: r.body, responseTime: r.timeMs, responseSize: r.size } : null
const parseJson = (s: string) => { try { return JSON.parse(s) } catch { return undefined } }

/** Problems that stop a flow from running at all (shown in the editor too). */
export function checkFlow(f: Flow, requests: RequestDef[]): string[] {
  const out: string[] = []
  const starts = f.nodes.filter((n) => n.type === 'start')
  if (starts.length !== 1) out.push('A flow needs exactly one Start block.')
  for (const n of f.nodes) {
    if (n.type === 'request' && !requests.some((r) => r.id === n.config.requestId)) out.push(`“${n.label}” doesn’t point at a saved request.`)
    if (n.type === 'set' && !n.config.name?.trim()) out.push(`“${n.label}” needs a variable name.`)
  }
  for (const e of f.edges) if (!f.nodes.some((n) => n.id === e.from) || !f.nodes.some((n) => n.id === e.to)) out.push('A wire points at a block that no longer exists.')
  return out
}

/** Runs a flow from its Start block. Never throws. */
export async function runFlow(f: Flow, w: FlowWorld, transport: Transport, pipeline: Pipeline, engine: ScriptEngine, hooks: FlowHooks = {}): Promise<FlowRun> {
  const started = Date.now()
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const run: FlowRun = { ok: true, error: null, steps: [], logs: [], environment: null, globals: w.globals, vars: {}, durationMs: 0 }
  const problems = checkFlow(f, w.requests)
  if (problems.length) return { ...run, ok: false, error: problems.join(' ') }
  const locals = new Map<string, string>()
  const ctx = (req: RequestDef | null): RunContext => ({
    collection: req?.collectionId ? w.collections.find((c) => c.id === req.collectionId) ?? null : null,
    folders: w.folders, environment, globals: run.globals, locals,
  })
  let environment = w.environment ? structuredClone(w.environment) : null
  let last: HttpResponse | null = null
  let steps = 0
  const fill = (s: string) => interpolate(s, scopeFor({ ...prepareContext(ctx(null), { folderId: null } as RequestDef), locals }))
  const next = (n: FlowNode, port: string) => f.edges.filter((e) => e.from === n.id && e.port === port).map((e) => f.nodes.find((x) => x.id === e.to)!).filter(Boolean)
  class Stop extends Error {}

  /** A tiny script run for If/Script blocks, through the sandboxed engine. */
  const script = async (code: string, label: string) => {
    const r = await engine.run({
      phase: 'post', source: `Flow “${f.name}” · ${label}`, code, response: respData(last),
      request: { name: label, url: '', method: 'GET', headers: [], body: { mode: 'none', raw: '' } },
      vars: { globals: Object.fromEntries(run.globals.filter((v) => v.enabled).map((v) => [v.key, v.value])), collection: {}, environment: Object.fromEntries((environment?.variables ?? []).filter((v) => v.enabled).map((v) => [v.key, v.value])), data: {}, locals: Object.fromEntries(locals) },
      info: { requestName: label, requestId: '', iteration: 0, iterationCount: 1 },
    }, { sendRequest: () => Promise.reject(new Error('pm.sendRequest isn’t available in flow scripts; use a Request block.')) })
    run.logs.push(...r.logs)
    if (r.error) throw new Error(r.error)
    for (const [k, v] of Object.entries(r.vars.locals)) locals.set(k, v)
    if (environment) {
      const { applyVars } = await import('./scriptPipeline')
      environment = { ...environment, variables: applyVars(environment.variables, r.vars.environment) }
    }
    return r
  }

  /** Runs from `first`. A straight chain runs in a loop (no recursion, so long or looping flows can't overflow the
   *  stack); recursion is only for fan-out (several wires from one port) and for-each bodies. */
  const visit = async (first: FlowNode): Promise<void> => {
   for (let n: FlowNode | null = first; n;) {
    if (hooks.signal?.aborted) throw new Stop('Stopped.')
    if (++steps > MAX_STEPS) throw new Stop(`Stopped after ${MAX_STEPS} steps (a loop that never ends?).`)
    const t0 = Date.now()
    const step: FlowStep = { nodeId: n.id, label: n.label, status: 'running', port: null, ms: 0, detail: '' }
    hooks.onStep?.({ ...step })
    const finish = (status: NodeStatus, port: string | null, detail: string, extra: Partial<FlowStep> = {}) => {
      Object.assign(step, { status, port, detail, ms: Date.now() - t0, ...extra })
      run.steps.push({ ...step }); hooks.onStep?.({ ...step })
    }
    let port: string | null = PORTS[n.type][0] ?? null
    try {
      switch (n.type) {
        case 'start': finish('ok', port, ''); break
        case 'request': {
          const reqId = n.config.requestId
          const req = w.requests.find((r) => r.id === reqId)!
          const c = ctx(req)
          const x = await execute(req, c, transport, sendOptions(req, w.settings, hooks.signal), pipeline)
          environment = c.environment
          if (x.changes.globals) run.globals = x.changes.globals
          run.logs.push(...x.logs)
          if (x.response) last = x.response
          const bad = !!x.error || (x.response?.status ?? 0) >= 400 || x.tests.some((t) => !t.passed)
          port = bad ? 'failed' : 'ok'
          const detail = x.error ?? `${x.sent.method} ${x.sent.url} → ${x.response?.status} ${x.response?.statusText} · ${x.response?.timeMs} ms${x.tests.length ? ` · ${x.tests.filter((t) => t.passed).length}/${x.tests.length} tests` : ''}`
          finish(bad ? 'failed' : 'ok', port, detail, { status_code: x.response?.status, tests: x.tests })
          if (bad && !next(n, 'failed').length) throw new Stop(`${n.label} failed: ${detail}`)
          break
        }
        case 'script': await script(n.config.code ?? '', n.label); finish('ok', port, 'done'); break
        case 'if': {
          const expr = (n.config.expression ?? '').trim() || 'false'
          await script(`const response = pm.response ? { code: pm.response.code, status: pm.response.status, headers: pm.response.headers.toObject(), body: pm.response.text(), json: (() => { try { return pm.response.json() } catch { return undefined } })() } : null
            const vars = pm.variables.toObject()
            pm.variables.set('__flowIf', (${expr}) ? 'true' : 'false')`, n.label)
          port = locals.get('__flowIf') === 'true' ? 'true' : 'false'
          locals.delete('__flowIf')
          finish('ok', port, `${expr} → ${port}`)
          break
        }
        case 'set': {
          const name = n.config.name.trim()
          let value = n.config.value ?? ''
          if (value.trim().startsWith('$')) {
            const data = last ? parseJson(last.body) : undefined
            const hit = data === undefined ? [] : queryJson(data, value.trim())
            value = hit.length === 0 ? '' : typeof hit[0] === 'string' ? hit[0] : JSON.stringify(hit[0])
          } else value = fill(value)
          if (n.config.scope === 'environment' && environment) {
            const vars = environment.variables.some((v) => v.key === name) ? environment.variables.map((v) => (v.key === name ? { ...v, value } : v)) : [...environment.variables, { id: uid(), key: name, value, enabled: true }]
            environment = { ...environment, variables: vars }
          } else locals.set(name, value)
          finish('ok', port, `{{${name}}} = ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`)
          break
        }
        case 'delay': { const ms = Math.min(600_000, Number(fill(n.config.ms ?? '0')) || 0); await sleep(ms); finish('ok', port, `${ms} ms`); break }
        case 'forEach': {
          let items: unknown[] = []
          if (n.config.source === 'data') items = parseDataFile(fill(n.config.items ?? ''))
          else { const data = last ? parseJson(last.body) : undefined; items = data === undefined ? [] : queryJson(data, n.config.path || '$[*]') }
          const as = n.config.as?.trim() || 'item'
          finish('ok', 'each', `${items.length} item${items.length === 1 ? '' : 's'}`)
          for (let i = 0; i < items.length; i++) {
            const it = items[i]
            locals.set(as, typeof it === 'string' ? it : JSON.stringify(it))
            locals.set(`${as}Index`, String(i))
            if (it && typeof it === 'object' && !Array.isArray(it)) for (const [k, v] of Object.entries(it)) locals.set(`${as}.${k}`, typeof v === 'string' ? v : JSON.stringify(v))
            for (const m of next(n, 'each')) await visit(m)
          }
          for (const m of next(n, 'done')) await visit(m)
          port = null
          break
        }
        case 'end':
          finish(n.config.outcome === 'fail' ? 'failed' : 'ok', null, n.config.outcome === 'fail' ? 'Ended as failed' : 'Ended')
          if (n.config.outcome === 'fail') { run.ok = false; run.error = run.error ?? `${n.label}: ended as failed.` }
          throw new EndFlow()
      }
    } catch (e) {
      if (e instanceof EndFlow || e instanceof Stop) throw e
      finish('failed', null, e instanceof Error ? e.message : String(e))
      throw new Stop(`${n.label}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const nexts: FlowNode[] = port ? next(n, port) : []
    if (nexts.length === 1) { n = nexts[0]; continue }
    for (const m of nexts) await visit(m)
    n = null
   }
  }

  try {
    await visit(f.nodes.find((n) => n.type === 'start')!)
  } catch (e) {
    if (!(e instanceof EndFlow)) { run.ok = false; run.error = e instanceof Error ? e.message : String(e) }
  }
  run.environment = environment?.variables ?? null
  run.vars = Object.fromEntries(locals)
  run.durationMs = Date.now() - started
  return run
}

class EndFlow extends Error {}
