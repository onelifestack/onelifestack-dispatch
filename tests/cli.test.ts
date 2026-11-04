// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

// Builds the real bundle (catches bundling breakage, like a CommonJS dependency) and runs it against a local server.
const run = promisify(execFile)
const dir = mkdtempSync(join(tmpdir(), 'dispatch-cli-'))
const cli = join(dir, 'dispatch-run.mjs')
let server: Server
let port = 0

beforeAll(async () => {
  await build({ entryPoints: ['src/cli/main.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: cli, logLevel: 'silent',
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" } })
  server = createServer((req, res) => {
    res.writeHead(req.url === '/fail' ? 500 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, who: req.headers['x-who'] ?? null }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r() }))
  const col = {
    info: { name: 'CLI', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'base', value: `http://127.0.0.1:${port}` }],
    item: [
      { name: 'ok', request: { method: 'GET', url: '{{base}}/ok', header: [{ key: 'X-Who', value: '{{who}}' }] },
        event: [{ listen: 'test', script: { exec: [`pm.test('who', () => pm.expect(pm.response.json().who).to.equal(pm.variables.get('who')))`] } }] },
      { name: 'fail', request: { method: 'GET', url: '{{base}}/fail' }, event: [{ listen: 'test', script: { exec: [`pm.test('2xx', () => pm.response.to.be.ok)`] } }] },
    ],
  }
  writeFileSync(join(dir, 'col.json'), JSON.stringify(col))
  writeFileSync(join(dir, 'data.csv'), 'who\nann\nbo\n')
}, 60_000)
afterAll(() => server?.close())

const exec = async (args: string[]) => {
  try { const r = await run(process.execPath, [cli, ...args], { env: { ...process.env, NO_COLOR: '1' } }); return { code: 0, out: r.stdout + r.stderr } }
  catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr } }
}

describe('dispatch-run', () => {
  it('runs a flow from an export, following the failed branch', async () => {
    const { exportWorkspace } = await import('../src/core/backup')
    const { newFlow, newNode } = await import('../src/core/flows')
    const { newCollection, newRequest } = await import('../src/core/types')
    const c = newCollection('Flowy')
    const ok = newRequest({ name: 'ok', url: `http://127.0.0.1:${port}/ok`, collectionId: c.id })
    const bad = newRequest({ name: 'fail', url: `http://127.0.0.1:${port}/fail`, collectionId: c.id })
    const f = newFlow('Smoke')
    const a = { ...newNode('request', 0, 0), label: 'ok', config: { requestId: ok.id } }
    const b = { ...newNode('request', 0, 0), label: 'fail', config: { requestId: bad.id } }
    const end = { ...newNode('end', 0, 0), label: 'Recovered', config: { outcome: 'pass' } }
    f.nodes.push(a, b, end)
    f.edges.push({ id: 'e1', from: f.nodes[0].id, port: 'next', to: a.id }, { id: 'e2', from: a.id, port: 'ok', to: b.id }, { id: 'e3', from: b.id, port: 'failed', to: end.id })
    writeFileSync(join(dir, 'flow.json'), exportWorkspace({ collections: [c], folders: [], requests: [ok, bad], environments: [], flows: [f] }))
    const r = await exec(['flow', join(dir, 'flow.json'), '--flow', 'Smoke', '--json', join(dir, 'flow-report.json')])
    expect(r.out).toContain('Flow: Smoke')
    expect(r.out).toMatch(/✓ ok 200 → ok/)
    expect(r.out).toMatch(/✗ fail 500 → failed/)
    expect(r.out).toContain('Passed')
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'flow-report.json'), 'utf8')).steps).toHaveLength(4)
    expect((await exec(['flow', join(dir, 'flow.json'), '--flow', 'Nope'])).code).toBe(2)
  })

  it('runs a collection folder', async () => {
    const { mkdirSync } = await import('node:fs')
    const d = join(dir, 'folder-col'); mkdirSync(join(d, 'sub'), { recursive: true })
    writeFileSync(join(d, 'dispatch.collection.yaml'), `id: c1\nname: Folder col\nvariables:\n  - key: base\n    value: http://127.0.0.1:${port}\n`)
    writeFileSync(join(d, 'sub', '_folder.yaml'), 'id: f1\nname: Sub\n')
    writeFileSync(join(d, 'sub', 'ok.req.yaml'), `id: r1\nname: ok\nmethod: GET\nurl: "{{base}}/ok"\nscripts:\n  post: pm.test('200', () => pm.response.to.have.status(200))\n`)
    const r = await exec([d])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/✓ GET\s+ok Folder col \/ Sub/)
    expect(r.out).toContain('tests 1 passed')
  })
  it('serves the collection over MCP (stdio)', async () => {
    const { spawn } = await import('node:child_process')
    const { createInterface } = await import('node:readline')
    const { LineWire, McpClient } = await import('../src/core/mcp')
    const p = spawn(process.execPath, [cli, 'mcp', join(dir, 'col.json'), '--env-var', 'who=bot', '--allow-methods', 'GET'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const wire = new LineWire(async (line) => { p.stdin.write(`${line}\n`) }, async () => { p.stdin.end() })
    createInterface({ input: p.stdout }).on('line', (l) => wire.onLine(l))
    const c = new McpClient(wire)
    await c.initialize()
    expect(c.serverInfo.name).toBe('dispatch')
    expect((await c.listTools()).map((t) => t.name)).toEqual(['list_requests', 'send_request', 'run_collection'])
    expect((await c.callTool('list_requests', {})).content[0].text).toMatch(/GET\s+ok\s+\{\{base\}\}\/ok/)
    const sent = await c.callTool('send_request', { name: 'ok' })
    expect(sent.isError).toBeUndefined()
    expect(sent.content[0].text).toMatch(/→ 200 OK/)
    expect(sent.content[0].text).toContain('"who":"bot"')
    expect(sent.content[0].text).toContain('✓ who')
    const withVar = await c.callTool('send_request', { name: 'ok', variables: { who: 'override' } })
    expect(withVar.content[0].text).toContain('"who":"override"')
    const run = await c.callTool('run_collection', {})
    expect(run.isError).toBe(true) // the 'fail' request returns 500
    expect(run.content[0].text).toMatch(/2 requests .* 1 failed/)
    await c.close()
  })
  it('prints help', async () => {
    const r = await exec(['--help'])
    expect(r.code).toBe(0); expect(r.out).toContain('dispatch-run load')
  })
  it('runs a collection with a data file, writes JUnit and fails on a failing test', async () => {
    const r = await exec([join(dir, 'col.json'), '-d', join(dir, 'data.csv'), '--junit', join(dir, 'out.xml')])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/2 iterations, 4 requests.*tests 2 passed, 2 failed/s)
    expect(readFileSync(join(dir, 'out.xml'), 'utf8')).toContain('failures="2"')
  })
  it('passes when only the good folder runs, and rejects bad usage', async () => {
    const ok = await exec([join(dir, 'col.json'), '--env-var', 'who=zed', '-c', 'CLI'])
    expect(ok.out).toContain('✓ who')
    expect((await exec([join(dir, 'missing.json')])).code).toBe(2)
    expect((await exec(['load', join(dir, 'col.json')])).out).toContain('--i-have-permission')
  })
})
