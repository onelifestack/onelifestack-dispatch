import { beforeEach, describe, expect, it } from 'vitest'
import * as db from '../src/core/db'
import { isSealed, resetVaultForTests, seal, unseal, vaultKey } from '../src/core/vault'
import { authPipeline } from '../src/core/auth'
import { execute } from '../src/core/runtime'
import { emptyAuth, kv, newCollection, newEnvironment, newRequest } from '../src/core/types'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

/** Reads a record straight from IndexedDB, bypassing the vault. */
async function raw<T>(store: string, key: string): Promise<T> {
  const d = await db.open()
  return new Promise((res, rej) => { const r = d.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
}

beforeEach(async () => { await db.resetForTests() })

describe('vault', () => {
  it('seals and unseals, and a foreign key reads as empty', async () => {
    const mem = new Map<string, unknown>()
    const store = { get: async () => mem.get('k'), set: async (v: unknown) => { mem.set('k', v) } }
    const k = await vaultKey(store)
    const s = await seal(k, 'p@ss')
    expect(isSealed(s)).toBe(true); expect(s).not.toContain('p@ss')
    expect(await seal(k, s)).toBe(s) // never double-sealed
    expect(await unseal(k, s)).toBe('p@ss')
    expect(await unseal(k, 'plain')).toBe('plain')
    resetVaultForTests(); mem.clear()
    const other = await vaultKey(store)
    expect(await unseal(other, s)).toBe('')
  })
  it('stores secrets encrypted and reads them back', async () => {
    const env = { ...newEnvironment('E'), variables: [kv('token', 'shh', true, { secret: true }), kv('host', 'h')] }
    await db.putEnvironment(env)
    const stored = await raw<typeof env>('environments', env.id)
    expect(isSealed(stored.variables[0].value)).toBe(true)
    expect(stored.variables[1].value).toBe('h')
    expect((await db.listEnvironments())[0].variables[0].value).toBe('shh')

    const req = newRequest({ auth: { ...emptyAuth('basic'), username: 'ann', password: 'pw' }, headers: [kv('Authorization', 'Bearer t'), kv('Accept', 'json')] })
    await db.putRequest(req)
    const r = await raw<typeof req>('requests', req.id)
    expect(r.auth.username).toBe('ann'); expect(isSealed(r.auth.password)).toBe(true)
    expect(isSealed(r.headers[0].value)).toBe(true); expect(r.headers[1].value).toBe('json')
    expect((await db.listRequests())[0]).toMatchObject({ auth: { password: 'pw' }, headers: [{ value: 'Bearer t' }, { value: 'json' }] })

    await db.putGlobals([kv('g', 'secret-g', true, { secret: true })])
    expect(isSealed((await raw<{ value: string }[]>('meta', 'globals'))[0].value)).toBe(true)
    expect((await db.getGlobals())[0].value).toBe('secret-g')

    await db.addHistory({ id: 'h1', at: 1, request: req, sent: { method: 'GET', url: 'https://a', headers: [['Cookie', 'sid=1'], ['Accept', '*/*']], body: null, unresolved: [] }, response: null, error: null })
    const h = await raw<{ sent: { headers: [string, string][] } }>('history', 'h1')
    expect(isSealed(h.sent.headers[0][1])).toBe(true); expect(h.sent.headers[1][1]).toBe('*/*')
    expect((await db.listHistory())[0].sent.headers[0][1]).toBe('sid=1')

    await db.putOpenTabs([req], 0)
    expect((await db.getOpenTabs())!.tabs[0].auth.password).toBe('pw')
  })
})

class Fake implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  sent: PreparedRequest[] = []
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.sent.push(p)
    const body = p.url.endsWith('/token') ? '{"access_token":"NEW","refresh_token":"R2","expires_in":60}' : '{}'
    return { status: 200, statusText: 'OK', headers: [], body, binary: false, size: body.length, timeMs: 1 }
  }
}

describe('OAuth refresh is saved back', () => {
  it('reports the update for the collection that owns the auth and reuses it in the run', async () => {
    const t = new Fake()
    const col = { ...newCollection('C'), auth: { ...emptyAuth('oauth2'), tokenUrl: 'https://auth.test/token', clientId: 'c', accessToken: 'OLD', refreshToken: 'R1', expiresAt: Date.now() - 1000 } }
    const ctx = { collection: col, folders: [], environment: null, globals: [] }
    const req = newRequest({ url: 'https://api.test/x', collectionId: col.id })
    const x = await execute(req, ctx, t, { timeoutMs: 1000, followRedirects: true, insecureTls: false }, authPipeline({}, t))
    expect(x.sent.headers).toContainEqual(['Authorization', 'Bearer NEW'])
    expect(x.authUpdate).toMatchObject({ owner: 'collection', id: col.id, patch: { accessToken: 'NEW', refreshToken: 'R2' } })
    expect(ctx.collection.auth.accessToken).toBe('NEW')
    // a second request in the same run doesn't refresh again
    await execute(req, ctx, t, { timeoutMs: 1000, followRedirects: true, insecureTls: false }, authPipeline({}, t))
    expect(t.sent.filter((p) => p.url.endsWith('/token'))).toHaveLength(1)
  })
})
