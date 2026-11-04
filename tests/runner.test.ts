import { describe, expect, it } from 'vitest'
import { collectItems, runCollection, toJUnit, toJsonReport, type RunConfig } from '../src/core/runner'
import { parseCsv, parseDataFile } from '../src/core/csv'
import { InlineEngine, scriptPipeline } from '../src/core/scriptPipeline'
import { CookieTransport } from '../src/core/transport'
import { CookieJar } from '../src/core/cookies'
import { defaultSettings, kv, newCollection, newEnvironment, newFolder, newRequest } from '../src/core/types'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

class Fake implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  sent: PreparedRequest[] = []
  constructor(private readonly reply: (p: PreparedRequest) => Partial<HttpResponse> = () => ({})) {}
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.sent.push(p)
    return { status: 200, statusText: 'OK', headers: [], body: JSON.stringify({ url: p.url }), binary: false, size: 10, timeMs: 3, ...this.reply(p) }
  }
}

describe('csv and data files', () => {
  it('parses quotes, escapes, newlines and CRLF', () => {
    expect(parseCsv('﻿name,note\r\n"Ann, Jr","said ""hi"""\r\nBo,"two\nlines"\n')).toEqual([
      { name: 'Ann, Jr', note: 'said "hi"' }, { name: 'Bo', note: 'two\nlines' }])
  })
  it('reads JSON arrays and rejects bad files', () => {
    expect(parseDataFile('[{"a":1,"b":{"c":2}}]')).toEqual([{ a: '1', b: '{"c":2}' }])
    expect(() => parseDataFile('{"a":1}', 'x.json')).toThrow(/array of objects/)
    expect(() => parseDataFile('only,header')).toThrow(/header row/)
  })
})

describe('runner', () => {
  const col = { ...newCollection('Shop'), variables: [kv('base', 'https://shop.test')] }
  const f1 = newFolder(col.id, 'Orders'); const f2 = newFolder(col.id, 'Admin', f1.id)
  const reqs = [
    newRequest({ name: 'b-list', url: '{{base}}/orders', collectionId: col.id, folderId: f1.id }),
    newRequest({ name: 'a-login', url: '{{base}}/login', collectionId: col.id }),
    newRequest({ name: 'purge', url: '{{base}}/purge', collectionId: col.id, folderId: f2.id }),
  ]
  const base = (over: Partial<RunConfig> = {}): RunConfig => ({
    items: collectItems(col, null, [f1, f2], reqs), iterations: 1, data: null, delayMs: 0, stopOnFailure: false,
    environment: null, collections: [col], folders: [f1, f2], globals: [], settings: defaultSettings, ...over,
  })

  it('collects requests depth first with paths', () => {
    expect(collectItems(col, null, [f1, f2], reqs).map((i) => [i.request.name, i.path])).toEqual([
      ['a-login', 'Shop'], ['b-list', 'Shop / Orders'], ['purge', 'Shop / Orders / Admin']])
    expect(collectItems(col, f1.id, [f1, f2], reqs).map((i) => i.request.name)).toEqual(['b-list', 'purge'])
  })

  it('runs data-driven iterations and carries variables between requests', async () => {
    const t = new Fake()
    const login = { ...reqs[1], scripts: { pre: '', post: `pm.environment.set('who', pm.iterationData.get('user'))` } }
    const list = { ...reqs[0], url: '{{base}}/orders?u={{who}}&n={{n}}', scripts: { pre: '', post: `pm.test('ok', () => pm.response.to.have.status(200))` } }
    const env = { ...newEnvironment('E'), variables: [kv('who', '')] }
    const pipeline = scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) })
    const s = await runCollection(base({
      items: [{ request: login, path: 'Shop' }, { request: list, path: 'Shop / Orders' }], iterations: 0,
      data: [{ user: 'ann', n: '1' }, { user: 'bo', n: '2' }], environment: env,
    }), t, pipeline)
    expect(t.sent.map((p) => p.url)).toEqual(['https://shop.test/login', 'https://shop.test/orders?u=ann&n=1', 'https://shop.test/login', 'https://shop.test/orders?u=bo&n=2'])
    expect(s).toMatchObject({ iterations: 2, requests: 4, testsPassed: 2, testsFailed: 0, stopped: 'done' })
    expect(s.finalEnvironment?.find((v) => v.key === 'who')?.value).toBe('bo')
  })

  it('stops on failure, follows setNextRequest, guards loops and can be cancelled', async () => {
    const t = new Fake((p) => (p.url.endsWith('/orders') ? { status: 500, statusText: 'Error' } : {}))
    const pipeline = scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) })
    const failing = reqs.map((r) => ({ ...r, scripts: { pre: '', post: `pm.test('2xx', () => pm.response.to.be.ok)` } }))
    const s1 = await runCollection(base({ items: collectItems(col, null, [f1, f2], failing), stopOnFailure: true, iterations: 3 }), t, pipeline)
    expect(s1.stopped).toBe('failure'); expect(s1.requests).toBe(2)

    // a-login jumps straight to purge; purge stops the iteration
    const jump = [
      { ...reqs[1], scripts: { pre: '', post: `pm.execution.setNextRequest('purge')` } }, reqs[0],
      { ...reqs[2], scripts: { pre: '', post: `pm.execution.setNextRequest(null)` } },
    ]
    const t2 = new Fake()
    const s2 = await runCollection(base({ items: jump.map((request) => ({ request, path: '' })) }), t2, scriptPipeline({ engine: new InlineEngine(), transport: t2, sendOptions: () => ({ ...defaultSettings }) }))
    expect(s2.results.map((r) => r.name)).toEqual(['a-login', 'purge'])

    const loop = [{ ...reqs[1], scripts: { pre: '', post: `pm.execution.setNextRequest('a-login')` } }]
    const s3 = await runCollection(base({ items: loop.map((request) => ({ request, path: '' })) }), new Fake(), scriptPipeline({ engine: new InlineEngine(), transport: new Fake(), sendOptions: () => ({ ...defaultSettings }) }))
    expect(s3.stopped).toBe('setNextRequest'); expect(s3.requests).toBe(50)

    const ctrl = new AbortController()
    const s4 = await runCollection(base({ iterations: 10 }), new Fake(), {}, { signal: ctrl.signal, onResult: (_r, n) => { if (n === 2) ctrl.abort() } })
    expect(s4.stopped).toBe('cancelled'); expect(s4.requests).toBe(2)
  })

  it('waits between requests', async () => {
    const waits: number[] = []
    await runCollection(base({ delayMs: 250, iterations: 2 }), new Fake(), {}, { sleep: async (ms) => { waits.push(ms) } })
    expect(waits).toEqual([250, 250, 250, 250, 250])
  })

  it('writes JUnit and JSON reports', async () => {
    const t = new Fake((p) => (p.url.endsWith('/purge') ? { status: 403, statusText: 'Forbidden' } : {}))
    const items = collectItems(col, null, [f1, f2], reqs.map((r) => ({ ...r, scripts: { pre: '', post: `pm.test('ok <1>', () => pm.response.to.be.ok)` } })))
    const s = await runCollection(base({ items }), t, scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) }))
    const x = toJUnit(s)
    expect(x).toContain('tests="3" failures="1"')
    expect(x).toContain('name="ok &lt;1&gt;"')
    expect(x).toContain('<failure message=')
    const j = JSON.parse(toJsonReport(s))
    expect(j.results).toHaveLength(3); expect(j.results[0].detail).toBeUndefined(); expect(j.testsFailed).toBe(1)
  })

  it('keeps cookies between requests', async () => {
    const inner = new Fake((p) => (p.url.endsWith('/login') ? { headers: [['set-cookie', 'sid=s1; Path=/']] } : {}))
    const t = new CookieTransport(inner, new CookieJar())
    await runCollection(base(), t, {})
    expect(inner.sent[0].headers.find(([k]) => k === 'Cookie')).toBeUndefined()
    expect(inner.sent[1].headers).toContainEqual(['Cookie', 'sid=s1'])
  })
})
