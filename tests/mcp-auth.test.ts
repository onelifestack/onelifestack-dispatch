// @vitest-environment node
/** MCP sign-in: discovery variants (fake server) and the whole flow against examples/mcp-http-server.mjs --oauth. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { HttpWire, McpAuthError, McpClient } from '../src/core/mcp'
import { type McpSignIn, canonical, discover, expiring, findSignIn, parseWwwAuthenticate, refreshSignIn, signIn } from '../src/core/mcpAuth'
import { FetchTransport, type SendOptions, type Transport } from '../src/core/transport'
import type { HttpResponse, PreparedRequest } from '../src/core/types'

const opts: SendOptions = { timeoutMs: 5000, followRedirects: true, insecureTls: false }
const ok = (body: unknown, status = 200): HttpResponse => { const b = JSON.stringify(body); return { status, statusText: '', headers: [['content-type', 'application/json']], body: b, binary: false, size: b.length, timeMs: 1 } }
/** A transport that answers GETs from a map of URL → JSON (404 otherwise) and records what was asked. */
class Fake implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  asked: string[] = []
  constructor(private readonly docs: Record<string, unknown>) {}
  async send(p: PreparedRequest) { this.asked.push(`${p.method} ${p.url}`); return p.url in this.docs ? ok(this.docs[p.url]) : ok({}, 404) }
}

describe('MCP sign-in discovery', () => {
  it('reads WWW-Authenticate parameters', () => {
    expect(parseWwwAuthenticate('Bearer realm="OAuth", resource_metadata="https://a.test/.well-known/oauth-protected-resource/mcp", scope="read write"'))
      .toEqual({ realm: 'OAuth', resource_metadata: 'https://a.test/.well-known/oauth-protected-resource/mcp', scope: 'read write' })
    expect(parseWwwAuthenticate('Bearer error=invalid_token, error_description="No \\"token\\""')).toEqual({ error: 'invalid_token', error_description: 'No "token"' })
    expect(parseWwwAuthenticate(null)).toEqual({})
  })

  it('follows resource metadata to an authorization server with a path (like Stripe)', async () => {
    const t = new Fake({
      'https://mcp.s.test/.well-known/oauth-protected-resource': { resource: 'https://mcp.s.test', authorization_servers: ['https://access.s.test/mcp'], scopes_supported: ['x'] },
      'https://access.s.test/.well-known/oauth-authorization-server/mcp': { issuer: 'https://access.s.test/mcp', authorization_endpoint: 'https://access.s.test/mcp/authorize', token_endpoint: 'https://access.s.test/mcp/token', registration_endpoint: 'https://access.s.test/mcp/register', code_challenge_methods_supported: ['S256'] },
    })
    const d = await discover('https://mcp.s.test', 'Bearer resource_metadata="https://mcp.s.test/.well-known/oauth-protected-resource"', t, opts)
    expect(d).toMatchObject({ resource: 'https://mcp.s.test', scope: 'x', server: { issuer: 'https://access.s.test/mcp', tokenEndpoint: 'https://access.s.test/mcp/token', registrationEndpoint: 'https://access.s.test/mcp/register' } })
  })

  it('falls back to the server’s own origin when there is no resource metadata (like Atlassian)', async () => {
    const t = new Fake({ 'https://mcp.a.test/.well-known/oauth-authorization-server': { issuer: 'https://mcp.a.test', authorization_endpoint: 'https://mcp.a.test/v1/authorize', token_endpoint: 'https://mcp.a.test/v1/token', registration_endpoint: 'https://mcp.a.test/v1/register' } })
    const d = await discover('https://mcp.a.test/v1/mcp', 'Bearer realm="OAuth", error="invalid_token"', t, opts)
    expect(d.resource).toBe('https://mcp.a.test/v1/mcp')
    expect(d.server.authorizationEndpoint).toBe('https://mcp.a.test/v1/authorize')
    // it looked for path-specific resource metadata first
    expect(t.asked[0]).toBe('GET https://mcp.a.test/.well-known/oauth-protected-resource/v1/mcp')
  })

  it('asks for a client ID when the server offers no registration (like GitHub), and stops if the user cancels', async () => {
    const t = new Fake({
      'https://api.g.test/.well-known/oauth-protected-resource/mcp': { resource: 'https://api.g.test/mcp/', authorization_servers: ['https://g.test/login/oauth'] },
      'https://g.test/.well-known/oauth-authorization-server/login/oauth': { issuer: 'https://g.test/login/oauth', authorization_endpoint: 'https://g.test/login/oauth/authorize', token_endpoint: 'https://g.test/login/oauth/access_token' },
    })
    let asked: { issuer: string; redirectUri: string } | null = null
    const r = await signIn({ serverUrl: 'https://api.g.test/mcp/', envId: null, wwwAuthenticate: null, transport: t, opts, openAndWait: async () => 'unused', askClient: async (i) => { asked = i; return null } })
    expect(r).toBeNull()
    expect(asked).toEqual({ issuer: 'https://g.test/login/oauth', redirectUri: 'http://127.0.0.1:33418/callback' })
  })

  it('refuses a server without PKCE', async () => {
    const t = new Fake({ 'https://p.test/.well-known/oauth-authorization-server': { authorization_endpoint: 'https://p.test/a', token_endpoint: 'https://p.test/t', code_challenge_methods_supported: ['plain'] } })
    await expect(discover('https://p.test/mcp', null, t, opts)).rejects.toThrow(/PKCE/)
  })

  it('keys sign-ins by environment and server', () => {
    const s = { envId: 'prod', serverUrl: canonical('https://x.test/mcp/') } as McpSignIn
    expect(findSignIn([s], 'prod', 'https://x.test/mcp')).toBe(s)
    expect(findSignIn([s], 'staging', 'https://x.test/mcp')).toBeUndefined()
    expect(findSignIn([s], null, 'not a url')).toBeUndefined()
  })
})

describe('MCP sign-in against the example server', () => {
  let p: ChildProcess
  const port = 4364
  const url = `http://localhost:${port}/mcp`
  beforeAll(async () => {
    p = spawn(process.execPath, ['examples/mcp-http-server.mjs', '--port', String(port), '--oauth', '--token-ttl', '2'], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((r) => p.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('Demo MCP server on')) r() }))
  })
  afterAll(() => p?.kill())

  it('signs in (registration, consent, PKCE, resource), uses the token, and renews it when it runs out', async () => {
    const t = new FetchTransport()
    const base: PreparedRequest = { method: 'POST', url, headers: [], body: null, unresolved: [] }
    // Without a sign-in: a 401 that says where to sign in.
    const err = await new McpClient(new HttpWire(base, t, opts)).initialize().catch((e) => e)
    expect(err).toBeInstanceOf(McpAuthError)
    expect(parseWwwAuthenticate((err as McpAuthError).wwwAuthenticate).resource_metadata).toBe(`http://localhost:${port}/.well-known/oauth-protected-resource/mcp`)

    let consent = ''
    const s = await signIn({
      serverUrl: url, envId: 'dev', wwwAuthenticate: (err as McpAuthError).wwwAuthenticate, transport: t, opts, redirectUri: 'http://127.0.0.1:33419/callback',
      askClient: async () => { throw new Error('should register by itself') },
      // Plays the user: open the consent page, press Allow, and hand back where the browser lands.
      openAndWait: async (authUrl) => {
        consent = await (await fetch(authUrl)).text()
        const allow = await fetch(authUrl.replace('/authorize?', '/authorize/approve?'), { redirect: 'manual' })
        return allow.headers.get('location')
      },
    })
    expect(consent).toContain('Allow Dispatch?')
    expect(s).toMatchObject({ envId: 'dev', serverUrl: url, resource: url, registered: true, scope: 'demo' })
    expect(s!.accessToken).toBeTruthy(); expect(s!.refreshToken).toBeTruthy()

    let current = s!
    let renewed = 0
    const wire = new HttpWire(base, t, opts, {
      header: async () => `Bearer ${current.accessToken}`,
      renew: async () => { const n = await refreshSignIn(current, t, opts); if (!n) return false; current = n; renewed++; return true },
    })
    const c = new McpClient(wire)
    await c.initialize()
    expect((await c.callTool('add', { a: 1, b: 2 })).content[0].text).toBe('3')
    await new Promise((r) => setTimeout(r, 2200)) // the 2-second token runs out
    expect(expiring(current)).toBe(true)
    expect((await c.callTool('whoami', {})).content[0].text).toBe(`Authorization: Bearer ${current.accessToken}`)
    expect(renewed).toBe(1)

    // A second sign-in reuses the registered client instead of registering again.
    const again = await signIn({ serverUrl: url, envId: 'dev', wwwAuthenticate: null, transport: t, opts, redirectUri: 'http://127.0.0.1:33419/callback', previous: current,
      askClient: async () => null, openAndWait: async (u) => (await fetch(u.replace('/authorize?', '/authorize/approve?'), { redirect: 'manual' })).headers.get('location') })
    expect(again!.clientId).toBe(s!.clientId)
  }, 20_000)
})
