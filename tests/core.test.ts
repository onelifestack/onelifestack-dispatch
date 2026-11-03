import { describe, expect, it } from 'vitest'
import { emptyAuth, kv, newCollection, newEnvironment, newRequest } from '../src/core/types'
import { interpolate, namesIn, scopeOf } from '../src/core/vars'
import { paramsFromUrl, parseQuery, splitUrl, urlWithParams, withScheme } from '../src/core/url'
import { jsonProblem, prepare } from '../src/core/prepare'
import { fromCurl, shellWords, toCurl } from '../src/core/curl'
import { exportWorkspace, importFile } from '../src/core/backup'
import { decodeBody, FetchTransport, SendError } from '../src/core/transport'
import { formatBytes, prettyJson, statusTone } from '../src/core/format'

describe('variables', () => {
  it('fills from scope, environment overriding collection', () => {
    const scope = scopeOf([kv('host', 'col.example'), kv('v', '1')], [kv('host', 'env.example')])
    expect(interpolate('https://{{host}}/v{{ v }}', scope)).toBe('https://env.example/v1')
  })
  it('skips disabled variables and reports unresolved names', () => {
    const missing = new Set<string>()
    const out = interpolate('{{a}}-{{b}}', scopeOf([kv('a', 'x', false), kv('b', 'y')]), missing)
    expect(out).toBe('{{a}}-y')
    expect([...missing]).toEqual(['a'])
  })
  it('resolves nested variables and stops on cycles', () => {
    expect(interpolate('{{url}}', scopeOf([kv('url', 'https://{{host}}'), kv('host', 'h')]))).toBe('https://h')
    expect(interpolate('{{a}}', scopeOf([kv('a', '{{a}}')]))).toBe('{{a}}')
  })
  it('has dynamic values', () => {
    expect(interpolate('{{$timestamp}}', new Map())).toMatch(/^\d{10}$/)
    expect(interpolate('{{$guid}}', new Map())).toMatch(/^[0-9a-f-]{20,}$/)
  })
  it('lists names', () => expect(namesIn('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']))
})

describe('url', () => {
  it('splits', () => expect(splitUrl('h/p?a=1&b#x')).toEqual({ base: 'h/p', query: 'a=1&b', hash: '#x' }))
  it('parses queries with encoding', () => expect(parseQuery('a=1%202&b&c=x+y')).toEqual([
    { key: 'a', value: '1 2' }, { key: 'b', value: '' }, { key: 'c', value: 'x y' },
  ]))
  it('keeps disabled params and reuses ids when the URL changes', () => {
    const a = kv('a', '1'); const off = kv('z', '9', false)
    const next = paramsFromUrl('https://x/?a=2&b=3', [a, off])
    expect(next.map((p) => [p.key, p.value, p.enabled])).toEqual([['a', '2', true], ['b', '3', true], ['z', '9', false]])
    expect(next[0].id).toBe(a.id)
  })
  it('rebuilds the URL from params, keeping variables readable', () => {
    expect(urlWithParams('https://x/p?old=1#h', [kv('q', 'a b'), kv('t', '{{token}}'), kv('off', '1', false)]))
      .toBe('https://x/p?q=a%20b&t={{token}}#h')
  })
  it('adds a scheme', () => {
    expect(withScheme('api.example.com/x')).toBe('https://api.example.com/x')
    expect(withScheme('localhost:8080')).toBe('http://localhost:8080')
    expect(withScheme('http://a')).toBe('http://a')
  })
})

describe('prepare', () => {
  const env = { ...newEnvironment(), variables: [kv('base', 'https://api.test'), kv('tok', 'secret')] }
  it('applies variables, headers and a JSON body', () => {
    const req = newRequest({ method: 'POST', url: '{{base}}/items', headers: [kv('X-A', '{{tok}}'), kv('X-Off', '1', false)],
      body: { kind: 'json', text: '{"a":1}', fields: [] } })
    const p = prepare(req, { environment: env })
    expect(p.url).toBe('https://api.test/items')
    expect(p.headers).toEqual([['X-A', 'secret'], ['Content-Type', 'application/json']])
    expect(p.body).toBe('{"a":1}')
    expect(p.unresolved).toEqual([])
  })
  it('does not override a content type the user set', () => {
    const req = newRequest({ method: 'POST', headers: [kv('content-type', 'application/vnd.x+json')], body: { kind: 'json', text: '{}', fields: [] } })
    expect(prepare(req).headers).toEqual([['content-type', 'application/vnd.x+json']])
  })
  it('encodes urlencoded bodies', () => {
    const req = newRequest({ method: 'POST', body: { kind: 'urlencoded', text: '', fields: [kv('a', 'x y&z'), kv('b', '{{tok}}')] } })
    expect(prepare(req, { environment: env }).body).toBe('a=x%20y%26z&b=secret')
  })
  it('handles basic, bearer and api key auth', () => {
    const basic = prepare(newRequest({ url: 'https://a', auth: { ...emptyAuth('basic'), username: 'é', password: 'p' } }))
    expect(basic.headers).toEqual([['Authorization', `Basic ${Buffer.from('é:p').toString('base64')}`]])
    const bearer = prepare(newRequest({ url: 'https://a', auth: { ...emptyAuth('bearer'), token: '{{tok}}' } }), { environment: env })
    expect(bearer.headers).toEqual([['Authorization', 'Bearer secret']])
    const q = prepare(newRequest({ url: 'https://a/?x=1', auth: { ...emptyAuth('apikey'), key: 'k', value: 'v v', in: 'query' } }))
    expect(q.url).toBe('https://a/?x=1&k=v%20v')
  })
  it('inherits collection auth and variables', () => {
    const col = { ...newCollection(), auth: { ...emptyAuth('bearer'), token: '{{t}}' }, variables: [kv('t', 'c')] }
    expect(prepare(newRequest({ url: 'https://a' }), { collection: col }).headers).toEqual([['Authorization', 'Bearer c']])
    expect(prepare(newRequest({ url: 'https://a' })).headers).toEqual([])
  })
  it('reports unresolved variables', () => {
    expect(prepare(newRequest({ url: '{{nope}}/x' })).unresolved).toEqual(['nope'])
  })
  it('sends no body with HEAD', () => {
    expect(prepare(newRequest({ method: 'HEAD', body: { kind: 'text', text: 'x', fields: [] } })).body).toBeNull()
  })
  it('checks JSON, tolerating variables', () => {
    expect(jsonProblem('{"a": {{n}}}')).toBeNull()
    expect(jsonProblem('{"a": }')).not.toBeNull()
  })
})

describe('curl', () => {
  it('splits shell words', () => {
    expect(shellWords(`curl 'a b' "c \\"d\\"" e\\ f \\\n -H $'x\\ny'`)).toEqual(['curl', 'a b', 'c "d"', 'e f', '-H', 'x\ny'])
  })
  it('imports a typical JSON POST', () => {
    const { request: r, warnings } = fromCurl(`curl -X POST 'https://api.test/v1/items?limit=5' \\
      -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' --data-raw '{"name":"x"}' --compressed`)
    expect(warnings).toEqual([])
    expect(r.method).toBe('POST')
    expect(r.url).toBe('https://api.test/v1/items?limit=5')
    expect(r.params.map((p) => [p.key, p.value])).toEqual([['limit', '5']])
    expect(r.auth.kind).toBe('bearer'); expect(r.auth.token).toBe('abc')
    expect(r.headers.map((h) => h.key)).toEqual(['Content-Type'])
    expect(r.body.kind).toBe('json'); expect(JSON.parse(r.body.text)).toEqual({ name: 'x' })
  })
  it('defaults to POST with data, urlencoded bodies, -u, -G and unknown flags', () => {
    const a = fromCurl('curl https://a.test -d a=1 -d b=2 -u me:pw')
    expect(a.request.method).toBe('POST')
    expect(a.request.body.fields.map((f) => [f.key, f.value])).toEqual([['a', '1'], ['b', '2']])
    expect(a.request.auth).toMatchObject({ kind: 'basic', username: 'me', password: 'pw' })
    const g = fromCurl('curl -G https://a.test -d q=x --frobnicate')
    expect(g.request.method).toBe('GET'); expect(g.request.url).toBe('https://a.test?q=x')
    expect(g.warnings).toEqual(['Ignored --frobnicate.'])
    expect(fromCurl('curl -XPUT --url=a.test/x').request).toMatchObject({ method: 'PUT', url: 'https://a.test/x' })
  })
  it('rejects non-curl input', () => {
    expect(() => fromCurl('wget x')).toThrow()
    expect(() => fromCurl('curl -H "a: b"')).toThrow(/No URL/)
  })
  it('exports and round-trips', () => {
    const p = prepare(newRequest({ method: 'POST', url: 'https://a.test/x', headers: [kv('X-Q', "it's")],
      body: { kind: 'json', text: '{"a":1}', fields: [] } }))
    const c = toCurl(p)
    expect(c).toContain(`-H 'X-Q: it'\\''s'`)
    const back = fromCurl(c).request
    expect(back.method).toBe('POST'); expect(back.url).toBe('https://a.test/x')
    expect(back.headers.find((h) => h.key === 'X-Q')?.value).toBe("it's")
  })
})

describe('backup and Postman import', () => {
  it('round-trips a workspace with fresh ids and remapped collections', () => {
    const col = newCollection('C'); const req = newRequest({ collectionId: col.id, url: 'https://a' }); const env = newEnvironment('E')
    const back = importFile(exportWorkspace({ collections: [col], requests: [req], environments: [env] }))
    expect(back.source).toBe('dispatch')
    expect(back.collections[0].id).not.toBe(col.id)
    expect(back.requests[0].collectionId).toBe(back.collections[0].id)
    expect(back.requests[0].url).toBe('https://a')
  })
  it('imports a Postman v2.1 collection with folders, auth and bodies', () => {
    const pm = {
      info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'base', value: 'https://shop.test' }],
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] },
      item: [
        { name: 'Orders', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: 'k' }] }, item: [
          { name: 'List', request: { method: 'GET', url: { raw: '{{base}}/orders?page=1', query: [{ key: 'page', value: '1' }, { key: 'debug', value: '1', disabled: true }] } } },
        ] },
        { name: 'Create', request: { method: 'POST', header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } }, url: '{{base}}/orders', auth: { type: 'noauth' } },
          event: [{ listen: 'test' }] },
        { name: 'Upload', request: { method: 'POST', url: 'x', body: { mode: 'formdata', formdata: [] } } },
        { name: 'OAuth', request: { method: 'GET', url: 'x', auth: { type: 'oauth2' } } },
      ],
    }
    const r = importFile(JSON.stringify(pm))
    expect(r.source).toBe('postman-collection')
    expect(r.collections[0]).toMatchObject({ name: 'Shop', auth: { kind: 'bearer', token: '{{tok}}' } })
    expect(r.collections[0].variables[0]).toMatchObject({ key: 'base', value: 'https://shop.test' })
    const [list, create] = r.requests
    expect(list.name).toBe('Orders / List')
    expect(list.auth).toMatchObject({ kind: 'apikey', key: 'X-Key', value: 'k' })
    expect(list.params.map((p) => [p.key, p.enabled])).toEqual([['page', true], ['debug', false]])
    expect(create.auth.kind).toBe('none')
    expect(create.body).toMatchObject({ kind: 'json', text: '{"a":1}' })
    expect(r.requests.every((q) => q.collectionId === r.collections[0].id)).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/scripts/)
    expect(r.warnings.join(' ')).toMatch(/formdata/)
    expect(r.warnings.join(' ')).toMatch(/oauth2/)
  })
  it('imports a Postman environment', () => {
    const r = importFile(JSON.stringify({ name: 'Prod', _postman_variable_scope: 'environment',
      values: [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: '2', enabled: false }] }))
    expect(r.environments[0].name).toBe('Prod')
    expect(r.environments[0].variables.map((v) => v.enabled)).toEqual([true, false])
  })
  it('rejects other files', () => {
    expect(() => importFile('nope')).toThrow(/valid JSON/)
    expect(() => importFile('{"x":1}')).toThrow(/Unrecognised/)
  })
})

describe('transport', () => {
  it('decodes text and detects binary', () => {
    expect(decodeBody(new TextEncoder().encode('héllo'))).toEqual({ body: 'héllo', binary: false })
    expect(decodeBody(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])).binary).toBe(true)
  })
  it('sends with fetch and reads the response', async () => {
    let seen: RequestInit | undefined
    const t = new FetchTransport(async (_u, init) => { seen = init; return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } }) })
    const res = await t.send({ method: 'POST', url: 'https://a', headers: [['X', '1']], body: 'b', unresolved: [] },
      { timeoutMs: 1000, followRedirects: true, insecureTls: false })
    expect(seen?.method).toBe('POST'); expect(seen?.body).toBe('b')
    expect(res).toMatchObject({ status: 201, body: '{"ok":true}', binary: false, size: 11 })
    expect(res.headers).toContainEqual(['content-type', 'application/json'])
  })
  it('explains network/CORS failures and timeouts', async () => {
    const fail = new FetchTransport(async () => { throw new TypeError('Failed to fetch') })
    const opts = { timeoutMs: 1000, followRedirects: true, insecureTls: false }
    const p = { method: 'GET' as const, url: 'https://a', headers: [], body: null, unresolved: [] }
    await expect(fail.send(p, opts)).rejects.toThrow(/CORS/)
    const slow = new FetchTransport((_u, init) => new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('aborted')))))
    await expect(slow.send(p, { ...opts, timeoutMs: 20 })).rejects.toBeInstanceOf(SendError)
    await expect(slow.send(p, { ...opts, timeoutMs: 20 })).rejects.toThrow(/No response/)
  })
})

describe('format', () => {
  it('formats', () => {
    expect(formatBytes(512)).toBe('512 B'); expect(formatBytes(2048)).toBe('2.0 KB')
    expect(statusTone(204)).toBe('good'); expect(statusTone(404)).toBe('warn'); expect(statusTone(0)).toBe('bad')
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}'); expect(prettyJson('<html>')).toBeNull()
  })
})
