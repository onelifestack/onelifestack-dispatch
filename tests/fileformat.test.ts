import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { collectionToFiles, filesToCollection, literalSecrets, slug } from '../src/core/fileFormat'
import { emptyAuth, emptyBody, kv, newCollection, newFolder, newRequest, uid } from '../src/core/types'

const col = { ...newCollection('Shop API'), docs: 'The shop', auth: { ...emptyAuth('bearer'), token: '{{token}}' }, variables: [kv('base', 'https://s.test'), kv('token', 'real-secret', true, { secret: true })] }
const top = { ...newFolder(col.id, 'Orders'), sort: 2, auth: { ...emptyAuth('basic'), username: 'ann', password: 'pw-literal' } }
const sub = { ...newFolder(col.id, 'Admin & Ops', top.id), sort: 1 }
const login = newRequest({ name: 'Log in', method: 'POST', url: '{{base}}/login', collectionId: col.id, sort: 1, body: { ...emptyBody('json'), text: '{"u":"{{user}}"}' }, scripts: { pre: '', post: 'pm.test("ok", () => {})' } })
const list = newRequest({ name: 'List', url: '{{base}}/orders?page=1', params: [kv('page', '1'), kv('debug', '1', false)], headers: [kv('Accept', 'json')], collectionId: col.id, folderId: top.id, sort: 1, examples: [{ id: uid(), name: 'ok', status: 200, headers: [], body: '[]' }] })
const dupe = newRequest({ name: 'List', url: '{{base}}/orders/v2', collectionId: col.id, folderId: top.id, sort: 2 })
const purge = newRequest({ name: 'Purge', method: 'DELETE', url: '{{base}}/purge', collectionId: col.id, folderId: sub.id, auth: { ...emptyAuth('apikey'), key: 'X-K', value: '{{adminKey}}' } })
const y = (v: unknown) => stringify(v, { lineWidth: 0 })

describe('collections as files', () => {
  const files = collectionToFiles(col, [top, sub], [login, list, dupe, purge], y)
  it('lays out one readable file per request and folder', () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      'dispatch.collection.yaml', 'log-in.req.yaml', 'orders/_folder.yaml', 'orders/admin-ops/_folder.yaml', 'orders/admin-ops/purge.req.yaml', 'orders/list-2.req.yaml', 'orders/list.req.yaml'])
    const req = files.find((f) => f.path === 'log-in.req.yaml')!.text
    expect(req).toContain('method: POST'); expect(req).toContain('url: "{{base}}/login"')
    expect(slug('Café Ünïcode!!')).toBe('cafe-unicode')
  })
  it('never writes literal secrets but keeps {{references}}', () => {
    const all = files.map((f) => f.text).join('\n')
    expect(all).not.toContain('real-secret'); expect(all).not.toContain('pw-literal')
    expect(all).toContain('{{token}}'); expect(all).toContain('{{adminKey}}')
    expect(literalSecrets(col, [top, sub], [login, list, dupe, purge])).toEqual(['Orders'])
  })
  it('reads back the same collection, merging local secrets', () => {
    const back = filesToCollection(files, parse, { collection: col, folders: [top, sub], requests: [login, list, dupe, purge] })
    const c = back.collections[0]
    expect(c).toMatchObject({ id: col.id, name: 'Shop API', docs: 'The shop', auth: { kind: 'bearer', token: '{{token}}' } })
    expect(c.variables.find((v) => v.key === 'token')).toMatchObject({ value: 'real-secret', secret: true })
    const t2 = back.folders.find((f) => f.id === top.id)!; const s2 = back.folders.find((f) => f.id === sub.id)!
    expect(s2.parentId).toBe(t2.id)
    expect(t2.auth).toMatchObject({ kind: 'basic', username: 'ann', password: 'pw-literal' }) // merged from this device
    const l2 = back.requests.find((r) => r.id === list.id)!
    expect(l2).toMatchObject({ name: 'List', url: '{{base}}/orders?page=1', folderId: top.id, examples: [{ name: 'ok', status: 200 }] })
    expect(l2.params.map((p) => [p.key, p.enabled])).toEqual([['page', true], ['debug', false]])
    expect(back.requests.find((r) => r.id === login.id)!.body).toMatchObject({ kind: 'json', text: '{"u":"{{user}}"}' })
    expect(back.requests.find((r) => r.id === purge.id)!.folderId).toBe(sub.id)
    // without local data (a fresh clone): secrets are simply empty
    const fresh = filesToCollection(files, parse)
    expect(fresh.collections[0].variables.find((v) => v.key === 'token')!.value).toBe('')
    expect(fresh.folders.find((f) => f.id === top.id)!.auth.password).toBe('')
  })
  it('refuses folders that aren’t collections', () => {
    expect(() => filesToCollection([{ path: 'x.req.yaml', text: 'name: x' }], parse)).toThrow(/dispatch\.collection\.yaml/)
  })
})
