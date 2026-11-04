import type { Collection, Environment, Folder, KV, RequestDef, Settings, TestResult } from './types'
import { bySort } from './types'
import type { Transport } from './transport'
import { type Execution, type Pipeline, type RunContext, execute, sendOptions } from './runtime'

export interface RunItem {
  request: RequestDef
  /** "Collection / Folder / Sub" — for reports. */
  path: string
}

/** Requests under a collection or folder, depth first, in collection order (requests and folders interleaved). */
export function collectItems(collection: Collection, folderId: string | null, folders: Folder[], requests: RequestDef[]): RunItem[] {
  const out: RunItem[] = []
  const walk = (parent: string | null, path: string) => {
    const reqs = requests.filter((r) => r.collectionId === collection.id && (r.folderId ?? null) === parent && r.protocol === 'http')
      .map((r) => ({ sort: r.sort, name: r.name, run: () => out.push({ request: r, path }) }))
    const subs = folders.filter((f) => f.collectionId === collection.id && f.parentId === parent)
      .map((f) => ({ sort: f.sort, name: f.name, run: () => walk(f.id, `${path} / ${f.name}`) }))
    ;[...reqs, ...subs].sort(bySort).forEach((x) => x.run())
  }
  const start = folderId ? folders.find((f) => f.id === folderId) : null
  const startPath = [collection.name, ...pathTo(folders, folderId)].join(' / ')
  walk(start ? start.id : null, startPath)
  return out
}

function pathTo(folders: Folder[], id: string | null): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  while (id && !seen.has(id)) { seen.add(id); const f = folders.find((x) => x.id === id); if (!f) break; names.unshift(f.name); id = f.parentId }
  return names
}

export interface RunConfig {
  items: RunItem[]
  /** Ignored when data rows are given and iterations is 0 (one iteration per row). */
  iterations: number
  data: Record<string, string>[] | null
  /** Optional names for the iterations (e.g. the alternative of {{baseUrl}} each one used). */
  iterationLabels?: string[]
  delayMs: number
  stopOnFailure: boolean
  environment: Environment | null
  collections: Collection[]
  folders: Folder[]
  globals: KV[]
  settings: Settings
}

export interface RunResult {
  iteration: number
  /** The iteration's label, when the run has them (alternatives). */
  label?: string
  index: number
  name: string
  path: string
  method: string
  url: string
  status: number | null
  statusText: string
  timeMs: number
  size: number
  tests: TestResult[]
  error: string | null
  skipped: boolean
  /** Request + response details for the inspector (body capped). */
  detail: Pick<Execution, 'sent' | 'response' | 'logs'>
}

export interface RunSummary {
  startedAt: number
  durationMs: number
  iterations: number
  requests: number
  failedRequests: number
  skipped: number
  testsPassed: number
  testsFailed: number
  avgTimeMs: number
  stopped: 'done' | 'cancelled' | 'failure' | 'setNextRequest'
  results: RunResult[]
  /** Variables at the end of the run (to save if the user wants). */
  finalEnvironment: KV[] | null
  finalCollections: Record<string, KV[]>
  finalGlobals: KV[]
}

export interface RunHooks {
  onResult?: (r: RunResult, done: number, total: number) => void
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (ms <= 0) { resolve(); return }
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

export const failed = (r: RunResult) => !!r.error && !r.skipped || r.tests.some((t) => !t.passed)

/** Runs the items for every iteration. Variables changed by scripts carry over between requests and iterations. */
export async function runCollection(cfg: RunConfig, transport: Transport, pipeline: Pipeline, hooks: RunHooks = {}): Promise<RunSummary> {
  const started = Date.now()
  const sleep = hooks.sleep ?? defaultSleep
  const iterations = cfg.data?.length && !cfg.iterations ? cfg.data.length : Math.max(1, cfg.iterations)
  let environment = cfg.environment ? structuredClone(cfg.environment) : null
  const collections = new Map(cfg.collections.map((c) => [c.id, structuredClone(c)]))
  let globals = structuredClone(cfg.globals)
  const results: RunResult[] = []
  let stopped: RunSummary['stopped'] = 'done'
  const total = iterations * cfg.items.length
  const capBody = (b: string) => (b.length > 65_536 ? `${b.slice(0, 65_536)}\n… (cut at 64 KB)` : b)

  outer: for (let it = 0; it < iterations; it++) {
    const data = cfg.data?.length ? cfg.data[it % cfg.data.length] : null
    const locals = new Map<string, string>()
    let i = 0
    let steps = 0
    while (i < cfg.items.length) {
      if (hooks.signal?.aborted) { stopped = 'cancelled'; break outer }
      if (++steps > cfg.items.length * 50) { stopped = 'setNextRequest'; break outer } // a setNextRequest loop
      const item = cfg.items[i]
      const ctx: RunContext = {
        collection: item.request.collectionId ? collections.get(item.request.collectionId) ?? null : null,
        folders: cfg.folders, environment, globals, data, locals,
      }
      const it0 = it
      const pl: Pipeline = { ...pipeline }
      const x = await execute(item.request, ctx, transport, sendOptions(item.request, cfg.settings, hooks.signal), pl)
      // Carry script changes forward.
      if (x.changes.environment && environment) environment = { ...environment, variables: x.changes.environment }
      if (x.changes.collection && ctx.collection) collections.set(ctx.collection.id, { ...ctx.collection, variables: x.changes.collection })
      if (x.changes.globals) globals = x.changes.globals
      const r: RunResult = {
        iteration: it0, label: cfg.iterationLabels?.[it0], index: i, name: item.request.name, path: item.path, method: x.sent.method, url: x.sent.url,
        status: x.response?.status ?? null, statusText: x.response?.statusText ?? '', timeMs: x.response?.timeMs ?? 0, size: x.response?.size ?? 0,
        tests: x.tests, error: x.error, skipped: !!x.skipped,
        detail: { sent: x.sent, logs: x.logs, response: x.response ? { ...x.response, body: capBody(x.response.body), base64: undefined } : null },
      }
      results.push(r)
      hooks.onResult?.(r, results.length, total)
      if (hooks.signal?.aborted) { stopped = 'cancelled'; break outer }
      if (cfg.stopOnFailure && failed(r)) { stopped = 'failure'; break outer }
      if (x.nextRequest === null) break // stop this iteration
      if (typeof x.nextRequest === 'string') {
        const j = cfg.items.findIndex((c) => c.request.name === x.nextRequest)
        i = j >= 0 ? j : cfg.items.length
      } else i++
      if (cfg.delayMs > 0 && i < cfg.items.length) await sleep(cfg.delayMs, hooks.signal)
    }
    if (cfg.delayMs > 0 && it < iterations - 1) await sleep(cfg.delayMs, hooks.signal)
  }

  const sent = results.filter((r) => r.status !== null)
  return {
    startedAt: started, durationMs: Date.now() - started, iterations, requests: results.length,
    failedRequests: results.filter((r) => r.error && !r.skipped).length, skipped: results.filter((r) => r.skipped).length,
    testsPassed: results.reduce((n, r) => n + r.tests.filter((t) => t.passed).length, 0),
    testsFailed: results.reduce((n, r) => n + r.tests.filter((t) => !t.passed).length, 0),
    avgTimeMs: sent.length ? Math.round(sent.reduce((n, r) => n + r.timeMs, 0) / sent.length) : 0,
    stopped, results,
    finalEnvironment: environment?.variables ?? null,
    finalCollections: Object.fromEntries([...collections].map(([id, c]) => [id, c.variables])),
    finalGlobals: globals,
  }
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

/** JUnit XML, which CI systems understand: one testsuite per request run, one testcase per test. */
export function toJUnit(s: RunSummary, name = 'Dispatch run'): string {
  const suites = s.results.map((r) => {
    const cases = r.tests.length ? r.tests : [{ name: r.error ? 'request' : 'request sent', passed: !r.error || r.skipped, error: r.error ?? undefined }]
    const failures = cases.filter((t) => !t.passed).length
    const body = cases.map((t) => `      <testcase name="${xml(t.name)}" classname="${xml(`${r.path} / ${r.name}`)}" time="${(r.timeMs / 1000).toFixed(3)}">${r.skipped ? '<skipped/>' : t.passed ? '' : `<failure message="${xml(t.error ?? 'failed')}"/>`}</testcase>`).join('\n')
    return `    <testsuite name="${xml(`${r.name} (iteration ${r.iteration + 1})`)}" tests="${cases.length}" failures="${failures}" time="${(r.timeMs / 1000).toFixed(3)}">\n${body}\n    </testsuite>`
  }).join('\n')
  const tests = s.results.reduce((n, r) => n + Math.max(1, r.tests.length), 0)
  const failures = s.results.reduce((n, r) => n + (r.tests.length ? r.tests.filter((t) => !t.passed).length : r.error && !r.skipped ? 1 : 0), 0)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(name)}" tests="${tests}" failures="${failures}" time="${(s.durationMs / 1000).toFixed(3)}">\n${suites}\n</testsuites>\n`
}

/** A JSON report without bodies (they can be large and may hold secrets). */
export function toJsonReport(s: RunSummary, name = 'Dispatch run'): string {
  const { results, finalEnvironment: _e, finalCollections: _c, finalGlobals: _g, ...summary } = s
  return JSON.stringify({
    name, ...summary, startedAt: new Date(s.startedAt).toISOString(),
    results: results.map(({ detail: _d, ...r }) => r),
  }, null, 2)
}
