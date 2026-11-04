#!/usr/bin/env node
// A tiny MCP server over Streamable HTTP, to try Dispatch's MCP request type. No dependencies.
//   node examples/mcp-http-server.mjs [--port 4320] [--token secret-token | --oauth [--token-ttl 3600]] [--sse]
// Endpoint: http://localhost:4320/mcp
//   --token  require "Authorization: Bearer <token>" (401 otherwise)
//   --oauth  require a sign-in, MCP style: 401 with resource_metadata, protected resource and authorization server
//            metadata, dynamic client registration, a consent page, PKCE (S256), resource indicators, refresh tokens.
//            --token-ttl sets how long access tokens last (seconds), to try refreshing.
//   --sse    answer requests as an event stream instead of plain JSON (both are valid Streamable HTTP)
// Tools: add {a, b}, echo {text}, whoami (shows the Authorization header it got), fail (always reports an error)
// Resources: demo://greeting/ann, demo://config.json · Prompts: review {code}
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1] ?? true }
const port = Number(arg('port', 4320))
const token = arg('token', null)
const sse = process.argv.includes('--sse')
const oauth = process.argv.includes('--oauth')
const ttl = Number(arg('token-ttl', 3600))
const sessions = new Set()
const origin = `http://localhost:${port}`
const resource = `${origin}/mcp`
const clients = new Map() // client_id -> { redirect_uris }
const codes = new Map()   // code -> { clientId, redirectUri, challenge, resource }
const tokens = new Map()  // access token -> expiry (ms)
const refreshes = new Set()
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const issue = () => { const access = randomUUID(), refresh = randomUUID(); tokens.set(access, Date.now() + ttl * 1000); refreshes.add(refresh); return { access_token: access, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh, scope: 'demo' } }

/** The sign-in side of --oauth. Returns true when it answered the request. */
async function oauthRoutes(req, res, url) {
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const form = async () => { let raw = ''; for await (const c of req) raw += c; return req.headers['content-type']?.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw)) }
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
    json(200, { resource, authorization_servers: [origin], scopes_supported: ['demo'], bearer_methods_supported: ['header'] }); return true
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['demo'] }); return true
  }
  if (url.pathname === '/register' && req.method === 'POST') {
    const b = await form()
    if (!Array.isArray(b.redirect_uris) || !b.redirect_uris.length) { json(400, { error: 'invalid_redirect_uri' }); return true }
    const id = `client-${randomUUID().slice(0, 8)}`
    clients.set(id, { redirect_uris: b.redirect_uris, name: b.client_name })
    console.log(`registered ${id} (${b.client_name}) → ${b.redirect_uris.join(', ')}`)
    json(201, { client_id: id, client_name: b.client_name, redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none' }); return true
  }
  if (url.pathname === '/authorize' || url.pathname === '/authorize/approve') {
    const q = url.searchParams
    const c = clients.get(q.get('client_id'))
    if (!c || !c.redirect_uris.includes(q.get('redirect_uri'))) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('Unknown client or redirect URI'); return true }
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('PKCE (S256) is required'); return true }
    if (q.get('resource') !== resource) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(`resource must be ${resource}`); return true }
    if (url.pathname === '/authorize') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><title>Sign in to the demo MCP server</title><body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1>Allow ${esc(c.name ?? 'this app')}?</h1><p>It wants to use the demo MCP server as <b>ann</b>.</p>
<p><a id="approve" href="/authorize/approve?${esc(q.toString())}" style="padding:.5rem 1rem;background:#5B2EE0;color:#fff;border-radius:8px;text-decoration:none">Allow</a>
&nbsp; <a href="${esc(q.get('redirect_uri'))}?error=access_denied&state=${esc(encodeURIComponent(q.get('state') ?? ''))}">Deny</a></p>`)
      return true
    }
    const code = randomUUID()
    codes.set(code, { clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), challenge: q.get('code_challenge'), resource: q.get('resource') })
    const back = new URL(q.get('redirect_uri')); back.searchParams.set('code', code); if (q.get('state')) back.searchParams.set('state', q.get('state'))
    res.writeHead(302, { location: back.toString() }); res.end(); return true
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const b = await form()
    if (b.resource !== resource) { json(400, { error: 'invalid_target', error_description: `resource must be ${resource}` }); return true }
    if (b.grant_type === 'authorization_code') {
      const c = codes.get(b.code); codes.delete(b.code)
      if (!c || c.clientId !== b.client_id || c.redirectUri !== b.redirect_uri) { json(400, { error: 'invalid_grant' }); return true }
      if (b64url(createHash('sha256').update(b.code_verifier ?? '').digest()) !== c.challenge) { json(400, { error: 'invalid_grant', error_description: 'PKCE check failed' }); return true }
      console.log(`signed in ${b.client_id}`); json(200, issue()); return true
    }
    if (b.grant_type === 'refresh_token') {
      if (!refreshes.delete(b.refresh_token)) { json(400, { error: 'invalid_grant' }); return true }
      console.log(`refreshed a token for ${b.client_id}`); json(200, issue()); return true
    }
    json(400, { error: 'unsupported_grant_type' }); return true
  }
  return false
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })
const TOOLS = [
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'echo', description: 'Send text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'whoami', description: 'Show the Authorization header this server received.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always reports a tool error (to check error display).', inputSchema: { type: 'object', properties: {} } },
]
const RESOURCES = [
  { uri: 'demo://greeting/ann', name: 'Greeting for Ann', mimeType: 'text/plain' },
  { uri: 'demo://config.json', name: 'Demo config', mimeType: 'application/json' },
]
const PROMPTS = [{ name: 'review', description: 'Ask for a code review.', arguments: [{ name: 'code', description: 'The code to review', required: true }] }]

function handle(msg, req) {
  const p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize': return { protocolVersion: p.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'dispatch-demo-mcp', version: '1.0.0' }, instructions: 'A demo server for testing Dispatch.' }
    case 'ping': return {}
    case 'tools/list': return { tools: TOOLS }
    case 'tools/call': {
      const a = p.arguments ?? {}
      if (p.name === 'add') return text(String(Number(a.a) + Number(a.b)))
      if (p.name === 'echo') return text(String(a.text ?? ''))
      if (p.name === 'whoami') return text(req.headers.authorization ? `Authorization: ${req.headers.authorization}` : 'No Authorization header')
      if (p.name === 'fail') return text('Something went wrong on purpose.', true)
      throw Object.assign(new Error(`Unknown tool ${p.name}`), { code: -32602 })
    }
    case 'resources/list': return { resources: RESOURCES }
    case 'resources/read': {
      if (p.uri === 'demo://greeting/ann') return { contents: [{ uri: p.uri, mimeType: 'text/plain', text: 'Hello, Ann!' }] }
      if (p.uri === 'demo://config.json') return { contents: [{ uri: p.uri, mimeType: 'application/json', text: JSON.stringify({ region: 'eu', retries: 3 }, null, 2) }] }
      throw Object.assign(new Error(`Unknown resource ${p.uri}`), { code: -32002 })
    }
    case 'prompts/list': return { prompts: PROMPTS }
    case 'prompts/get': return { messages: [{ role: 'user', content: { type: 'text', text: `Please review this code:\n\n${p.arguments?.code ?? ''}` } }] }
    default: throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 })
  }
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const url = new URL(req.url, `http://localhost:${port}`)
  if (oauth && await oauthRoutes(req, res, url)) return
  if (url.pathname !== '/mcp') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('The MCP endpoint is /mcp') }
  if (oauth) {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!t || !(tokens.get(t) > Date.now())) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer realm="dispatch-demo-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="demo"${t ? ', error="invalid_token"' : ''}` })
      return res.end(JSON.stringify({ error: t ? 'Token expired or unknown; refresh or sign in again' : 'Sign in first' }))
    }
  } else if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="dispatch-demo-mcp"' })
    return res.end(JSON.stringify({ error: 'Send Authorization: Bearer <token>' }))
  }
  const sid = req.headers['mcp-session-id']
  if (req.method === 'DELETE') { sessions.delete(sid); res.writeHead(204); return res.end() }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end() }
  let raw = ''
  for await (const c of req) raw += c
  let msg
  try { msg = JSON.parse(raw) } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })) }
  const headers = {}
  if (msg.method === 'initialize') { const id = randomUUID(); sessions.add(id); headers['mcp-session-id'] = id }
  else if (!sid || !sessions.has(sid)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Unknown or missing session; initialize first' } })) }
  console.log(`${new Date().toLocaleTimeString()} ${msg.method}${msg.params?.name ? ` ${msg.params.name}` : ''}`)
  if (msg.id === undefined) { res.writeHead(202, headers); return res.end() } // a notification
  let reply
  try { reply = { jsonrpc: '2.0', id: msg.id, result: handle(msg, req) } } catch (e) { reply = { jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } } }
  if (sse) {
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
  } else {
    res.writeHead(200, { ...headers, 'content-type': 'application/json' })
    res.end(JSON.stringify(reply))
  }
}).listen(port, () => console.log(`Demo MCP server on http://localhost:${port}/mcp${oauth ? ` (needs a sign-in; tokens last ${ttl} s)` : token ? ' (needs Authorization: Bearer <token>)' : ''}${sse ? ' (event-stream replies)' : ''}`))
