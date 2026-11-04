import { describe, expect, it } from 'vitest'
import { LANGUAGES, generateCode } from '../src/core/codegen'
import { fromCurl } from '../src/core/curl'
import type { PreparedRequest } from '../src/core/types'

const json: PreparedRequest = { method: 'POST', url: 'https://api.test/items?q=a b', headers: [['Content-Type', 'application/json'], ['X-Quote', `it's "quoted"`]], body: '{"name":"tea","n":2,"ok":true,"none":null}', unresolved: [] }
const form: PreparedRequest = { method: 'POST', url: 'https://api.test/upload', headers: [], body: null, unresolved: [], multipart: [{ name: 'title', value: 'Hi' }, { name: 'file', file: { name: 'photo.png', type: 'image/png', base64: '' } }] }
const get: PreparedRequest = { method: 'GET', url: 'https://api.test/', headers: [], body: null, unresolved: [] }

describe('code generation', () => {
  it('produces something for every language and request shape', () => {
    for (const l of LANGUAGES) for (const p of [json, form, get]) {
      const code = generateCode(l.id, p)
      expect(code.length, `${l.id}`).toBeGreaterThan(20)
      expect(code, `${l.id} url`).toContain('api.test')
    }
  })
  it('escapes quotes so the snippets stay valid', () => {
    expect(generateCode('js-fetch', json)).toContain(`"X-Quote": "it's \\"quoted\\""`)
    expect(generateCode('powershell', json)).toContain(`'X-Quote' = 'it''s "quoted"'`)
    expect(generateCode('php', json)).toContain(`'X-Quote: it\\'s "quoted"'`)
    // the generated JS parses
    const js = generateCode('js-fetch', json).replace('const res = await fetch', 'const f = (u, o) => o; const res = f').replace(/console\.log.*$/, '')
    expect(() => new Function(js)).not.toThrow()
  })
  it('turns JSON bodies into native literals', () => {
    expect(generateCode('python-requests', json)).toMatch(/"ok": True,\n\s+"none": None/)
    expect(generateCode('python-requests', json)).toContain('json=payload')
  })
  it('round-trips curl, including form-data', () => {
    const back = fromCurl(generateCode('curl', json)).request
    expect(back.method).toBe('POST'); expect(JSON.parse(back.body.text)).toEqual(JSON.parse(json.body!))
    const f = fromCurl(generateCode('curl', form)).request
    expect(f.body.fields.map((x) => [x.key, x.type])).toEqual([['title', 'text'], ['file', 'file']])
  })
  it('uses the multipart helpers of each language', () => {
    expect(generateCode('python-requests', form)).toContain('files = {"file": open("photo.png", "rb")}')
    expect(generateCode('go', form)).toContain('w.FormDataContentType()')
    expect(generateCode('csharp', form)).toContain('MultipartFormDataContent')
  })
})
