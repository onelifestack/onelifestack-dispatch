import { describe, expect, it } from 'vitest'
import { checkFlow, newFlow, newNode, runFlow, type Flow, type FlowNode } from '../src/core/flows'
import { exportWorkspace, importFile } from '../src/core/backup'
import { InlineEngine, scriptPipeline } from '../src/core/scriptPipeline'
import { defaultSettings, kv, newCollection, newEnvironment, newRequest } from '../src/core/types'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

class Api implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  sent: PreparedRequest[] = []
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.sent.push(p)
    const u = new URL(p.url)
    const json = (status: number, v: unknown): HttpResponse => { const body = JSON.stringify(v); return { status, statusText: status < 400 ? 'OK' : 'Error', headers: [['content-type', 'application/json']], body, binary: false, size: body.length, timeMs: 3 } }
    if (u.pathname === '/login') return json(200, { token: 'T1', role: 'admin' })
    if (u.pathname === '/orders') return json(200, [{ id: 1, total: 5 }, { id: 2, total: 50 }, { id: 3, total: 7 }])
    if (u.pathname.startsWith('/orders/')) return p.headers.some(([k, v]) => k === 'Authorization' && v === 'Bearer T1') ? json(200, { id: u.pathname.split('/')[2] }) : json(401, {})
    return json(500, { error: 'boom' })
  }
}

const col = newCollection('Shop')
const reqs = {
  login: newRequest({ name: 'Login', method: 'POST', url: 'https://s.test/login', collectionId: col.id }),
  orders: newRequest({ name: 'Orders', url: 'https://s.test/orders', collectionId: col.id }),
  order: newRequest({ name: 'Order', url: 'https://s.test/orders/{{item.id}}', headers: [kv('Authorization', 'Bearer {{token}}')], collectionId: col.id }),
  broken: newRequest({ name: 'Broken', url: 'https://s.test/broken', collectionId: col.id }),
}
const world = (env = { ...newEnvironment('E'), variables: [] as ReturnType<typeof kv>[] }) => ({ collections: [col], folders: [], requests: Object.values(reqs), environment: env, globals: [], settings: defaultSettings })
const node = (type: Parameters<typeof newNode>[0], config: Record<string, string> = {}, label?: string): FlowNode => ({ ...newNode(type, 0, 0), ...(label ? { label } : {}), config: { ...newNode(type, 0, 0).config, ...config } })
const wire = (f: Flow, a: FlowNode, port: string, b: FlowNode) => f.edges.push({ id: `${a.id}-${port}-${b.id}`, from: a.id, port, to: b.id })
const go = (f: Flow, t = new Api(), w = world()) => runFlow(f, w, t, scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) }), new InlineEngine(), { sleep: async () => {} })

describe('flows', () => {
  it('logs in, keeps the token, branches on it, and loops over a response', async () => {
    const f = newFlow('Big orders'); const start = f.nodes[0]
    const login = node('request', { requestId: reqs.login.id }, 'Login')
    const token = node('set', { name: 'token', value: '$.token', scope: 'environment' }, 'Keep token')
    const isAdmin = node('if', { expression: 'response.json.role === "admin"' }, 'Admin?')
    const orders = node('request', { requestId: reqs.orders.id }, 'Orders')
    const each = node('forEach', { source: 'response', path: '$[?big]', as: 'item' }, 'Each order')
    each.config.path = '$[*]'
    const big = node('if', { expression: 'Number(vars["item.total"]) > 10' }, 'Big?')
    const one = node('request', { requestId: reqs.order.id }, 'Order')
    const done = node('end', { outcome: 'pass' }, 'Done')
    const denied = node('end', { outcome: 'fail' }, 'Not admin')
    f.nodes.push(login, token, isAdmin, orders, each, big, one, done, denied)
    wire(f, start, 'next', login); wire(f, login, 'ok', token); wire(f, token, 'next', isAdmin)
    wire(f, isAdmin, 'true', orders); wire(f, isAdmin, 'false', denied)
    wire(f, orders, 'ok', each); wire(f, each, 'each', big); wire(f, big, 'true', one); wire(f, each, 'done', done)
    const t = new Api()
    const r = await go(f, t)
    expect(r.error).toBeNull(); expect(r.ok).toBe(true)
    expect(t.sent.map((p) => new URL(p.url).pathname)).toEqual(['/login', '/orders', '/orders/2'])
    expect(r.environment?.find((v) => v.key === 'token')?.value).toBe('T1')
    expect(r.steps.filter((s) => s.label === 'Big?').map((s) => s.port)).toEqual(['false', 'true', 'false'])
    expect(r.steps.at(-1)).toMatchObject({ label: 'Done', status: 'ok' })
  })
  it('follows the failed wire, or stops the flow when there is none', async () => {
    const f = newFlow(); const start = f.nodes[0]
    const broken = node('request', { requestId: reqs.broken.id }, 'Broken')
    const recover = node('set', { name: 'note', value: 'recovered' }, 'Recover')
    f.nodes.push(broken, recover); wire(f, start, 'next', broken); wire(f, broken, 'failed', recover)
    const r1 = await go(f)
    expect(r1.ok).toBe(true); expect(r1.vars.note).toBe('recovered')
    f.edges = f.edges.filter((e) => e.port !== 'failed')
    const r2 = await go(f)
    expect(r2.ok).toBe(false); expect(r2.error).toMatch(/Broken failed: .*500/)
  })
  it('ends as failed on purpose, guards endless loops, and checks the flow first', async () => {
    const f = newFlow(); const start = f.nodes[0]
    const end = node('end', { outcome: 'fail' }, 'Nope'); f.nodes.push(end); wire(f, start, 'next', end)
    expect((await go(f)).error).toMatch(/Nope: ended as failed/)
    const loop = newFlow(); const s2 = loop.nodes[0]
    const a = node('set', { name: 'x', value: '1' }); loop.nodes.push(a); wire(loop, s2, 'next', a); wire(loop, a, 'next', a)
    expect((await go(loop)).error).toMatch(/Stopped after 10000 steps/)
    const bad = newFlow(); bad.nodes.push(node('request', { requestId: 'gone' }, 'Ghost'))
    expect(checkFlow(bad, [])).toEqual(['“Ghost” doesn’t point at a saved request.'])
    expect((await go(bad)).error).toMatch(/doesn’t point at a saved request/)
  })
  it('runs data loops and scripts that set variables', async () => {
    const f = newFlow(); const start = f.nodes[0]
    const each = node('forEach', { source: 'data', items: 'name,n\nann,1\nbo,2', as: 'row' }, 'Rows')
    const sc = node('script', { code: `pm.variables.set('seen', (pm.variables.get('seen') || '') + pm.variables.get('row.name'))` }, 'Collect')
    f.nodes.push(each, sc); wire(f, start, 'next', each); wire(f, each, 'each', sc)
    const r = await go(f)
    expect(r.vars.seen).toBe('annbo')
  })

  it('keeps flows in exports, pointing at the imported copies of their requests', () => {
    const f = newFlow('Exported')
    const r = node('request', { requestId: reqs.login.id }, 'Login'); f.nodes.push(r); wire(f, f.nodes[0], 'next', r)
    const back = importFile(exportWorkspace({ collections: [col], folders: [], requests: Object.values(reqs), environments: [], flows: [f] }))
    expect(back.flows).toHaveLength(1)
    const newLogin = back.requests.find((x) => x.name === 'Login')!
    expect(newLogin.id).not.toBe(reqs.login.id)
    expect(back.flows![0].nodes.find((n) => n.type === 'request')!.config.requestId).toBe(newLogin.id)
    expect(checkFlow(back.flows![0], back.requests)).toEqual([])
  })

  it('runs a flow through the MCP server tool', async () => {
    const { handleMcp } = await import('../src/cli/mcpServer')
    const f = newFlow('Login check')
    const r = node('request', { requestId: reqs.login.id }, 'Login'); f.nodes.push(r); wire(f, f.nodes[0], 'next', r)
    const t = new Api()
    const o = { ws: { source: 'dispatch' as const, collections: [col], folders: [], requests: Object.values(reqs), environments: [], flows: [f], warnings: [] }, environment: null, globals: [], settings: defaultSettings,
      transport: t, pipeline: scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) }), allowMethods: [], version: 'test', engine: new InlineEngine() }
    const list = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, o)
    expect(list.result.tools.map((x: { name: string }) => x.name)).toContain('run_flow')
    const res = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_flow', arguments: { name: 'Login check' } } }, o)
    expect(res.result.content[0].text).toMatch(/^Passed/)
    expect(res.result.content[0].text).toContain('✓ Login 200 → ok')
    const blocked = await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_flow', arguments: { name: 'Login check' } } }, { ...o, allowMethods: ['GET'] })
    expect(blocked.result.isError).toBe(true)
  })
})
