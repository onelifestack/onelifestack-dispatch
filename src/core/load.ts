import type { Collection, Environment, Folder, KV, Settings } from './types'
import type { Transport } from './transport'
import type { RunItem } from './runner'
import { type Pipeline, type RunContext, execute, sendOptions } from './runtime'

export const MAX_VUS = 200
export const MAX_DURATION_MS = 30 * 60_000

export interface LoadConfig {
  /** One request, or a flow that each virtual user repeats in order. */
  items: RunItem[]
  virtualUsers: number
  /** Users start evenly over this time. */
  rampUpMs: number
  mode: 'duration' | 'iterations'
  durationMs: number
  /** Per user, when mode is "iterations". */
  iterations: number
  /** Pause after each request, per user. */
  thinkTimeMs: number
  /** Run scripts and tests (slower; each script runs in its own sandbox). */
  runScripts: boolean
  data: Record<string, string>[] | null
  environment: Environment | null
  collections: Collection[]
  folders: Folder[]
  globals: KV[]
  settings: Settings
  thresholds: Thresholds
}

export interface Thresholds { p95Ms: number | null; errorRatePct: number | null; minRps: number | null }

export interface Sample { t: number; ms: number; status: number | null; ok: boolean; bytes: number; vu: number; name: string; error?: string }

export interface Bucket { second: number; count: number; errors: number; p50: number; p95: number; activeUsers: number }

export interface LoadStats {
  count: number
  errors: number
  errorRatePct: number
  rps: number
  min: number; max: number; avg: number; p50: number; p90: number; p95: number; p99: number
  bytes: number
  statuses: [string, number][]
  errorMessages: [string, number][]
  perRequest: { name: string; count: number; errors: number; p50: number; p95: number }[]
  timeline: Bucket[]
  elapsedMs: number
}

export interface Verdict { passed: boolean; checks: { label: string; passed: boolean; actual: string }[] }

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

/** A sample is ok when it got a response below 400 and its tests (if any ran) passed. */
export function computeStats(samples: Sample[], elapsedMs: number, active: (second: number) => number = () => 0): LoadStats {
  const lat = samples.filter((s) => s.status !== null).map((s) => s.ms).sort((a, b) => a - b)
  const errors = samples.filter((s) => !s.ok).length
  const statuses = new Map<string, number>()
  const errorMessages = new Map<string, number>()
  for (const s of samples) {
    const k = s.status === null ? 'no response' : String(s.status)
    statuses.set(k, (statuses.get(k) ?? 0) + 1)
    if (s.error) errorMessages.set(s.error, (errorMessages.get(s.error) ?? 0) + 1)
  }
  const per = new Map<string, Sample[]>()
  for (const s of samples) { const a = per.get(s.name); if (a) a.push(s); else per.set(s.name, [s]) }
  const buckets = new Map<number, Sample[]>()
  for (const s of samples) { const sec = Math.floor(s.t / 1000); const a = buckets.get(sec); if (a) a.push(s); else buckets.set(sec, [s]) }
  const lastSec = Math.max(0, Math.ceil(elapsedMs / 1000) - 1)
  const timeline: Bucket[] = []
  for (let sec = 0; sec <= lastSec; sec++) {
    const b = buckets.get(sec) ?? []
    const l = b.filter((s) => s.status !== null).map((s) => s.ms).sort((x, y) => x - y)
    timeline.push({ second: sec, count: b.length, errors: b.filter((s) => !s.ok).length, p50: percentile(l, 50), p95: percentile(l, 95), activeUsers: active(sec) })
  }
  return {
    count: samples.length, errors, errorRatePct: samples.length ? (errors / samples.length) * 100 : 0,
    rps: elapsedMs > 0 ? samples.length / (elapsedMs / 1000) : 0,
    min: lat[0] ?? 0, max: lat[lat.length - 1] ?? 0, avg: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
    p50: percentile(lat, 50), p90: percentile(lat, 90), p95: percentile(lat, 95), p99: percentile(lat, 99),
    bytes: samples.reduce((n, s) => n + s.bytes, 0),
    statuses: [...statuses].sort((a, b) => b[1] - a[1]),
    errorMessages: [...errorMessages].sort((a, b) => b[1] - a[1]).slice(0, 10),
    perRequest: [...per].map(([name, ss]) => {
      const l = ss.filter((s) => s.status !== null).map((s) => s.ms).sort((x, y) => x - y)
      return { name, count: ss.length, errors: ss.filter((s) => !s.ok).length, p50: percentile(l, 50), p95: percentile(l, 95) }
    }),
    timeline, elapsedMs,
  }
}

export function verdict(s: LoadStats, t: Thresholds): Verdict {
  const checks: Verdict['checks'] = []
  if (t.p95Ms != null) checks.push({ label: `p95 under ${t.p95Ms} ms`, passed: s.p95 <= t.p95Ms, actual: `${s.p95} ms` })
  if (t.errorRatePct != null) checks.push({ label: `errors under ${t.errorRatePct}%`, passed: s.errorRatePct <= t.errorRatePct, actual: `${s.errorRatePct.toFixed(2)}%` })
  if (t.minRps != null) checks.push({ label: `at least ${t.minRps} requests/s`, passed: s.rps >= t.minRps, actual: `${s.rps.toFixed(1)}/s` })
  return { passed: checks.every((c) => c.passed), checks }
}

export interface LoadHooks {
  signal?: AbortSignal
  /** Called about every 500 ms with fresh stats. */
  onProgress?: (stats: LoadStats, activeUsers: number) => void
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (ms <= 0 || signal?.aborted) { resolve(); return }
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

/**
 * Runs virtual users concurrently. Each user repeats the items in order until the time is up (or its iterations
 * are done). Variables changed by scripts stay per user, so users don't overwrite each other's tokens.
 */
export async function runLoad(cfg: LoadConfig, transport: Transport, pipeline: Pipeline, hooks: LoadHooks = {}): Promise<{ stats: LoadStats; samples: Sample[] }> {
  const now = hooks.now ?? (() => performance.now())
  const sleep = hooks.sleep ?? realSleep
  const vus = Math.max(1, Math.min(MAX_VUS, Math.round(cfg.virtualUsers)))
  const duration = Math.min(MAX_DURATION_MS, Math.max(1000, cfg.durationMs))
  const start = now()
  const deadline = start + duration
  const samples: Sample[] = []
  const activity: [number, number][] = [] // [ms since start, +1/-1]
  let active = 0
  const ctrl = new AbortController()
  const stop = () => ctrl.abort()
  hooks.signal?.addEventListener('abort', stop)
  const timer = cfg.mode === 'duration' ? setTimeout(stop, duration + 50) : null
  const activeAt = (sec: number) => activity.filter(([t]) => t < (sec + 1) * 1000).reduce((n, [, d]) => n + d, 0)
  const progress = setInterval(() => hooks.onProgress?.(computeStats(samples, now() - start, activeAt), active), 500)
  const pl = cfg.runScripts ? pipeline : {}

  const user = async (vu: number) => {
    await sleep(vus > 1 ? (cfg.rampUpMs * vu) / vus : 0, ctrl.signal)
    if (ctrl.signal.aborted) return
    active++; activity.push([now() - start, 1])
    let environment = cfg.environment ? structuredClone(cfg.environment) : null
    const collections = new Map(cfg.collections.map((c) => [c.id, structuredClone(c)]))
    let globals = cfg.globals
    let iteration = 0
    try {
      while (!ctrl.signal.aborted) {
        if (cfg.mode === 'iterations' && iteration >= cfg.iterations) break
        if (cfg.mode === 'duration' && now() >= deadline) break
        const data = cfg.data?.length ? cfg.data[(vu + iteration * vus) % cfg.data.length] : null
        const locals = new Map<string, string>()
        for (const item of cfg.items) {
          if (ctrl.signal.aborted || (cfg.mode === 'duration' && now() >= deadline)) break
          const ctx: RunContext = {
            collection: item.request.collectionId ? collections.get(item.request.collectionId) ?? null : null,
            folders: cfg.folders, environment, globals, data, locals,
          }
          const t0 = now()
          const x = await execute(item.request, ctx, transport, sendOptions(item.request, cfg.settings, ctrl.signal), pl)
          if (ctrl.signal.aborted && !x.response) break // cut off by the end of the test, not a real failure
          if (x.changes.environment && environment) environment = { ...environment, variables: x.changes.environment }
          if (x.changes.collection && ctx.collection) collections.set(ctx.collection.id, { ...ctx.collection, variables: x.changes.collection })
          if (x.changes.globals) globals = x.changes.globals
          const ok = !!x.response && x.response.status < 400 && x.tests.every((tr) => tr.passed)
          samples.push({
            t: t0 - start, ms: x.response?.timeMs ?? Math.round(now() - t0), status: x.response?.status ?? null, ok, bytes: x.response?.size ?? 0, vu, name: item.request.name,
            error: x.error ?? (x.response && x.response.status >= 400 ? `HTTP ${x.response.status}` : x.tests.find((tr) => !tr.passed) ? `test failed: ${x.tests.find((tr) => !tr.passed)!.name}` : undefined),
          })
          if (cfg.thinkTimeMs > 0) await sleep(cfg.thinkTimeMs, ctrl.signal)
        }
        iteration++
      }
    } finally {
      active--; activity.push([now() - start, -1])
    }
  }

  try {
    await Promise.all(Array.from({ length: vus }, (_, i) => user(i)))
  } finally {
    clearInterval(progress)
    if (timer) clearTimeout(timer)
    hooks.signal?.removeEventListener('abort', stop)
  }
  const stats = computeStats(samples, now() - start, activeAt)
  hooks.onProgress?.(stats, 0)
  return { stats, samples }
}

/** Raw samples as CSV, for spreadsheets. */
export function samplesCsv(samples: Sample[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return ['t_ms,latency_ms,status,ok,bytes,user,request,error', ...samples.map((s) => [Math.round(s.t), s.ms, s.status ?? '', s.ok, s.bytes, s.vu, q(s.name), q(s.error ?? '')].join(','))].join('\n') + '\n'
}
