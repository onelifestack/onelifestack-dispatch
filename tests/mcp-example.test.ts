// @vitest-environment node
/** Dispatch's MCP client against examples/mcp-http-server.mjs (the server the Windows test guide uses), over real HTTP. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { HttpWire, McpClient } from '../src/core/mcp'
import { FetchTransport } from '../src/core/transport'
import type { PreparedRequest } from '../src/core/types'

const procs: ChildProcess[] = []
const start = (args: string[]) => new Promise<void>((resolve, reject) => {
  const p = spawn(process.execPath, ['examples/mcp-http-server.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(p)
  p.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('Demo MCP server on')) resolve() })
  p.on('error', reject)
})
beforeAll(async () => { await Promise.all([start(['--port', '4361']), start(['--port', '4362', '--sse', '--token', 'tk'])]) })
afterAll(() => { for (const p of procs) p.kill() })

const opts = { timeoutMs: 5000, followRedirects: true, insecureTls: false }
const base = (port: number, headers: [string, string][] = []): PreparedRequest => ({ method: 'POST', url: `http://localhost:${port}/mcp`, headers, body: null, unresolved: [] })

describe('example MCP server over HTTP', () => {
  for (const [label, port, headers] of [['JSON answers', 4361, []], ['event-stream answers with a bearer token', 4362, [['Authorization', 'Bearer tk']]]] as const) {
    it(label, async () => {
      const c = new McpClient(new HttpWire(base(port, [...headers]), new FetchTransport(), opts))
      await c.initialize()
      expect(c.serverInfo.name).toBe('dispatch-demo-mcp')
      expect((await c.listTools()).map((t) => t.name)).toEqual(['add', 'echo', 'whoami', 'fail'])
      expect((await c.callTool('add', { a: 40, b: 2 })).content[0].text).toBe('42')
      expect((await c.callTool('whoami', {})).content[0].text).toBe(headers.length ? 'Authorization: Bearer tk' : 'No Authorization header')
      expect((await c.callTool('fail', {})).isError).toBe(true)
      expect((await c.listResources()).length).toBe(2)
      expect((await c.readResource('demo://greeting/ann')).contents[0].text).toBe('Hello, Ann!')
      expect((await c.getPrompt('review', { code: 'x = 1' })).messages[0].content.text).toContain('x = 1')
      await c.close()
    })
  }
  it('explains a missing token', async () => {
    const c = new McpClient(new HttpWire(base(4362), new FetchTransport(), opts))
    await expect(c.initialize()).rejects.toThrow(/401.*Bearer/)
  })
})
