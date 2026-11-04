import { describe, expect, it } from 'vitest'
import { importBruno, parseBru, toPostmanCollection, toPostmanEnvironment } from '../src/core/interop'
import { importFile } from '../src/core/backup'
import { emptyAuth, emptyBody, kv, newCollection, newEnvironment, newFolder, newRequest, uid } from '../src/core/types'

describe('Postman export', () => {
  it('round-trips through the Postman importer', () => {
    const col = { ...newCollection('Shop'), docs: 'Docs', auth: { ...emptyAuth('bearer'), token: '{{t}}' }, variables: [kv('base', 'https://s.test'), kv('t', 'top-secret-value', true, { secret: true })], scripts: { pre: 'console.log(1)', post: '' } }
    const f = { ...newFolder(col.id, 'Orders'), sort: 2, auth: { ...emptyAuth('apikey'), key: 'X-K', value: 'v' } }
    const r1 = newRequest({ name: 'Login', method: 'POST', url: '{{base}}/login', collectionId: col.id, sort: 1, body: { ...emptyBody('json'), text: '{"u":1}' }, scripts: { pre: '', post: 'pm.test("ok", () => {})' } })
    const r2 = newRequest({ name: 'One', url: '{{base}}/orders/:id?x=1', params: [kv('x', '1'), kv('off', '2', false)], pathVars: [kv('id', '7')], collectionId: col.id, folderId: f.id, sort: 1,
      examples: [{ id: uid(), name: 'ok', status: 200, headers: [['Content-Type', 'application/json']], body: '{}' }] })
    const json = toPostmanCollection(col, [f], [r1, r2])
    expect(json).not.toContain('top-secret-value')
    const back = importFile(json)
    expect(back.collections[0]).toMatchObject({ name: 'Shop', auth: { kind: 'bearer', token: '{{t}}' }, scripts: { pre: 'console.log(1)' } })
    expect(back.folders[0]).toMatchObject({ name: 'Orders', auth: { kind: 'apikey', key: 'X-K' } })
    const [login, one] = back.requests
    expect(login).toMatchObject({ name: 'Login', method: 'POST', body: { kind: 'json', text: '{"u":1}' }, scripts: { post: 'pm.test("ok", () => {})' } })
    expect(one.folderId).toBe(back.folders[0].id)
    expect(one.pathVars.map((p) => [p.key, p.value])).toEqual([['id', '7']])
    expect(one.params.map((p) => [p.key, p.enabled])).toEqual([['x', true], ['off', false]])
    expect(one.examples[0]).toMatchObject({ name: 'ok', status: 200 })
  })
  it('exports environments without secret values', () => {
    const e = JSON.parse(toPostmanEnvironment({ ...newEnvironment('Prod'), variables: [kv('a', '1'), kv('k', 'shh', true, { secret: true })] }))
    expect(e.values).toEqual([{ key: 'a', value: '1', type: 'default', enabled: true }, { key: 'k', value: '', type: 'secret', enabled: true }])
  })
})

describe('Insomnia import', () => {
  it('reads workspaces, nested groups, environments and bodies', () => {
    const d = { _type: 'export', __export_format: 4, __export_source: 'insomnia.desktop.app:v2023', resources: [
      { _id: 'wrk', _type: 'workspace', name: 'Ins API' },
      { _id: 'env_base', _type: 'environment', parentId: 'wrk', name: 'Base', data: { base: 'https://i.test' } },
      { _id: 'env_prod', _type: 'environment', parentId: 'env_base', name: 'Prod', data: { base: 'https://prod.test', n: 2 } },
      { _id: 'fld_child', _type: 'request_group', parentId: 'fld_top', name: 'Child' },
      { _id: 'fld_top', _type: 'request_group', parentId: 'wrk', name: 'Top' },
      { _id: 'req1', _type: 'request', parentId: 'fld_child', name: 'Create', method: 'POST', url: '{{ _.base }}/items',
        headers: [{ name: 'X-A', value: '{{ _.n }}' }], parameters: [{ name: 'q', value: '1' }],
        body: { mimeType: 'application/json', text: '{"a": 1}' }, authentication: { type: 'bearer', token: '{{ _.tok }}' } },
      { _id: 'req2', _type: 'request', parentId: 'wrk', name: 'Form', method: 'POST', url: 'https://i.test/f', body: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'k', value: 'v' }] } },
    ] }
    const r = importFile(JSON.stringify(d))
    expect(r.source).toBe('insomnia')
    expect(r.collections[0]).toMatchObject({ name: 'Ins API' })
    expect(r.collections[0].variables[0]).toMatchObject({ key: 'base', value: 'https://i.test' })
    expect(r.environments[0]).toMatchObject({ name: 'Prod' })
    const top = r.folders.find((f) => f.name === 'Top')!; const child = r.folders.find((f) => f.name === 'Child')!
    expect(child.parentId).toBe(top.id)
    const create = r.requests.find((x) => x.name === 'Create')!
    expect(create).toMatchObject({ url: '{{base}}/items?q=1', folderId: child.id, auth: { kind: 'bearer', token: '{{tok}}' }, body: { kind: 'json' } })
    expect(create.headers[0].value).toBe('{{n}}')
    expect(r.requests.find((x) => x.name === 'Form')!.body.fields[0]).toMatchObject({ key: 'k', value: 'v' })
  })
})

describe('Bruno import', () => {
  const req = `meta {
  name: Get user
  type: http
  seq: 2
}

get {
  url: {{baseUrl}}/users/:id?verbose=true
  body: none
  auth: bearer
}

params:query {
  verbose: true
  ~debug: 1
}

params:path {
  id: 42
}

headers {
  Accept: application/json
  ~X-Off: 1
}

auth:bearer {
  token: {{token}}
}

script:pre-request {
  console.log("pre")
}

tests {
  test("ok", function() {
    expect(res.status).to.equal(200);
  });
}

docs {
  Gets **one** user.
}
`
  const post = `meta {
  name: Create
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/users
  body: json
  auth: none
}

body:json {
  {
    "name": "Ann"
  }
}
`
  it('parses .bru blocks', () => {
    const b = parseBru(req)
    expect([...b.keys()]).toEqual(['meta', 'get', 'params:query', 'params:path', 'headers', 'auth:bearer', 'script:pre-request', 'tests', 'docs'])
    expect(b.get('tests')).toContain('expect(res.status)')
  })
  it('imports a collection folder with subfolders and environments', () => {
    const r = importBruno([
      { path: 'shop/bruno.json', text: '{"version":"1","name":"Shop","type":"collection"}' },
      { path: 'shop/users/get-user.bru', text: req },
      { path: 'shop/users/create.bru', text: post },
      { path: 'shop/environments/Local.bru', text: 'vars {\n  baseUrl: http://localhost:3000\n}\nvars:secret [\n  token\n]\n' },
    ])
    expect(r.collections[0].name).toBe('Shop')
    expect(r.folders.map((f) => f.name)).toEqual(['users'])
    const [get, create] = r.requests
    expect(get).toMatchObject({ name: 'Get user', method: 'GET', url: '{{baseUrl}}/users/:id?verbose=true', auth: { kind: 'bearer', token: '{{token}}' }, docs: 'Gets **one** user.', sort: 2 })
    expect(get.pathVars.map((p) => [p.key, p.value])).toEqual([['id', '42']])
    expect(get.params.map((p) => [p.key, p.enabled])).toEqual([['verbose', true], ['debug', false]])
    expect(get.headers.map((h) => [h.key, h.enabled])).toEqual([['Accept', true], ['X-Off', false]])
    expect(get.scripts.pre).toContain('console.log("pre")')
    expect(create.body).toMatchObject({ kind: 'json' }); expect(JSON.parse(create.body.text)).toEqual({ name: 'Ann' })
    expect(r.environments[0]).toMatchObject({ name: 'Local' })
    expect(r.warnings.join(' ')).toMatch(/Bruno's script API/)
  })
})
