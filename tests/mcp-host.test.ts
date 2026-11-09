import { describe, expect, it, vi } from 'vitest'
import { handleMcp } from '../src/core/mcpHandler'
import type { Transport } from '../src/core/transport'
import { defaultSettings, newCollection, newRequest } from '../src/core/types'

/** The desktop app's MCP endpoint serves every collection in the workspace and saves what a send changed. */
describe('MCP handler for the desktop app', () => {
  const a = newCollection('Auth')
  const b = newCollection('Shop')
  const login = newRequest({ name: 'Login', method: 'POST', url: 'https://api.test/login', collectionId: a.id })
  const loginB = newRequest({ name: 'Login', method: 'POST', url: 'https://shop.test/login', collectionId: b.id })
  const items = newRequest({ name: 'Items', method: 'GET', url: 'https://shop.test/items', collectionId: b.id })
  const sent: string[] = []
  const transport: Transport = {
    label: 'test', unrestricted: true,
    send: async (p) => { sent.push(`${p.method} ${p.url}`); return { status: 200, statusText: 'OK', headers: [], body: '{"ok":true}', binary: false, size: 11, timeMs: 1 } },
  }
  const base = (over = {}) => ({
    ws: { source: 'dispatch' as const, collections: [a, b], folders: [], requests: [login, loginB, items], environments: [], flows: [], warnings: [] },
    environment: null, globals: [], settings: defaultSettings, transport, pipeline: {}, allowMethods: [], version: 'test', allCollections: true, ...over,
  })
  const call = (name: string, args: object, o = base()) => handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, o)

  it('lists requests from every collection with the collection name first', async () => {
    const r = await call('list_requests', {})
    expect(r.result.content[0].text).toContain('POST   Auth/Login')
    expect(r.result.content[0].text).toContain('GET    Shop/Items')
  })

  it('asks for the full path when a name is in several collections', async () => {
    const r = await call('send_request', { name: 'Login' })
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain('Auth/Login, Shop/Login')
  })

  it('sends by path or unique name and calls afterSend so the app can save changes', async () => {
    const afterSend = vi.fn(async () => {})
    const r = await call('send_request', { name: 'Shop/Login' }, base({ hooks: { afterSend } }))
    expect(r.result.isError).toBeUndefined()
    expect(sent).toContain('POST https://shop.test/login')
    expect(afterSend).toHaveBeenCalledOnce()
    expect((afterSend.mock.calls[0] as any[])[1].collection.id).toBe(b.id)
    await call('send_request', { name: 'Items' })
    expect(sent).toContain('GET https://shop.test/items')
  })

  it('keeps the allowed-methods limit', async () => {
    const r = await call('send_request', { name: 'Auth/Login' }, base({ allowMethods: ['GET', 'HEAD'] }))
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain('aren’t allowed')
  })

  it('needs a collection or folder to run', async () => {
    expect((await call('run_collection', {})).result.isError).toBe(true)
    const r = await call('run_collection', { folder: 'Shop' }, base({ allowMethods: ['GET'] }))
    expect(r.result.content[0].text).toContain('POST Login')
  })

  it('serves only the first collection for the CLI, as before', async () => {
    const r = await call('list_requests', {}, base({ allCollections: false }))
    expect(r.result.content[0].text).toBe('POST   Login  https://api.test/login')
  })
})
