// @vitest-environment node
/** Real-browser test: needs Chrome/Chromium (DISPATCH_BROWSER, a system install, or Playwright's Chromium). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { runBrowserSteps, newStep, defaultBrowserConfig, storeExtracted } from '../src/core/browser'
import { findBrowser, nodeLauncher } from '../src/node/browserLauncher'
import { kv, newCollection, newEnvironment, newRequest, defaultSettings } from '../src/core/types'
import { runCollection } from '../src/core/runner'
import { browserHook } from '../src/core/browserPipeline'
import { CookieJar } from '../src/core/cookies'
import { CookieTransport, FetchTransport } from '../src/core/transport'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const playwright = `${homedir()}/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`
const browser = findBrowser() ?? (existsSync(playwright) ? playwright : null)
// Playwright's own Chromium isn't covered by Ubuntu's AppArmor profiles, so it can't sandbox; installed Chrome/Edge can.
if (browser === playwright) process.env.DISPATCH_BROWSER_ARGS = '--no-sandbox'
let server: Server
let base = ''

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' })
      // A React-ish form: submits with fetch, not a native post.
      res.end(page(`<form id="f"><input name="username"><input type="password" name="pw"><button type="submit">Sign in</button></form>
        <script>document.getElementById('f').addEventListener('submit', async (e) => { e.preventDefault();
          const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ u: e.target.username.value, p: e.target.pw.value }) });
          if (r.ok) location.href = '/app'; else document.body.insertAdjacentHTML('beforeend', '<p id="err">Wrong</p>') })</script>`))
    } else if (url.pathname === '/api/login') {
      let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
        const b = JSON.parse(raw)
        if (b.u === 'ann' && b.p === 's3cret') { res.writeHead(200, { 'set-cookie': 'sid=abc123; Path=/; HttpOnly' }); res.end('{}') } else { res.writeHead(401); res.end() }
      })
    } else if (url.pathname === '/api/me') {
      const ok = req.headers.authorization === 'Bearer tok-xyz' && /sid=abc123/.test(req.headers.cookie ?? '')
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: ok ? 'ann' : null }))
    } else if (url.pathname === '/app') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(`<h1 id="hello">Hello Ann</h1><script>localStorage.setItem('auth', JSON.stringify({ access_token: 'tok-xyz', expires_in: 3600 }))</script>`))
    } else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => server?.close())

describe.skipIf(!browser)('browser login (real Chromium)', () => {
  const vars = new Map([['base', ''], ['user', 'ann'], ['pass', 's3cret']])
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (w, n) => (n === 'base' ? base : vars.get(n) ?? w))
  it('logs in through a form and extracts an HttpOnly cookie, a storage token and text', async () => {
    const r = await runBrowserSteps({
      ...defaultBrowserConfig(), browserPath: browser!, timeoutMs: 10_000,
      steps: [
        newStep('goto', '{{base}}/login'),
        newStep('fill', 'input[name=username]', '{{user}}'),
        newStep('fill', 'input[type=password]', '{{pass}}'),
        newStep('click', 'button[type=submit]'),
        newStep('waitUrl', '/app'),
        newStep('extractCookie', 'sid', '', 'sessionId'),
        newStep('extractStorage', 'auth', '', 'token', 'local'),
        newStep('extractText', '#hello', '', 'greeting'),
      ],
    }, fill, nodeLauncher)
    expect(r.error).toBeNull()
    expect(r.extracted).toEqual({ sessionId: 'abc123', token: 'tok-xyz', greeting: 'Hello Ann' })
    expect(r.cookies).toContainEqual(expect.objectContaining({ name: 'sid', value: 'abc123', httpOnly: true, domain: '127.0.0.1' }))
    expect(r.steps.every((s) => s.ok)).toBe(true)
    expect(r.steps[2].note).toContain('••••') // passwords never shown
    expect(storeExtracted([kv('token', 'old')], r.extracted).map((v) => [v.key, v.value, !!v.secret])).toEqual([['token', 'tok-xyz', false], ['sessionId', 'abc123', true], ['greeting', 'Hello Ann', true]])
  }, 30_000)
  it('reports which step failed', async () => {
    vars.set('pass', 'wrong')
    const r = await runBrowserSteps({ ...defaultBrowserConfig(), browserPath: browser!, timeoutMs: 2000,
      steps: [newStep('goto', '{{base}}/login'), newStep('fill', 'input[name=username]', '{{user}}'), newStep('fill', 'input[type=password]', '{{pass}}'), newStep('click', 'button'), newStep('waitUrl', '/app')] }, fill, nodeLauncher)
    expect(r.error).toMatch(/Step 5 \(waitUrl\) failed: Timed out waiting for the address to contain “\/app”/)
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, true, false])
  }, 30_000)

  const loginRequest = (col: string) => newRequest({ name: 'Log in', protocol: 'browser', collectionId: col, sort: 1, browser: { ...defaultBrowserConfig(), browserPath: browser!, timeoutMs: 10_000, steps: [
    newStep('goto', '{{base}}/login'), newStep('fill', 'input[name=username]', '{{user}}'), newStep('fill', 'input[type=password]', '{{pass}}'),
    newStep('click', 'button[type=submit]'), newStep('waitUrl', '/app'), newStep('extractStorage', 'auth', '', 'token', 'local'),
  ] } })
  const meRequest = (col: string) => newRequest({ name: 'Me', url: '{{base}}/api/me', headers: [kv('Authorization', 'Bearer {{token}}')], collectionId: col, sort: 2,
    scripts: { pre: '', post: `pm.test('me', () => pm.expect(pm.response.json().user).to.equal('ann'))` } })

  it('runs a browser login then an API call with its token and cookie, in a collection run', async () => {
    const col = newCollection('Web')
    const env = { ...newEnvironment('E'), variables: [kv('base', base), kv('user', 'ann'), kv('pass', 's3cret')] }
    const jar = new CookieJar()
    const t = new CookieTransport(new FetchTransport(), jar)
    const { scriptPipeline, InlineEngine } = await import('../src/core/scriptPipeline')
    const pipeline = { ...scriptPipeline({ engine: new InlineEngine(), transport: t, sendOptions: () => ({ ...defaultSettings }) }), browser: browserHook(nodeLauncher, () => jar) }
    const s = await runCollection({ items: [{ request: loginRequest(col.id), path: 'Web' }, { request: meRequest(col.id), path: 'Web' }], iterations: 1, data: null, delayMs: 0, stopOnFailure: true,
      environment: env, collections: [col], folders: [], globals: [], settings: defaultSettings }, t, pipeline)
    expect(s.results.map((r) => [r.name, r.status])).toEqual([['Log in', 200], ['Me', 200]])
    expect(s.testsPassed).toBe(1)
    expect(s.finalEnvironment?.find((v) => v.key === 'token')).toMatchObject({ value: 'tok-xyz', secret: true })
  }, 40_000)

  it('does the same from dispatch-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-browser-cli-'))
    const cli = join(dir, 'cli.mjs')
    await build({ entryPoints: ['src/cli/main.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: cli, logLevel: 'silent',
      banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" } })
    const col = newCollection('Web')
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ format: 'ogcrafts-dispatch', version: 2, collections: [col], folders: [], requests: [loginRequest(col.id), meRequest(col.id)], environments: [] }))
    const r = await promisify(execFile)(process.execPath, [cli, join(dir, 'web.json'), '--env-var', `base=${base}`, '--env-var', 'user=ann', '--env-var', 'pass=s3cret'],
      { env: { ...process.env, NO_COLOR: '1' } }).catch((e) => e)
    expect(r.stdout).toMatch(/✓ WEB\s+Log in.*200/)
    expect(r.stdout).toMatch(/✓ me/)
    expect(r.code ?? 0).toBe(0)
  }, 60_000)

  it('only accepts DevTools connections from the origin it was told to allow (the desktop webview sends one)', async () => {
    const { request } = await import('node:http')
    // Status of a WebSocket handshake to the DevTools endpoint, sent with an Origin header like the webview's.
    const handshake = (wsUrl: string, origin: string) => new Promise<number>((resolve, reject) => {
      const u = new URL(wsUrl.replace(/^ws/, 'http'))
      const r = request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin,
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
      r.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101) })
      r.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      r.on('error', reject); r.end()
    })
    const before = process.env.DISPATCH_BROWSER_ARGS ?? ''
    // Without the flag (what 0.4.1 did): the webview's origin is refused — issue #9.
    let s = await nodeLauncher.launch({ path: browser!, show: false })
    try { expect(await handshake(s.wsUrl, 'http://tauri.localhost')).not.toBe(101) } finally { await s.close() }
    // With browserArgs(…, origin) as the desktop launcher passes it: that origin connects, others still don't.
    const { browserArgs } = await import('../src/core/browser')
    process.env.DISPATCH_BROWSER_ARGS = `${before} ${browserArgs('x', false, 'http://tauri.localhost').find((a) => a.startsWith('--remote-allow-origins'))}`
    try {
      s = await nodeLauncher.launch({ path: browser!, show: false })
      try {
        expect(await handshake(s.wsUrl, 'http://tauri.localhost')).toBe(101)
        expect(await handshake(s.wsUrl, 'http://localhost:3000')).not.toBe(101)
      } finally { await s.close() }
    } finally { process.env.DISPATCH_BROWSER_ARGS = before }
    expect(browserArgs('x', false).some((a) => a.startsWith('--remote-allow-origins'))).toBe(false)
  }, 60_000)
})
