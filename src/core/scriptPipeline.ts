import type { Environment, Collection, KV, LogLine, Method, PreparedRequest, RequestDef } from './types'
import { METHODS } from './types'
import type { Compile, PmRequestData, PmResponseData, ScriptHost, ScriptInput, ScriptOutput, Vars } from './scripts'
import { SendError, type SendOptions, type Transport } from './transport'
import { type Execution, type Pipeline, type RunContext, folderChain } from './runtime'
import { paramsFromUrl, withScheme } from './url'

export interface ScriptEngine { run(input: ScriptInput, host: ScriptHost): Promise<ScriptOutput> }

export const SCRIPT_TIMEOUT_MS = 10_000

/** Runs scripts in this thread. Used by tests, the CLI (with a vm-based compile) and as a fallback. */
export class InlineEngine implements ScriptEngine {
  constructor(private readonly compile?: Compile, private readonly timeoutMs = SCRIPT_TIMEOUT_MS) {}
  run(input: ScriptInput, host: ScriptHost): Promise<ScriptOutput> {
    // The script runtime (with chai) loads on first use, keeping it out of the app's startup bundle.
    const go = Promise.all([import('./scripts'), import('./scriptLibs')])
      .then(async ([m, l]) => m.runScript(input, host, this.compile ?? m.compileWithFunction, await l.loadLibs(l.neededLibs(input.code))))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<ScriptOutput>((resolve) => {
      timer = setTimeout(() => resolve({
        tests: [], logs: [{ level: 'error', text: `${input.source}: script took longer than ${this.timeoutMs / 1000} s and was stopped.`, at: Date.now(), source: input.source }],
        vars: input.vars, request: input.request, skip: false, error: `Script took longer than ${this.timeoutMs / 1000} s.`,
      }), this.timeoutMs)
    })
    return Promise.race([go, timeout]).finally(() => clearTimeout(timer))
  }
}

/** Raised when a pre-request script calls pm.execution.skipRequest(). */
export class SkipRequest extends SendError { override name = 'SkipRequest' }

const toRecord = (rows: KV[] | undefined): Vars => Object.fromEntries((rows ?? []).filter((v) => v.enabled && v.key.trim()).map((v) => [v.key.trim(), v.value]))

/** Writes a script's view of a variable scope back to table rows: edits values, adds new keys, drops unset ones. */
export function applyVars(rows: KV[], next: Vars): KV[] {
  const seen = new Set<string>()
  const out: KV[] = []
  for (const r of rows) {
    const k = r.key.trim()
    if (!r.enabled || !k) { out.push(r); continue }
    if (!(k in next)) continue // unset
    seen.add(k)
    out.push(r.value === next[k] ? r : { ...r, value: next[k] })
  }
  for (const [k, v] of Object.entries(next)) if (!seen.has(k)) out.push({ id: `v-${k}-${Math.random().toString(36).slice(2, 8)}`, key: k, value: v, enabled: true })
  return out
}
const sameVars = (a: Vars, b: Vars) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

function pmRequestOf(req: RequestDef): PmRequestData {
  const raw = ['json', 'text', 'xml', 'html', 'graphql'].includes(req.body.kind)
  return {
    name: req.name, url: req.url, method: req.method,
    headers: req.headers.filter((h) => h.key.trim()).map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled })),
    body: { mode: raw ? (req.body.kind === 'graphql' ? 'graphql' : 'raw') : req.body.kind === 'none' ? 'none' : req.body.kind === 'binary' ? 'file' : req.body.kind === 'formdata' ? 'formdata' : 'urlencoded', raw: raw ? req.body.text : '' },
  }
}

function pmRequestOfSent(name: string, p: PreparedRequest): PmRequestData {
  return { name, url: p.url, method: p.method, headers: p.headers.map(([key, value]) => ({ key, value })), body: { mode: p.body == null ? 'none' : 'raw', raw: p.body ?? '' } }
}

/** Applies what a pre-request script changed (URL, method, headers, raw body) to the request. */
function applyPmRequest(req: RequestDef, before: PmRequestData, after: PmRequestData): RequestDef {
  if (JSON.stringify(before) === JSON.stringify(after)) return req
  const next = structuredClone(req)
  if (after.url !== before.url) { next.url = after.url; next.params = paramsFromUrl(after.url, next.params) }
  if (after.method !== before.method && METHODS.includes(after.method as Method)) next.method = after.method as Method
  if (JSON.stringify(after.headers) !== JSON.stringify(before.headers)) {
    next.headers = after.headers.map((h, i) => ({ id: next.headers[i]?.id ?? `h-${i}-${Date.now()}`, key: h.key, value: h.value, enabled: !h.disabled }))
  }
  if (after.body.raw !== before.body.raw) {
    if (!['json', 'text', 'xml', 'html', 'graphql'].includes(next.body.kind)) next.body = { ...next.body, kind: 'text' }
    next.body = { ...next.body, text: after.body.raw }
  }
  return next
}

export interface ScriptPipelineOptions {
  engine: ScriptEngine
  transport: Transport
  sendOptions: () => SendOptions
  iteration?: () => { iteration: number; iterationCount: number }
}

/** Pipeline hooks that run collection → folders → request scripts before sending and after the response. */
export function scriptPipeline(o: ScriptPipelineOptions): Pipeline {
  const host: ScriptHost = {
    async sendRequest(r: PmRequestData): Promise<PmResponseData> {
      const method = (METHODS.includes(r.method.toUpperCase() as Method) ? r.method.toUpperCase() : 'GET') as Method
      const p: PreparedRequest = {
        method, url: withScheme(r.url), headers: r.headers.filter((h) => !h.disabled).map((h) => [h.key, h.value]),
        body: r.body.mode === 'none' ? null : r.body.raw, unresolved: [],
      }
      const res = await o.transport.send(p, o.sendOptions())
      return { code: res.status, status: res.statusText, headers: res.headers, body: res.body, responseTime: res.timeMs, responseSize: res.size }
    },
  }

  const scriptsFor = (req: RequestDef, ctx: RunContext, phase: 'pre' | 'post') => {
    const folders = folderChain(ctx.folders, req.folderId).reverse() // outermost first
    const list: { source: string; code: string }[] = []
    if (ctx.collection?.scripts[phase].trim()) list.push({ source: `Collection “${ctx.collection.name}”`, code: ctx.collection.scripts[phase] })
    for (const f of folders) if (f.scripts[phase].trim()) list.push({ source: `Folder “${f.name}”`, code: f.scripts[phase] })
    if (req.scripts[phase].trim()) list.push({ source: `Request “${req.name}”`, code: req.scripts[phase] })
    return list
  }

  /** Runs the scripts of one phase, threading variables through, and writes changes back into ctx/out. */
  const runPhase = async (phase: 'pre' | 'post', req: RequestDef, ctx: RunContext, out: Execution, pmReq: PmRequestData, response: PmResponseData | null) => {
    const scripts = scriptsFor(req, ctx, phase)
    if (!scripts.length) return { request: pmReq, skip: false }
    ctx.locals ??= new Map()
    const start = {
      globals: toRecord(ctx.globals), collection: toRecord(ctx.collection?.variables), environment: toRecord(ctx.environment?.variables),
      data: { ...(ctx.data ?? {}) }, locals: Object.fromEntries(ctx.locals),
    }
    let vars = start
    let request = pmReq
    let skip = false
    const it = o.iteration?.() ?? { iteration: 0, iterationCount: 1 }
    for (const s of scripts) {
      const r = await o.engine.run({ phase, source: s.source, code: s.code, request, response, vars, info: { requestName: req.name, requestId: req.id, ...it } }, host)
      out.tests.push(...r.tests)
      out.logs.push(...r.logs)
      vars = r.vars; request = r.request
      if (r.skip) skip = true
      if (r.nextRequest !== undefined) out.nextRequest = r.nextRequest
      if (r.visualizer) out.visualizer = r.visualizer
      if (r.error && phase === 'post') out.tests.push({ name: `${s.source} script error`, passed: false, error: r.error })
      if (r.error && phase === 'pre') out.scriptError = `${s.source}: ${r.error}`
    }
    // Write back scopes that changed.
    if (!sameVars(start.environment, vars.environment) && ctx.environment) {
      const variables = applyVars(ctx.environment.variables, vars.environment)
      ctx.environment = { ...ctx.environment, variables } as Environment
      out.changes.environment = variables
    }
    if (!sameVars(start.collection, vars.collection) && ctx.collection) {
      const variables = applyVars(ctx.collection.variables, vars.collection)
      ctx.collection = { ...ctx.collection, variables } as Collection
      out.changes.collection = variables
    }
    if (!sameVars(start.globals, vars.globals)) {
      ctx.globals = applyVars(ctx.globals, vars.globals)
      out.changes.globals = ctx.globals
    }
    ctx.locals = new Map(Object.entries(vars.locals))
    return { request, skip }
  }

  return {
    async beforeSend(req, ctx, out) {
      const before = pmRequestOf(req)
      const { request, skip } = await runPhase('pre', req, ctx, out, before, null)
      if (skip) throw new SkipRequest('Skipped: a pre-request script called pm.execution.skipRequest().')
      return applyPmRequest(req, before, request)
    },
    async afterResponse(req, ctx, out) {
      if (!out.response) return
      const r = out.response
      await runPhase('post', req, ctx, out, pmRequestOfSent(req.name, out.sent),
        { code: r.status, status: r.statusText, headers: r.headers, body: r.body, responseTime: r.timeMs, responseSize: r.size })
    },
  }
}

export type { LogLine }
