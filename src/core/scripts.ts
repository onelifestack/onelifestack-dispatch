/**
 * Pre-request and post-response scripts with a pm-style API (close to Postman's, so existing scripts mostly work).
 * This file has no DOM or Node dependencies: the Web Worker, the tests and the CLI all run it, each passing in how
 * to compile code. Scripts never touch the app directly; they get plain data in and give plain data back.
 */
import * as chai from 'chai'
import type { LogLine, TestResult } from './types'

export type Vars = Record<string, string>

export interface PmHeader { key: string; value: string; disabled?: boolean }
export interface PmRequestData {
  name: string
  url: string
  method: string
  headers: PmHeader[]
  body: { mode: 'raw' | 'urlencoded' | 'formdata' | 'none' | 'file' | 'graphql'; raw: string }
}
export interface PmResponseData {
  code: number
  status: string
  headers: [string, string][]
  body: string
  responseTime: number
  responseSize: number
}

export interface ScriptInput {
  phase: 'pre' | 'post'
  /** Where the script lives, for logs ("Collection Shop", "Request Login"...). */
  source: string
  code: string
  request: PmRequestData
  response?: PmResponseData | null
  vars: { globals: Vars; collection: Vars; environment: Vars; data: Vars; locals: Vars }
  info: { requestName: string; requestId: string; iteration: number; iterationCount: number }
}

export interface ScriptOutput {
  tests: TestResult[]
  logs: LogLine[]
  vars: ScriptInput['vars']
  request: PmRequestData
  /** pm.execution.skipRequest() in a pre-request script. */
  skip: boolean
  /** pm.execution.setNextRequest(): undefined = not called, null = stop the run. */
  nextRequest?: string | null
  /** A thrown error (the script stopped there). */
  error?: string
}

/** What a script can ask of the outside world. */
export interface ScriptHost {
  sendRequest(req: PmRequestData): Promise<PmResponseData>
}

export type Compile = (code: string, params: string[]) => (...args: unknown[]) => unknown

const fmt = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try { return JSON.stringify(v, null, 2) ?? String(v) } catch { return String(v) }
}

/** Case-insensitive header list with the helpers scripts expect. */
function headerList(list: PmHeader[]) {
  const find = (k: string) => list.find((h) => !h.disabled && h.key.toLowerCase() === k.toLowerCase())
  return {
    get: (k: string) => find(k)?.value,
    has: (k: string, v?: string) => { const h = find(k); return !!h && (v === undefined || h.value === v) },
    add: (h: PmHeader | string) => { const x = typeof h === 'string' ? parseHeader(h) : h; list.push({ key: x.key, value: String(x.value) }) },
    upsert: (h: PmHeader) => { const e = find(h.key); if (e) e.value = String(h.value); else list.push({ key: h.key, value: String(h.value) }) },
    remove: (k: string) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].key.toLowerCase() === k.toLowerCase()) list.splice(i, 1) },
    toObject: () => Object.fromEntries(list.filter((h) => !h.disabled).map((h) => [h.key, h.value])),
    all: () => list.filter((h) => !h.disabled).map((h) => ({ ...h })),
    each: (fn: (h: PmHeader) => void) => list.filter((h) => !h.disabled).forEach(fn),
    count: () => list.filter((h) => !h.disabled).length,
  }
}
const parseHeader = (s: string) => { const i = s.indexOf(':'); return { key: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } }

function scope(store: Vars, label: string) {
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => { store[k] = typeof v === 'string' ? v : fmt(v) },
    unset: (k: string) => { delete store[k] },
    has: (k: string) => Object.prototype.hasOwnProperty.call(store, k),
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    toObject: () => ({ ...store }),
    replaceIn: (s: string) => s.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (w, n: string) => (n in store ? store[n] : w)),
    name: label,
  }
}

/** Builds a response object for scripts, with pm.response.to.* assertions. */
function responseApi(r: PmResponseData) {
  const headers = headerList(r.headers.map(([key, value]) => ({ key, value })))
  let parsed: unknown
  const json = () => {
    if (parsed === undefined) {
      try { parsed = JSON.parse(r.body) } catch { throw new Error('The response body isn’t valid JSON.') }
    }
    return parsed
  }
  const res = {
    code: r.code, status: r.status, responseTime: r.responseTime, responseSize: r.responseSize, headers,
    text: () => r.body, json,
    to: {} as Record<string, unknown>,
  }
  const be = {
    get ok() { chai.expect(r.code, `expected a 2xx status but got ${r.code}`).to.be.within(200, 299); return true },
    get success() { return be.ok },
    get clientError() { chai.expect(r.code).to.be.within(400, 499); return true },
    get serverError() { chai.expect(r.code).to.be.within(500, 599); return true },
    get notFound() { chai.expect(r.code).to.equal(404); return true },
    get json() { json(); return true },
  }
  const have = {
    status: (want: number | string) => {
      if (typeof want === 'number') chai.expect(r.code, `expected status ${want} but got ${r.code}`).to.equal(want)
      else chai.expect(r.status, `expected status “${want}” but got “${r.status}”`).to.equal(want)
    },
    header: (k: string, v?: string) => {
      chai.expect(headers.has(k), `expected the response to have header ${k}`).to.equal(true)
      if (v !== undefined) chai.expect(headers.get(k)).to.equal(v)
    },
    body: (want: string) => chai.expect(r.body).to.equal(want),
    jsonBody: (path?: string, value?: unknown) => {
      const data = json() as Record<string, unknown>
      if (path === undefined) return
      const got = path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), data)
      if (value === undefined) chai.expect(got, `expected JSON to have ${path}`).to.not.equal(undefined)
      else chai.expect(got).to.deep.equal(value)
    },
  }
  res.to = { be, have, not: { have: { header: (k: string) => chai.expect(headers.has(k), `expected no header ${k}`).to.equal(false) } } }
  return res
}

/** Runs one script. Never throws: errors come back in `error` (and as a failed test when inside pm.test). */
export async function runScript(input: ScriptInput, host: ScriptHost, compile: Compile): Promise<ScriptOutput> {
  const vars = structuredClone(input.vars)
  const request: PmRequestData = structuredClone(input.request)
  const tests: TestResult[] = []
  const logs: LogLine[] = []
  const pending: Promise<unknown>[] = []
  let skip = false
  let nextRequest: string | null | undefined
  const out = (): ScriptOutput => ({ tests, logs, vars, request, skip, nextRequest })

  const log = (level: LogLine['level']) => (...args: unknown[]) => logs.push({ level, text: args.map(fmt).join(' '), at: Date.now(), source: input.source })
  const console = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('log') }

  const record = (name: string, run: () => unknown) => {
    try {
      const r = run()
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        const i = tests.push({ name, passed: true }) - 1
        pending.push((r as Promise<unknown>).then(() => undefined, (e: unknown) => { tests[i] = { name, passed: false, error: e instanceof Error ? e.message : fmt(e) } }))
      } else tests.push({ name, passed: true })
    } catch (e) {
      tests.push({ name, passed: false, error: e instanceof Error ? e.message : fmt(e) })
    }
  }
  const test = Object.assign((name: string, fn: () => unknown) => record(String(name), fn), {
    skip: (name: string) => { tests.push({ name: `${name} (skipped)`, passed: true }) },
  })

  const resolved = () => ({ ...vars.globals, ...vars.collection, ...vars.environment, ...vars.data, ...vars.locals })
  const reqHeaders = headerList(request.headers)
  const requestApi = {
    get url() { return Object.assign(new String(request.url), { toString: () => request.url, getQueryString: () => request.url.split('?')[1] ?? '' }) },
    set url(v: unknown) { request.url = String(v) },
    get method() { return request.method },
    set method(v: string) { request.method = String(v).toUpperCase() },
    headers: reqHeaders,
    addHeader: (h: PmHeader) => reqHeaders.add(h),
    removeHeader: (k: string) => reqHeaders.remove(k),
    body: {
      get mode() { return request.body.mode },
      get raw() { return request.body.raw },
      set raw(v: string) { request.body.raw = String(v); if (request.body.mode === 'none') request.body.mode = 'raw' },
      update: (v: string | { mode?: string; raw?: string }) => {
        if (typeof v === 'string') { request.body.raw = v; request.body.mode = 'raw' } else { if (v.raw !== undefined) request.body.raw = v.raw; request.body.mode = 'raw' }
      },
      toString: () => request.body.raw,
    },
    get name() { return request.name },
  }

  const sendRequest = (req: string | Partial<PmRequestData> & { header?: PmHeader[] | Record<string, string>; body?: { mode?: string; raw?: string } | string }, cb?: (err: unknown, res: unknown) => void) => {
    const r: PmRequestData = typeof req === 'string'
      ? { name: 'sendRequest', url: req, method: 'GET', headers: [], body: { mode: 'none', raw: '' } }
      : {
          name: 'sendRequest', url: String(req.url ?? ''), method: String(req.method ?? 'GET').toUpperCase(),
          headers: Array.isArray(req.header) ? req.header : req.header ? Object.entries(req.header).map(([key, value]) => ({ key, value: String(value) })) : (req.headers ?? []),
          body: typeof req.body === 'string' ? { mode: 'raw', raw: req.body } : req.body ? { mode: 'raw', raw: String(req.body.raw ?? '') } : { mode: 'none', raw: '' },
        }
    const p = host.sendRequest(r).then((res) => responseApi(res))
    const done = p.then((res) => { cb?.(null, res); return res }, (err: unknown) => { cb?.(err instanceof Error ? err : new Error(fmt(err)), null); if (!cb) throw err })
    pending.push(done.catch(() => undefined))
    return done
  }

  const pm = {
    globals: scope(vars.globals, 'globals'),
    collectionVariables: scope(vars.collection, 'collection'),
    environment: scope(vars.environment, 'environment'),
    iterationData: { ...scope(vars.data, 'data'), set: undefined, unset: undefined, clear: undefined },
    variables: {
      get: (k: string) => resolved()[k],
      set: (k: string, v: unknown) => { vars.locals[k] = typeof v === 'string' ? v : fmt(v) },
      unset: (k: string) => { delete vars.locals[k] },
      has: (k: string) => k in resolved(),
      toObject: () => resolved(),
      replaceIn: (s: string) => s.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (w, n: string) => resolved()[n] ?? w),
    },
    request: requestApi,
    response: input.response ? responseApi(input.response) : undefined,
    test, expect: chai.expect,
    sendRequest,
    info: { ...input.info, eventName: input.phase === 'pre' ? 'prerequest' : 'test' },
    execution: {
      skipRequest: () => { skip = true },
      setNextRequest: (name: string | null) => { nextRequest = name },
      location: [input.source],
    },
    require: (name: string) => {
      if (name === 'chai') return chai
      throw new Error(`require('${name}') isn’t available. Built in: pm, console, chai (pm.expect), JSON, Math, Date, atob/btoa.`)
    },
  }
  // Older Postman syntax.
  const legacyTests: Record<string, boolean> = {}
  const postman = { setNextRequest: pm.execution.setNextRequest, setEnvironmentVariable: pm.environment.set, getEnvironmentVariable: pm.environment.get, setGlobalVariable: pm.globals.set, getGlobalVariable: pm.globals.get }

  try {
    const fn = compile(`"use strict";\nreturn (async () => {\n${input.code}\n})()`, ['pm', 'console', 'postman', 'tests', 'require', 'responseBody', 'responseCode'])
    await fn(pm, console, postman, legacyTests, pm.require, input.response?.body, input.response ? { code: input.response.code, name: input.response.status } : undefined)
    // Callbacks from pm.sendRequest may add more; wait (bounded by the engine's timeout).
    for (let i = 0; i < pending.length; i++) await pending[i]
  } catch (e) {
    const o = out()
    o.error = e instanceof Error ? e.message : fmt(e)
    logs.push({ level: 'error', text: `${input.source}: ${o.error}`, at: Date.now(), source: input.source })
    for (const [name, passed] of Object.entries(legacyTests)) tests.push({ name, passed: !!passed })
    return o
  }
  for (const [name, passed] of Object.entries(legacyTests)) tests.push({ name, passed: !!passed })
  return out()
}

/** Plain Function constructor; used inside the Web Worker and in tests. */
export const compileWithFunction: Compile = (code, params) => new Function(...params, code) as (...args: unknown[]) => unknown
