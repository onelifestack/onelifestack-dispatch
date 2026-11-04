/** Scheduled runs: a collection (or folder) run every N minutes while the app is open. */
import type { Collection, Environment, Folder, KV, RequestDef, Settings } from './types'
import { uid } from './types'
import type { Transport } from './transport'
import type { Pipeline } from './runtime'
import { collectItems, failed, runCollection } from './runner'

export interface Schedule {
  id: string
  name: string
  collectionId: string
  folderId: string | null
  environmentId: string | null
  everyMinutes: number
  enabled: boolean
  notifyOnFailure: boolean
  lastRunAt: number | null
}

export interface ScheduleRun {
  id: string
  scheduleId: string
  at: number
  durationMs: number
  requests: number
  failedRequests: number
  testsPassed: number
  testsFailed: number
  avgTimeMs: number
  /** Up to 10 failures: request name and why. */
  failures: { name: string; reason: string }[]
}

export const MIN_EVERY = 1
export const RUNS_KEPT = 100

export function newSchedule(collectionId: string, name: string): Schedule {
  return { id: uid(), name, collectionId, folderId: null, environmentId: null, everyMinutes: 15, enabled: true, notifyOnFailure: true, lastRunAt: null }
}

export const isDue = (s: Schedule, now = Date.now()) => s.enabled && (s.lastRunAt === null || now - s.lastRunAt >= Math.max(MIN_EVERY, s.everyMinutes) * 60_000)

export interface ScheduleWorld {
  collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environments: Environment[]; globals: KV[]; settings: Settings
}

/** Runs one schedule once. Variable changes made by scripts are not kept (a monitor shouldn't change your setup). */
export async function runSchedule(s: Schedule, w: ScheduleWorld, transport: Transport, pipeline: Pipeline, signal?: AbortSignal): Promise<ScheduleRun> {
  const col = w.collections.find((c) => c.id === s.collectionId)
  const base: ScheduleRun = { id: uid(), scheduleId: s.id, at: Date.now(), durationMs: 0, requests: 0, failedRequests: 0, testsPassed: 0, testsFailed: 0, avgTimeMs: 0, failures: [] }
  if (!col) return { ...base, failedRequests: 1, failures: [{ name: s.name, reason: 'The collection no longer exists.' }] }
  const items = collectItems(col, s.folderId, w.folders, w.requests)
  const sum = await runCollection({
    items, iterations: 1, data: null, delayMs: 0, stopOnFailure: false,
    environment: w.environments.find((e) => e.id === s.environmentId) ?? null,
    collections: w.collections, folders: w.folders, globals: w.globals, settings: w.settings,
  }, transport, pipeline, { signal })
  return {
    ...base, durationMs: sum.durationMs, requests: sum.requests, failedRequests: sum.failedRequests, testsPassed: sum.testsPassed, testsFailed: sum.testsFailed, avgTimeMs: sum.avgTimeMs,
    failures: sum.results.filter(failed).slice(0, 10).map((r) => ({ name: r.name, reason: r.error ?? r.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error ?? 'failed'}`).join('; ') })),
  }
}

export const runFailed = (r: ScheduleRun) => r.failedRequests > 0 || r.testsFailed > 0
