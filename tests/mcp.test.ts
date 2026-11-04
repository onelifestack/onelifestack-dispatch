import { describe, expect, it } from 'vitest'
import { HttpWire, LineWire, McpClient, argumentsTemplate, type RpcMessage } from '../src/core/mcp'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

/** A tiny MCP server: answers JSON-RPC messages. */
function serve(msg: RpcMessage): RpcMessage | null {
  if (msg.id === undefined) return null
  const ok = (result: unknown): RpcMessage => ({ jsonrpc: '2.0', id: msg.id, result })
  const p = msg.params as any
  switch (msg.method) {
    case 'initialize': return ok({ protocolVersion: p.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'test-server', version: '1.0' }, instructions: 'Be nice' })
    case 'tools/list': return p?.cursor ? ok({ tools: [{ name: 'add', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number', default: 2 } } } }] })
      : ok({ tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], nextCursor: 'p2' })
    case 'tools/call': return p.name === 'add' ? ok({ content: [{ type: 'text', text: String(p.arguments.a + p.arguments.b) }] })
      : p.name === 'echo' ? ok({ content: [{ type: 'text', text: p.arguments.text }] }) : { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool ${p.name}` } }
    case 'resources/list': return ok({ resources: [{ uri: 'mem://a', name: 'A' }] })
    default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }
  }
}

class HttpServer implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  seen: PreparedRequest[] = []
  constructor(private readonly sse = false) {}
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.seen.push(p)
    if (p.method === 'DELETE') return { status: 200, statusText: 'OK', headers: [], body: '', binary: false, size: 0, timeMs: 1 }
    const reply = serve(JSON.parse(p.body!))
    if (!reply) return { status: 202, statusText: 'Accepted', headers: [], body: '', binary: false, size: 0, timeMs: 1 }
    const headers: [string, string][] = [['content-type', this.sse ? 'text/event-stream' : 'application/json'], ['mcp-session-id', 'sess-1']]
    const body = this.sse ? `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"working"}}\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply)
    return { status: 200, statusText: 'OK', headers, body, binary: false, size: body.length, timeMs: 1 }
  }
}
const opts = { timeoutMs: 1000, followRedirects: true, insecureTls: false }
const base: PreparedRequest = { method: 'POST', url: 'https://mcp.test/mcp', headers: [['Authorization', 'Bearer t']], body: null, unresolved: [] }

describe('MCP client', () => {
  for (const sse of [false, true]) {
    it(`talks Streamable HTTP (${sse ? 'event-stream' : 'JSON'} answers)`, async () => {
      const t = new HttpServer(sse)
      const log: unknown[] = []
      const c = new McpClient(new HttpWire(base, t, opts), (e) => log.push(e))
      await c.initialize()
      expect(c.serverInfo).toEqual({ name: 'test-server', version: '1.0' })
      expect(c.instructions).toBe('Be nice')
      const tools = await c.listTools()
      expect(tools.map((x) => x.name)).toEqual(['echo', 'add'])  // two pages
      expect(await c.listPrompts()).toEqual([]) // no prompts capability → not asked
      expect((await c.callTool('add', { a: 40, b: 2 })).content[0].text).toBe('42')
      await expect(c.callTool('nope', {})).rejects.toThrow(/Unknown tool nope/)
      // session id + protocol version on later requests, auth header kept, initialized notification sent
      expect(t.seen[1].headers).toContainEqual(['Mcp-Session-Id', 'sess-1'])
      expect(t.seen[2].headers).toContainEqual(['MCP-Protocol-Version', '2025-06-18'])
      expect(t.seen[0].headers).toContainEqual(['Authorization', 'Bearer t'])
      expect(JSON.parse(t.seen[1].body!).method).toBe('notifications/initialized')
      await c.close()
      expect(t.seen.at(-1)!.method).toBe('DELETE')
      if (sse) expect(log.some((e: any) => e.message?.method === 'notifications/message')).toBe(true)
    })
  }
  it('talks stdio lines, ignoring log noise', async () => {
    let wire!: LineWire
    wire = new LineWire(async (line) => {
      setTimeout(() => { wire.onLine('server starting…'); const r = serve(JSON.parse(line)); if (r) wire.onLine(JSON.stringify(r)) }, 1)
    }, async () => {})
    const c = new McpClient(wire)
    await c.initialize()
    expect((await c.listResources())[0].uri).toBe('mem://a')
    expect((await c.callTool('echo', { text: 'hi' })).content[0].text).toBe('hi')
  })
  it('makes argument templates from schemas', () => {
    expect(JSON.parse(argumentsTemplate({ type: 'object', properties: { a: { type: 'number' }, b: { type: 'number', default: 2 }, mode: { enum: ['x', 'y'] }, on: { type: 'boolean' } } }))).toEqual({ a: 0, b: 2, mode: 'x', on: false })
  })
})
