import { describe, expect, it } from 'vitest'
import { computeStats, percentile, runLoad, samplesCsv, verdict, type LoadConfig, type Sample } from '../src/core/load'
import { InlineEngine, scriptPipeline } from '../src/core/scriptPipeline'
import { defaultSettings, kv, newEnvironment, newRequest } from '../src/core/types'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

class Fake implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  sent: PreparedRequest[] = []
  inFlight = 0; maxInFlight = 0
  constructor(private readonly reply: (p: PreparedRequest, n: number) => Partial<HttpResponse> = () => ({}), private readonly delay = 5) {}
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.sent.push(p); this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    await new Promise((r) => setTimeout(r, this.delay))
    this.inFlight--
    return { status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: this.delay, ...this.reply(p, this.sent.length) }
  }
}

const cfg = (over: Partial<LoadConfig> = {}): LoadConfig => ({
  items: [{ request: newRequest({ name: 'ping', url: 'https://api.test/ping' }), path: '' }],
  virtualUsers: 5, rampUpMs: 0, mode: 'iterations', durationMs: 60_000, iterations: 4, thinkTimeMs: 0, runScripts: false, data: null,
  environment: null, collections: [], folders: [], globals: [], settings: defaultSettings, thresholds: { p95Ms: null, errorRatePct: null, minRps: null }, ...over,
})

describe('load stats', () => {
  it('computes nearest-rank percentiles', () => {
    const a = Array.from({ length: 100 }, (_, i) => i + 1)
    expect([percentile(a, 50), percentile(a, 95), percentile(a, 99), percentile(a, 100)]).toEqual([50, 95, 99, 100])
    expect(percentile([], 95)).toBe(0)
  })
  it('summarises samples, buckets per second and checks thresholds', () => {
    const samples: Sample[] = [
      { t: 100, ms: 10, status: 200, ok: true, bytes: 5, vu: 0, name: 'a' },
      { t: 900, ms: 30, status: 500, ok: false, bytes: 5, vu: 1, name: 'a', error: 'HTTP 500' },
      { t: 1500, ms: 20, status: 200, ok: true, bytes: 5, vu: 0, name: 'b' },
      { t: 1600, ms: 0, status: null, ok: false, bytes: 0, vu: 1, name: 'b', error: 'timeout' },
    ]
    const s = computeStats(samples, 2000)
    expect(s).toMatchObject({ count: 4, errors: 2, errorRatePct: 50, rps: 2, min: 10, max: 30, p50: 20, bytes: 15 })
    expect(s.timeline.map((b) => [b.second, b.count, b.errors])).toEqual([[0, 2, 1], [1, 2, 1]])
    expect(s.statuses).toContainEqual(['no response', 1])
    expect(s.perRequest.find((r) => r.name === 'b')).toMatchObject({ count: 2, errors: 1 })
    const v = verdict(s, { p95Ms: 25, errorRatePct: 10, minRps: 1 })
    expect(v.passed).toBe(false)
    expect(v.checks.map((c) => c.passed)).toEqual([false, false, true])
    expect(samplesCsv(samples).split('\n')[2]).toBe('900,30,500,false,5,1,a,HTTP 500')
  })
})

describe('runLoad', () => {
  it('runs users concurrently for a fixed number of iterations', async () => {
    const t = new Fake()
    const { stats } = await runLoad(cfg(), t, {})
    expect(stats.count).toBe(20)
    expect(t.maxInFlight).toBe(5)
    expect(stats.errors).toBe(0)
  })
  it('stops at the duration and counts HTTP errors', async () => {
    const t = new Fake((_p, n) => (n % 4 === 0 ? { status: 503, statusText: 'Busy' } : {}), 10)
    const started = Date.now()
    const { stats } = await runLoad(cfg({ mode: 'duration', durationMs: 1000, virtualUsers: 3 }), t, {})
    expect(Date.now() - started).toBeLessThan(2000)
    expect(stats.count).toBeGreaterThan(30)
    expect(stats.errorRatePct).toBeGreaterThan(10)
    expect(stats.statuses.map(([k]) => k)).toContain('503')
  })
  it('caps users, can be stopped, and keeps script variables per user', async () => {
    const t = new Fake((p) => ({ body: JSON.stringify({ u: p.url }) }))
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 200)
    const r1 = await runLoad(cfg({ mode: 'duration', durationMs: 60_000, virtualUsers: 5000 }), t, {}, { signal: ctrl.signal })
    expect(r1.stats.count).toBeGreaterThan(0)
    expect(new Set(r1.samples.map((s) => s.vu)).size).toBeLessThanOrEqual(200)

    const t2 = new Fake()
    const req = newRequest({ name: 'me', url: 'https://api.test/me?who={{who}}', scripts: { pre: `pm.environment.set('who', 'user' + pm.iterationData.get('n'))`, post: `pm.test('ok', () => pm.response.to.be.ok)` } })
    const pipeline = scriptPipeline({ engine: new InlineEngine(), transport: t2, sendOptions: () => ({ ...defaultSettings }) })
    const { stats } = await runLoad(cfg({ items: [{ request: req, path: '' }], virtualUsers: 2, iterations: 2, runScripts: true, data: [{ n: '1' }, { n: '2' }],
      environment: { ...newEnvironment(), variables: [kv('who', '')] } }), t2, pipeline)
    expect(stats.count).toBe(4)
    expect(t2.sent.map((p) => p.url).sort()).toEqual(['https://api.test/me?who=user1', 'https://api.test/me?who=user1', 'https://api.test/me?who=user2', 'https://api.test/me?who=user2'])
  })
  it('ramps users up over time', async () => {
    const waits: number[] = []
    await runLoad(cfg({ virtualUsers: 4, rampUpMs: 4000, iterations: 1 }), new Fake(), {}, { sleep: async (ms) => { waits.push(ms) } })
    expect(waits.sort((a, b) => a - b)).toEqual([0, 1000, 2000, 3000])
  })
})
