/**
 * dispatch-run: runs Dispatch (or Postman) collections from the command line, for CI.
 * Uses the same core as the app: variables, auth, scripts and tests, data files, reports, load tests.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import vm from 'node:vm'
import { importFileAsync, type ImportResult } from '../core/backup'
import { parseDataFile } from '../core/csv'
import { type RunItem, collectItems, failed, runCollection, toJUnit, toJsonReport } from '../core/runner'
import { runLoad, samplesCsv, verdict } from '../core/load'
import { InlineEngine, scriptPipeline } from '../core/scriptPipeline'
import { CookieTransport, FetchTransport } from '../core/transport'
import { CookieJar } from '../core/cookies'
import { authPipeline } from '../core/auth'
import type { Compile } from '../core/scripts'
import { type Environment, type KV, type Settings, defaultSettings, kv } from '../core/types'
import { formatMs } from '../core/format'
import { createServer } from 'node:http'
import { buildRoutes, fillMockBody, matchRoute } from '../core/mock'

const VERSION = '0.2.0'
const color = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const green = c(32), red = c(31), dim = c(2), bold = c(1), yellow = c(33)

const HELP = `dispatch-run ${VERSION} — run API collections from the command line

Usage:
  dispatch-run <file> [options]          run a collection (Dispatch backup or Postman collection)
  dispatch-run load <file> [options]     load-test a request or a collection
  dispatch-run mock <file> [options]     serve a collection's saved examples (mock server)

Run options:
  -c, --collection <name>      collection to run (default: the only/first one)
  -f, --folder <path>          folder to run, "Parent/Child"; repeat to run a suite
  -e, --environment <file|name>  environment file (Dispatch/Postman) or name inside <file>
  -g, --globals <file>         Postman globals or Dispatch backup with globals
      --env-var <key=value>    set a variable (repeatable; wins over the environment)
  -d, --data <file>            CSV or JSON data file: one iteration per row
  -n, --iterations <n>         iterations (default 1, or one per data row)
      --delay <ms>             wait between requests
      --bail                   stop at the first failure
      --timeout <ms>           per-request timeout (default 30000)
  -k, --insecure               accept self-signed TLS certificates
      --no-scripts             don't run pre-request/test scripts
  -r, --reporters <list>       cli,json,junit (default cli)
      --json <path>            where to write the JSON report
      --junit <path>           where to write the JUnit report

Load options:
      --request <name>         request to test (default: every request in order)
  -u, --vus <n>                virtual users (default 10, max 200)
      --duration <time>        e.g. 30s, 2m (default 30s)
      --loops <n>              loops per user instead of a duration
      --ramp-up <time>         time to start all users (default 0)
      --think <ms>             pause after each request
      --p95 <ms>               fail if p95 is above this
      --max-errors <percent>   fail if the error rate is above this
      --min-rps <n>            fail if throughput is below this
      --samples <path>         write every sample as CSV
      --i-have-permission      required: you own the server or may load-test it

Mock options:
      --port <n>               port to listen on (default 4319, 127.0.0.1 only)
      --delay <ms>             wait before each response

Exit code: 0 when everything passed, 1 when a test, request or threshold failed, 2 for usage errors.
`

class Usage extends Error {}

function parseArgs(argv: string[]) {
  const opts: Record<string, string[]> = {}
  const pos: string[] = []
  const alias: Record<string, string> = { c: 'collection', f: 'folder', e: 'environment', g: 'globals', d: 'data', n: 'iterations', k: 'insecure', r: 'reporters', u: 'vus', h: 'help' }
  const flags = new Set(['bail', 'insecure', 'no-scripts', 'help', 'version', 'i-have-permission'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-') || a === '-') { pos.push(a); continue }
    let [name, value] = a.replace(/^--?/, '').split(/=(.*)/s, 2)
    name = alias[name] ?? name
    if (flags.has(name)) { opts[name] = ['true']; continue }
    if (value === undefined) { value = argv[++i]; if (value === undefined) throw new Usage(`--${name} needs a value.`) }
    ;(opts[name] ??= []).push(value)
  }
  return { opts, pos }
}

const one = (o: Record<string, string[]>, k: string) => o[k]?.[o[k].length - 1]
const int = (v: string | undefined, name: string, dflt: number) => {
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Usage(`--${name} must be a number.`)
  return n
}
const time = (v: string | undefined, name: string, dflt: number) => {
  if (v === undefined) return dflt
  const m = v.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/)
  if (!m) throw new Usage(`--${name}: use a time like 500ms, 30s or 2m.`)
  return Number(m[1]) * (m[2] === 'm' ? 60_000 : m[2] === 'ms' ? 1 : 1000)
}
const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { throw new Usage(`Can't read ${path}.`) } }

/** Scripts compile in a separate V8 context (no require/process); collections are your own files. */
const compileInVm: Compile = (code, params) => vm.compileFunction(code, params, { parsingContext: vm.createContext({ atob, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout }) }) as (...args: unknown[]) => unknown

async function loadWorkspace(file: string): Promise<ImportResult> {
  try { return await importFileAsync(read(file)) } catch (e) { throw new Usage(`${file}: ${e instanceof Error ? e.message : String(e)}`) }
}

async function pickEnvironment(ws: ImportResult, spec: string | undefined): Promise<Environment | null> {
  if (!spec) return ws.environments.length === 1 ? ws.environments[0] : null
  const named = ws.environments.find((e) => e.name === spec)
  if (named) return named
  const r = await loadWorkspace(spec)
  if (!r.environments.length) throw new Usage(`${spec} has no environment.`)
  return r.environments[0]
}

function selectItems(ws: ImportResult, collectionName: string | undefined, folders: string[] | undefined): RunItem[] {
  const col = collectionName ? ws.collections.find((x) => x.name === collectionName) : ws.collections[0]
  if (!col) throw new Usage(collectionName ? `No collection named "${collectionName}". Found: ${ws.collections.map((x) => x.name).join(', ') || 'none'}.` : 'The file has no collection.')
  if (!folders?.length) return collectItems(col, null, ws.folders, ws.requests)
  return folders.flatMap((path) => {
    let parent: string | null = null
    for (const part of path.split('/').map((s) => s.trim()).filter(Boolean)) {
      const f = ws.folders.find((x) => x.collectionId === col.id && x.parentId === parent && x.name === part)
      if (!f) throw new Usage(`No folder "${path}" in ${col.name}.`)
      parent = f.id
    }
    return collectItems(col, parent, ws.folders, ws.requests)
  })
}

async function main(argv: string[]): Promise<number> {
  const { opts, pos } = parseArgs(argv)
  if (opts.help || !pos.length) { process.stdout.write(HELP); return pos.length || opts.help ? 0 : 2 }
  if (opts.version) { console.log(VERSION); return 0 }
  const isLoad = pos[0] === 'load'
  const isMock = pos[0] === 'mock'
  const file = isLoad || isMock ? pos[1] : pos[0]
  if (!file) throw new Usage('Give a collection file.')
  const ws = await loadWorkspace(file)
  for (const w of ws.warnings) console.error(yellow(`note: ${w}`))

  if (isMock) {
    const name = one(opts, 'collection')
    const col = name ? ws.collections.find((x) => x.name === name) : ws.collections[0]
    if (!col) throw new Usage(name ? `No collection named "${name}".` : 'The file has no collection.')
    const routes = buildRoutes(col, ws.folders, ws.requests, int(one(opts, 'delay'), 'delay', 0))
    if (!routes.length) throw new Usage(`${col.name} has no saved examples to serve.`)
    const port = int(one(opts, 'port'), 'port', 4319)
    const server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const hit = matchRoute(routes, req.method ?? 'GET', req.url ?? '/', Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])))
      if (hit?.route.delayMs) await new Promise((r) => setTimeout(r, hit.route.delayMs))
      if (!hit) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'No saved example matches this request.', routes: routes.map((r) => `${r.method} ${r.path}`) }, null, 2))
      } else {
        const headers = Object.fromEntries(hit.response.headers.filter(([k]) => !/^(content-length|transfer-encoding|connection)$/i.test(k)))
        res.writeHead(hit.response.status, headers)
        res.end(req.method === 'HEAD' ? undefined : fillMockBody(hit.response.body, hit.params))
      }
      console.log(`${dim(new Date().toLocaleTimeString())} ${req.method} ${req.url} → ${hit ? `${hit.response.status} ${hit.response.name}` : red('404 no match')}`)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()) })
    console.log(bold(`Mock of ${col.name} on http://127.0.0.1:${port}`))
    for (const r of routes) console.log(`  ${r.method.padEnd(6)} ${r.path}  ${dim(r.responses.map((x) => x.status).join(', '))}`)
    await new Promise(() => {}) // until Ctrl+C
  }

  let environment = await pickEnvironment(ws, one(opts, 'environment'))
  let globals: KV[] = ws.globals ?? []
  if (one(opts, 'globals')) { const g = await loadWorkspace(one(opts, 'globals')!); globals = g.globals?.length ? g.globals : g.environments[0]?.variables ?? [] }
  const overrides = (opts['env-var'] ?? []).map((p) => { const i = p.indexOf('='); if (i < 1) throw new Usage(`--env-var ${p}: use key=value.`); return kv(p.slice(0, i), p.slice(i + 1)) })
  if (overrides.length) environment = { ...(environment ?? { id: 'cli', name: 'command line', updatedAt: 0, variables: [] }), variables: [...(environment?.variables ?? []).filter((v) => !overrides.some((o) => o.key === v.key)), ...overrides] }
  const data = one(opts, 'data') ? parseDataFile(read(one(opts, 'data')!), one(opts, 'data')) : null

  if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const settings: Settings = { ...defaultSettings, timeoutMs: int(one(opts, 'timeout'), 'timeout', 30_000), insecureTls: !!opts.insecure }
  const transport = new CookieTransport(new FetchTransport(), new CookieJar())
  const scripts = opts['no-scripts'] ? {} : scriptPipeline({ engine: new InlineEngine(compileInVm), transport, sendOptions: () => ({ timeoutMs: settings.timeoutMs, followRedirects: true, insecureTls: settings.insecureTls }) })
  const pipeline = authPipeline(scripts, transport)
  let items = selectItems(ws, one(opts, 'collection'), opts.folder)
  if (!items.length) throw new Usage('Nothing to run: no HTTP requests found.')

  if (isLoad) {
    if (!opts['i-have-permission']) throw new Usage('Load tests need --i-have-permission (you own the server or may load-test it).')
    const name = one(opts, 'request')
    if (name) { items = items.filter((i) => i.request.name === name); if (!items.length) throw new Usage(`No request named "${name}".`) }
    const loops = one(opts, 'loops')
    const thresholds = { p95Ms: one(opts, 'p95') ? int(one(opts, 'p95'), 'p95', 0) : null, errorRatePct: one(opts, 'max-errors') ? int(one(opts, 'max-errors'), 'max-errors', 0) : null, minRps: one(opts, 'min-rps') ? int(one(opts, 'min-rps'), 'min-rps', 0) : null }
    const cfg = {
      items, virtualUsers: int(one(opts, 'vus'), 'vus', 10), rampUpMs: time(one(opts, 'ramp-up'), 'ramp-up', 0),
      mode: loops ? 'iterations' as const : 'duration' as const, durationMs: time(one(opts, 'duration'), 'duration', 30_000), iterations: int(loops, 'loops', 1),
      thinkTimeMs: int(one(opts, 'think'), 'think', 0), runScripts: !opts['no-scripts'], data, environment, collections: ws.collections, folders: ws.folders, globals, settings, thresholds,
    }
    console.log(bold(`Load test: ${items.map((i) => i.request.name).join(' → ')}`), dim(`${cfg.virtualUsers} users, ${cfg.mode === 'duration' ? formatMs(cfg.durationMs) : `${cfg.iterations} loops each`}`))
    let last = 0
    const { stats, samples } = await runLoad(cfg, transport, pipeline, {
      onProgress: (s, active) => { if (process.stdout.isTTY && s.elapsedMs - last > 1000) { last = s.elapsedMs; process.stdout.write(`\r${dim(`${Math.round(s.elapsedMs / 1000)}s  ${active} users  ${s.count} requests  ${s.rps.toFixed(1)}/s  p95 ${s.p95} ms  errors ${s.errorRatePct.toFixed(1)}%`)}   `) } },
    })
    if (process.stdout.isTTY) process.stdout.write('\n')
    console.log(`requests ${bold(String(stats.count))} (${stats.rps.toFixed(1)}/s)   p50 ${stats.p50} ms   p90 ${stats.p90} ms   p95 ${bold(`${stats.p95} ms`)}   p99 ${stats.p99} ms   max ${stats.max} ms`)
    console.log(`errors ${stats.errors ? red(`${stats.errorRatePct.toFixed(2)}%`) : green('0%')}   statuses ${stats.statuses.map(([k, n]) => `${k}×${n}`).join(' ')}`)
    for (const [m, n] of stats.errorMessages.slice(0, 5)) console.log(red(`  ${m} × ${n}`))
    if (one(opts, 'samples')) writeFileSync(one(opts, 'samples')!, samplesCsv(samples))
    if (one(opts, 'json')) writeFileSync(one(opts, 'json')!, JSON.stringify({ stats, thresholds }, null, 2))
    const v = verdict(stats, thresholds)
    for (const ch of v.checks) console.log(ch.passed ? green(`✓ ${ch.label} (${ch.actual})`) : red(`✗ ${ch.label} (${ch.actual})`))
    return v.passed ? 0 : 1
  }

  const reporters = new Set((one(opts, 'reporters') ?? 'cli').split(',').map((s) => s.trim()))
  const cli = reporters.has('cli')
  let lastIt = -1
  const summary = await runCollection({
    items, iterations: one(opts, 'iterations') ? int(one(opts, 'iterations'), 'iterations', 1) : data ? 0 : 1, data,
    delayMs: int(one(opts, 'delay'), 'delay', 0), stopOnFailure: !!opts.bail, environment, collections: ws.collections, folders: ws.folders, globals, settings,
  }, transport, pipeline, {
    onResult: (r) => {
      if (!cli) return
      if (r.iteration !== lastIt) { lastIt = r.iteration; console.log(dim(`\nIteration ${r.iteration + 1}`)) }
      const status = r.skipped ? dim('skipped') : r.status !== null ? (r.status < 400 ? green(String(r.status)) : red(String(r.status))) : red('error')
      console.log(`${failed(r) ? red('✗') : green('✓')} ${r.method.padEnd(6)} ${r.name} ${dim(r.path)}  ${status} ${dim(r.status !== null ? formatMs(r.timeMs) : '')}`)
      if (r.error && !r.skipped) console.log(red(`    ${r.error}`))
      for (const t of r.tests) console.log(t.passed ? `    ${green('✓')} ${t.name}` : `    ${red('✗')} ${t.name}${t.error ? red(` — ${t.error}`) : ''}`)
      for (const l of r.detail.logs.filter((x) => x.level !== 'info')) console.log(dim(`    ${l.level}: ${l.text}`))
    },
  })
  const name = `${basename(file)}${one(opts, 'collection') ? ` / ${one(opts, 'collection')}` : ''}`
  if (reporters.has('json') || one(opts, 'json')) writeFileSync(one(opts, 'json') ?? 'dispatch-report.json', toJsonReport(summary, name))
  if (reporters.has('junit') || one(opts, 'junit')) writeFileSync(one(opts, 'junit') ?? 'dispatch-report.xml', toJUnit(summary, name))
  const bad = summary.testsFailed + summary.failedRequests
  console.log(`\n${bold('Summary')}  ${summary.iterations} iteration${summary.iterations === 1 ? '' : 's'}, ${summary.requests} requests (${summary.failedRequests ? red(`${summary.failedRequests} failed`) : green('0 failed')}${summary.skipped ? `, ${summary.skipped} skipped` : ''}), tests ${green(`${summary.testsPassed} passed`)}${summary.testsFailed ? `, ${red(`${summary.testsFailed} failed`)}` : ''}, avg ${formatMs(summary.avgTimeMs)}, total ${formatMs(summary.durationMs)}${summary.stopped !== 'done' ? yellow(`  (stopped: ${summary.stopped})`) : ''}`)
  return bad ? 1 : 0
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e instanceof Usage ? `dispatch-run: ${e.message}\nRun dispatch-run --help for options.` : e)
  process.exit(e instanceof Usage ? 2 : 1)
})
