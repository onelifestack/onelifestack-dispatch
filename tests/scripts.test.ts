import { describe, expect, it } from 'vitest'
import { compileWithFunction, runScript, type ScriptInput } from '../src/core/scripts'
import { InlineEngine, applyVars, scriptPipeline } from '../src/core/scriptPipeline'
import { execute } from '../src/core/runtime'
import { emptyBody, kv, newCollection, newEnvironment, newFolder, newRequest, defaultSettings } from '../src/core/types'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'
import { queryJson } from '../src/core/jsonpath'
import { CookieJar, parseSetCookie } from '../src/core/cookies'

const base = (code: string, extra: Partial<ScriptInput> = {}): ScriptInput => ({
  phase: 'post', source: 'test', code,
  request: { name: 'r', url: 'https://a.test/x', method: 'GET', headers: [], body: { mode: 'none', raw: '' } },
  response: { code: 200, status: 'OK', headers: [['Content-Type', 'application/json']], body: '{"id":7,"items":[{"n":1},{"n":2}]}', responseTime: 12, responseSize: 30 },
  vars: { globals: {}, collection: {}, environment: { e: '1' }, data: {}, locals: {} },
  info: { requestName: 'r', requestId: 'id', iteration: 0, iterationCount: 1 },
  ...extra,
})
const noHost = { sendRequest: async () => { throw new Error('no network in tests') } }
const run = (code: string, extra?: Partial<ScriptInput>) => runScript(base(code, extra), noHost, compileWithFunction)

describe('scripts', () => {
  it('records passing and failing tests with chai', async () => {
    const o = await run(`
      pm.test('status', () => pm.response.to.have.status(200))
      pm.test('id', () => pm.expect(pm.response.json().id).to.equal(8))
      pm.test('header', () => pm.response.to.have.header('content-type'))
      pm.test('fast', () => pm.expect(pm.response.responseTime).to.be.below(100))
      pm.test('json path', () => pm.response.to.have.jsonBody('items'))`)
    expect(o.tests.map((t) => [t.name, t.passed])).toEqual([['status', true], ['id', false], ['header', true], ['fast', true], ['json path', true]])
    expect(o.tests[1].error).toMatch(/expected 7 to equal 8/)
  })
  it('reads and writes variable scopes', async () => {
    const o = await run(`
      pm.environment.set('token', 'abc'); pm.environment.unset('e')
      pm.collectionVariables.set('n', 5); pm.globals.set('g', {a: 1}); pm.variables.set('local', 'L')
      console.log('resolved', pm.variables.get('token'), pm.variables.get('local'))`)
    expect(o.vars.environment).toEqual({ token: 'abc' })
    expect(o.vars.collection).toEqual({ n: '5' })
    expect(o.vars.globals.g).toContain('"a": 1')
    expect(o.vars.locals).toEqual({ local: 'L' })
    expect(o.logs[0].text).toBe('resolved abc L')
  })
  it('lets pre-request scripts change the request', async () => {
    const o = await run(`
      pm.request.url = pm.request.url + '?q=1'; pm.request.method = 'post'
      pm.request.headers.add({ key: 'X-A', value: '1' }); pm.request.body.raw = '{"a":1}'`, { phase: 'pre', response: null })
    expect(o.request).toMatchObject({ url: 'https://a.test/x?q=1', method: 'POST', headers: [{ key: 'X-A', value: '1' }], body: { raw: '{"a":1}' } })
  })
  it('reports thrown errors and async test failures', async () => {
    const o = await run(`pm.test('later', async () => { await null; throw new Error('nope') }); undefinedThing()`)
    expect(o.error).toMatch(/undefinedThing/)
    const a = await run(`pm.test('later', async () => { await null; throw new Error('nope') })`)
    expect(a.tests).toEqual([{ name: 'later', passed: false, error: 'nope' }])
  })
  it('supports sendRequest with await and callbacks', async () => {
    const host = { sendRequest: async (r: { url: string }) => ({ code: 201, status: 'Created', headers: [] as [string, string][], body: `{"u":"${r.url}"}`, responseTime: 1, responseSize: 1 }) }
    const o = await runScript(base(`
      const r = await pm.sendRequest('https://other.test/a')
      pm.environment.set('u', r.json().u)
      pm.sendRequest({ url: 'https://other.test/b', method: 'POST' }, (err, res) => pm.environment.set('cb', String(res.code)))`), host, compileWithFunction)
    expect(o.vars.environment).toMatchObject({ u: 'https://other.test/a', cb: '201' })
  })
  it('supports the legacy tests object, skip and setNextRequest', async () => {
    const o = await run(`tests['old style'] = responseCode.code === 200; pm.execution.setNextRequest(null); pm.execution.skipRequest()`)
    expect(o.tests).toEqual([{ name: 'old style', passed: true }])
    expect(o.nextRequest).toBeNull(); expect(o.skip).toBe(true)
  })
  it('stops scripts that run too long', async () => {
    const engine = new InlineEngine(compileWithFunction, 50)
    const o = await engine.run(base(`await new Promise(() => {})`), noHost)
    expect(o.error).toMatch(/longer than/)
  })
})

describe('applyVars', () => {
  it('updates, adds and removes rows but keeps disabled ones', () => {
    const rows = [kv('a', '1'), kv('b', '2'), kv('off', 'x', false)]
    const out = applyVars(rows, { a: '9', c: '3' })
    expect(out.map((r) => [r.key, r.value, r.enabled])).toEqual([['a', '9', true], ['off', 'x', false], ['c', '3', true]])
    expect(out[0].id).toBe(rows[0].id)
  })
})

class Fake implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  sent: PreparedRequest[] = []
  constructor(private readonly reply: (p: PreparedRequest) => HttpResponse) {}
  async send(p: PreparedRequest, _o: SendOptions) { this.sent.push(p); return this.reply(p) }
}
const ok = (body: string): HttpResponse => ({ status: 200, statusText: 'OK', headers: [], body, binary: false, size: body.length, timeMs: 5 })

describe('script pipeline', () => {
  it('runs collection → folder → request scripts in order, applies changes, and records tests', async () => {
    const t = new Fake((p) => ok(JSON.stringify({ path: p.url, auth: p.headers.find(([k]) => k === 'X-Token')?.[1] })))
    const col = { ...newCollection('C'), variables: [kv('base', 'https://api.test')], scripts: { pre: `console.log('col'); pm.collectionVariables.set('order', 'c')`, post: `pm.test('col post', () => {})` } }
    const folder = { ...newFolder(col.id, 'F'), scripts: { pre: `pm.collectionVariables.set('order', pm.collectionVariables.get('order') + 'f')`, post: '' } }
    const env = { ...newEnvironment('E'), variables: [kv('tok', 'old')] }
    const req = newRequest({ name: 'R', url: '{{base}}/items', collectionId: col.id, folderId: folder.id, headers: [kv('X-Token', '{{tok}}')],
      scripts: { pre: `pm.environment.set('tok', 'new-' + pm.collectionVariables.get('order'))`, post: `pm.test('got token', () => pm.expect(pm.response.json().auth).to.equal('new-cf'))` } })
    const ctx = { collection: col, folders: [folder], environment: env, globals: [] }
    const pipeline = scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) })
    const x = await execute(req, ctx, t, { timeoutMs: 1000, followRedirects: true, insecureTls: false }, pipeline)
    expect(x.error).toBeNull()
    expect(x.sent.headers).toContainEqual(['X-Token', 'new-cf'])
    expect(x.tests.map((r) => [r.name, r.passed])).toEqual([['col post', true], ['got token', true]])
    expect(x.changes.environment?.find((v) => v.key === 'tok')?.value).toBe('new-cf')
    expect(x.changes.collection?.find((v) => v.key === 'order')?.value).toBe('cf')
    expect(x.logs[0]).toMatchObject({ text: 'col', source: 'Collection “C”' })
  })
  it('does not send when a pre-request script throws or skips', async () => {
    const t = new Fake(() => ok('{}'))
    const pipeline = scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) })
    const ctx = { collection: null, folders: [], environment: null, globals: [] }
    const opts = { timeoutMs: 1000, followRedirects: true, insecureTls: false }
    const bad = await execute(newRequest({ url: 'https://a.test', scripts: { pre: 'throw new Error("boom")', post: '' } }), ctx, t, opts, pipeline)
    expect(bad.error).toMatch(/pre-request script failed.*boom/)
    const skip = await execute(newRequest({ url: 'https://a.test', scripts: { pre: 'pm.execution.skipRequest()', post: '' } }), ctx, t, opts, pipeline)
    expect(skip.skipped).toBe(true)
    expect(t.sent).toHaveLength(0)
  })
  it('lets a pre-request script change the body', async () => {
    const t = new Fake(() => ok('{}'))
    const pipeline = scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) })
    await execute(newRequest({ method: 'POST', url: 'https://a.test', body: { ...emptyBody('json'), text: '{}' }, scripts: { pre: 'pm.request.body.raw = JSON.stringify({ at: 1 })', post: '' } }),
      { collection: null, folders: [], environment: null, globals: [] }, t, { timeoutMs: 1000, followRedirects: true, insecureTls: false }, pipeline)
    expect(t.sent[0].body).toBe('{"at":1}')
  })
})

describe('json filter and cookies', () => {
  const data = { a: { items: [{ id: 1, tags: ['x'] }, { id: 2, tags: ['y'] }] }, 'odd key': 3 }
  it('queries', () => {
    expect(queryJson(data, '$.a.items[*].id')).toEqual([1, 2])
    expect(queryJson(data, 'a.items[-1].id')).toEqual([2])
    expect(queryJson(data, "$['odd key']")).toEqual([3])
    expect(queryJson(data, '$..id')).toEqual([1, 2])
    expect(queryJson(data, '$.a.items[0:1]')).toEqual([{ id: 1, tags: ['x'] }])
    expect(() => queryJson(data, '$.a[')).toThrow()
  })
  it('parses Set-Cookie and keeps a jar', () => {
    expect(parseSetCookie('sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60')).toMatchObject({ name: 'sid', value: 'abc', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 60 })
    const jar = new CookieJar()
    jar.store('https://api.test/login', [['set-cookie', 'sid=1; Path=/'], ['set-cookie', 'evil=1; Domain=other.test']], 0)
    expect(jar.header('https://api.test/me', 1)).toBe('sid=1')
    expect(jar.header('https://other.test/', 1)).toBeNull()
    jar.store('https://api.test/logout', [['set-cookie', 'sid=; Path=/; Max-Age=0']], 2)
    expect(jar.header('https://api.test/me', 3)).toBeNull()
  })
})
