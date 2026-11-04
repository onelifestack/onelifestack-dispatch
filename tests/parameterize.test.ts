import { describe, expect, it } from 'vitest'
import { applySuggestions, suggest } from '../src/core/parameterize'
import { emptyAuth, emptyBody, kv, newRequest } from '../src/core/types'
import { prepare } from '../src/core/prepare'

const raw = () => newRequest({
  method: 'PUT', url: 'https://api.shop.test:8443/v2/users/12345/orders/3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f?expand=items',
  headers: [kv('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'), kv('X-API-Key', 'k-998877'), kv('Accept', 'application/json')],
  body: { ...emptyBody('json'), text: '{"tenant": "acme-prod", "note": "hi"}' },
})

describe('parameterize', () => {
  it('suggests base URL, credentials, path IDs and existing variables', () => {
    const s = suggest(raw(), [{ key: 'tenant', value: 'acme-prod', from: 'Prod' }])
    expect(s.map((x) => [x.kind, x.varName, x.create, x.secret])).toEqual([
      ['existing', 'tenant', false, false],
      ['baseUrl', 'baseUrl', true, false],
      ['bearer', 'token', true, true],
      ['apiKeyHeader', 'apiKey', true, true],
      ['pathId', 'userId', false, false],
      ['pathId', 'orderId', false, false],
    ])
    expect(s[1].value).toBe('https://api.shop.test:8443')
  })
  it('uses an existing base URL variable instead of making a new one', () => {
    const s = suggest(raw(), [{ key: 'api', value: 'https://api.shop.test:8443/v2', from: 'Prod' }])
    expect(s.find((x) => x.kind === 'existing')?.varName).toBe('api')
    expect(s.some((x) => x.kind === 'baseUrl')).toBe(false)
  })
  it('applies everything and still sends exactly the same request', () => {
    const req = raw()
    const known = [{ key: 'tenant', value: 'acme-prod', from: 'Prod' }]
    const s = suggest(req, known)
    const { request: r, create } = applySuggestions(req, s)
    expect(r.url).toBe('{{baseUrl}}/v2/users/:userId/orders/:orderId?expand=items')
    expect(r.auth).toMatchObject({ kind: 'bearer', token: '{{token}}' })
    expect(r.headers.map((h) => [h.key, h.value])).toEqual([['X-API-Key', '{{apiKey}}'], ['Accept', 'application/json']])
    expect(r.body.text).toBe('{"tenant": "{{tenant}}", "note": "hi"}')
    expect(create.map((v) => [v.key, !!v.secret]).sort()).toEqual([['apiKey', true], ['baseUrl', false], ['token', true]])
    // Same wire request as before, once the variables exist.
    const vars = [...create, kv('tenant', 'acme-prod')]
    const before = prepare(req), after = prepare(r, { globals: vars })
    expect(after.url).toBe(before.url)
    expect(after.body).toBe(before.body)
    expect(new Set(after.headers.map(([k, v]) => `${k.toLowerCase()}:${v}`))).toEqual(new Set(before.headers.map(([k, v]) => `${k.toLowerCase()}:${v}`)))
  })
  it('handles basic auth passwords and avoids name clashes', () => {
    const req = newRequest({ url: 'http://h.test/x', auth: { ...emptyAuth('basic'), username: 'ann', password: 'pw123' } })
    const s = suggest(req, [{ key: 'baseUrl', value: 'https://other.test', from: 'Dev' }])
    expect(s.find((x) => x.kind === 'baseUrl')?.varName).toBe('baseUrl2')
    const { request } = applySuggestions(req, s)
    expect(request.auth.password).toBe('{{password}}')
  })
})
