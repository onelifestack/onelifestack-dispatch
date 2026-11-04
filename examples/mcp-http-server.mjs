#!/usr/bin/env node
// A tiny MCP server over Streamable HTTP, to try Dispatch's MCP request type. No dependencies.
//   node examples/mcp-http-server.mjs [--port 4320] [--token secret-token] [--sse]
// Endpoint: http://localhost:4320/mcp
//   --token  require "Authorization: Bearer <token>" (401 otherwise)
//   --sse    answer requests as an event stream instead of plain JSON (both are valid Streamable HTTP)
// Tools: add {a, b}, echo {text}, whoami (shows the Authorization header it got), fail (always reports an error)
// Resources: demo://greeting/ann, demo://config.json · Prompts: review {code}
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1] ?? true }
const port = Number(arg('port', 4320))
const token = arg('token', null)
const sse = process.argv.includes('--sse')
const sessions = new Set()

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
  if (url.pathname !== '/mcp') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('The MCP endpoint is /mcp') }
  if (token && req.headers.authorization !== `Bearer ${token}`) {
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
}).listen(port, () => console.log(`Demo MCP server on http://localhost:${port}/mcp${token ? ' (needs Authorization: Bearer <token>)' : ''}${sse ? ' (event-stream replies)' : ''}`))
