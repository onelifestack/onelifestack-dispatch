#!/usr/bin/env node
// A tiny API to try Dispatch against: node examples/demo-server.mjs [port]  (default 4318). No dependencies.
// POST /login {user}  -> sets a session cookie, returns a token
// GET  /orders        -> needs the cookie or "Authorization: Bearer <token>"
// POST /orders {item, qty} -> 201 with the new order
// GET  /orders/:id    -> one order, 404 if unknown
// GET  /digest        -> HTTP Digest auth (user "ann", password "secret")
// GET  /flaky         -> slow sometimes, fails about 1 in 20
// GET  /events        -> server-sent events: a tick every second, 5 in all
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const port = Number(process.argv[2] ?? 4318)
const sessions = new Map()
const orders = [{ id: 1, item: 'coffee', qty: 2 }]
const md5 = (s) => createHash('md5').update(s).digest('hex')
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', '*')
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Set-Cookie')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = (() => { try { return JSON.parse(raw || '{}') } catch { return null } })()
  const url = new URL(req.url, `http://localhost:${port}`)
  const cookie = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
  const who = sessions.get(cookie) ?? sessions.get(bearer)

  if (req.method === 'POST' && url.pathname === '/login') {
    if (!body?.user) return json(res, 400, { error: 'user is required' })
    const token = randomUUID()
    sessions.set(token, body.user)
    return json(res, 200, { token, user: body.user }, { 'set-cookie': `sid=${token}; Path=/; HttpOnly` })
  }
  if (url.pathname === '/orders' || url.pathname.startsWith('/orders/')) {
    if (!who) return json(res, 401, { error: 'log in first' })
    if (req.method === 'GET' && url.pathname === '/orders') return json(res, 200, { user: who, orders })
    if (req.method === 'POST' && url.pathname === '/orders') {
      if (!body?.item) return json(res, 422, { error: 'item is required' })
      const o = { id: orders.length + 1, item: body.item, qty: Number(body.qty ?? 1), by: who }
      orders.push(o)
      return json(res, 201, o)
    }
    const o = orders.find((x) => String(x.id) === url.pathname.split('/')[2])
    return o ? json(res, 200, o) : json(res, 404, { error: 'no such order' })
  }
  if (url.pathname === '/digest') {
    const auth = req.headers.authorization ?? ''
    const realm = 'demo', nonce = 'n0nce'
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]))
    const ok = auth.startsWith('Digest') && p.username === 'ann' &&
      p.response === md5(`${md5(`ann:${realm}:secret`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${md5(`${req.method}:${p.uri}`)}`)
    if (!ok) return json(res, 401, { error: 'digest required' }, { 'www-authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth", algorithm=MD5` })
    return json(res, 200, { hello: p.username })
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': hello\n\n')
    let n = 0
    const t = setInterval(() => {
      n++
      res.write(`event: tick\nid: ${n}\ndata: ${JSON.stringify({ n, at: new Date().toISOString(), who: who ?? null })}\n\n`)
      if (n === 5) { clearInterval(t); res.end() }
    }, 300)
    req.on('close', () => clearInterval(t))
    return
  }
  if (url.pathname === '/flaky') {
    const r = Math.random()
    setTimeout(() => (r < 0.05 ? json(res, 503, { error: 'busy' }) : json(res, 200, { ok: true })), 15 + Math.random() * 40 + (r > 0.95 ? 250 : 0))
    return
  }
  json(res, 404, { error: 'not found', try: ['/login', '/orders', '/orders/:id', '/digest', '/flaky', '/events'] })
}).listen(port, () => console.log(`Demo API on http://localhost:${port}`))
