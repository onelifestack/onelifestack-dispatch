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
