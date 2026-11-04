import { useEffect, useMemo, useReducer, useState } from 'react'
import type { KV, Protocol, RequestDef } from '../core/types'
import { kv } from '../core/types'
import { interpolate } from '../core/vars'
import { scopeFor } from '../core/prepare'
import { prepareContext } from '../core/runtime'
import { prettyJson } from '../core/format'
import { KVTable } from './KVTable'
import { CodeArea } from './CodeArea'
import type { WorkspaceApi } from './useWorkspace'

export interface LogEntry { dir: 'in' | 'out' | 'info' | 'error'; at: number; text: string; topic?: string }

/** A live connection that outlives the component, so switching tabs keeps it open. */
interface Session {
  kind: 'ws' | 'mqtt' | 'sse' | 'socketio'
  state: 'connecting' | 'open' | 'closed'
  log: LogEntry[]
  send: (text: string, topic?: string, qos?: 0 | 1 | 2, retain?: boolean) => void
  subscribe?: (topic: string, qos: 0 | 1 | 2) => void
  unsubscribe?: (topic: string) => void
  close: () => void
  listeners: Set<() => void>
}
const sessions = new Map<string, Session>()
const LOG_MAX = 1000
const push = (s: Session, e: LogEntry) => { s.log = [...s.log, e].slice(-LOG_MAX); s.listeners.forEach((l) => l()) }

function useSession(id: string) {
  const [, tick] = useReducer((x: number) => x + 1, 0)
  const s = sessions.get(id)
  useEffect(() => {
    const cur = sessions.get(id)
    if (!cur) return
    cur.listeners.add(tick)
    return () => { cur.listeners.delete(tick) }
  }, [id, s])
  return s
}

export const PROTOCOLS: [Protocol, string][] = [['http', 'HTTP'], ['ws', 'WebSocket'], ['sse', 'Server-sent events'], ['socketio', 'Socket.IO'], ['mqtt', 'MQTT'], ['grpc', 'gRPC']]

export function ProtocolPicker({ draft, onChange }: { draft: RequestDef; onChange: (p: Protocol, url: string) => void }) {
  return (
    <select className="protoPick" aria-label="Protocol" value={draft.protocol} onChange={(e) => {
      const p = e.target.value as Protocol
      let url = draft.url
      if (p === 'ws' && /^https?:/i.test(url)) url = url.replace(/^http/i, 'ws')
      if (['http', 'sse', 'socketio'].includes(p) && /^wss?:/i.test(url)) url = url.replace(/^ws/i, 'http')
      onChange(p, url)
    }}>
      {PROTOCOLS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select>
  )
}

/** WebSocket and MQTT requests: connect, send/publish, subscribe, live log. */
export function RealtimePane({ ws, notify, createWebSocket }: { ws: WorkspaceApi; notify: (m: string) => void; createWebSocket?: (url: string, protocols: string[]) => WebSocket }) {
  const d = ws.draft
  const s = useSession(d.id)
  const [, force] = useReducer((x: number) => x + 1, 0)
  const [compose, setCompose] = useState('')
  const [filter, setFilter] = useState('')
  const [protocols, setProtocols] = useState('')
  const fill = useMemo(() => { const scope = scopeFor(prepareContext(ws.runContext(d), d)); return (t: string) => interpolate(t, scope) }, [ws, d])
  const set = (patch: Partial<RequestDef>) => ws.setDraft((x) => ({ ...x, ...patch }))
  const open = s?.state === 'open'

  const connect = async () => {
    sessions.get(d.id)?.close()
    const url = d.protocol === 'sse' ? ws.prepared.url : fill(d.url.trim())
    const httpish = d.protocol === 'sse' || d.protocol === 'socketio'
    if (httpish ? !/^https?:\/\//i.test(url) : !/^wss?:\/\//i.test(url)) { notify(httpish ? 'Use an http:// or https:// address.' : 'Use a ws:// or wss:// address.'); return }
    const sess: Session = { kind: d.protocol as Session['kind'], state: 'connecting', log: [], send: () => {}, close: () => {}, listeners: new Set() }
    sessions.set(d.id, sess)
    force()
    push(sess, { dir: 'info', at: Date.now(), text: `Connecting to ${url}…` })
    if (d.protocol === 'sse') {
      const { SseParser } = await import('../core/sse')
      const parser = new SseParser()
      const onText = (t: string) => { for (const ev of parser.push(t)) push(sess, { dir: 'in', at: Date.now(), topic: ev.event !== 'message' ? ev.event : undefined, text: ev.data }) }
      const headers = ws.prepared.headers
      if (ws.transport.unrestricted) {
        const { invoke } = await import('@tauri-apps/api/core')
        const { listen } = await import('@tauri-apps/api/event')
        const sid = Math.floor(Math.random() * 1e9)
        const un = await listen<{ id: number; kind: string; text: string; status: number }>('sse', (ev) => {
          const m = ev.payload
          if (m.id !== sid) return
          if (m.kind === 'open') { sess.state = 'open'; push(sess, { dir: 'info', at: Date.now(), text: `Connected (${m.status}${m.text ? `, ${m.text}` : ''})` }) }
          else if (m.kind === 'chunk') onText(m.text)
          else { sess.state = 'closed'; push(sess, { dir: m.kind === 'error' ? 'error' : 'info', at: Date.now(), text: m.kind === 'error' ? m.text : 'Stream ended' }); un() }
        })
        await invoke('sse_open', { req: { id: sid, url, headers, insecure_tls: ws.settings.insecureTls } })
        sess.close = () => { void invoke('sse_close', { id: sid }); un(); sess.state = 'closed'; push(sess, { dir: 'info', at: Date.now(), text: 'Disconnected' }) }
      } else {
        const ctrl = new AbortController()
        sess.close = () => { ctrl.abort(); sess.state = 'closed'; push(sess, { dir: 'info', at: Date.now(), text: 'Disconnected' }) }
        void (async () => {
          try {
            const res = await fetch(url, { headers: [...headers, ['Accept', 'text/event-stream']], signal: ctrl.signal })
            sess.state = 'open'; push(sess, { dir: 'info', at: Date.now(), text: `Connected (${res.status})` })
            const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
            for (;;) { const { value, done } = await reader.read(); if (done) break; onText(value) }
            if ((sess.state as Session['state']) !== 'closed') { sess.state = 'closed'; push(sess, { dir: 'info', at: Date.now(), text: 'Stream ended' }) }
          } catch (e) {
            if (!ctrl.signal.aborted) { sess.state = 'closed'; push(sess, { dir: 'error', at: Date.now(), text: `${e instanceof Error ? e.message : String(e)} (in the browser the server must allow this page via CORS)` }) }
          }
        })()
      }
      return
    }
    if (d.protocol === 'socketio') {
      const mod = await import('socket.io-client') as unknown as { io?: typeof import('socket.io-client').io; default?: { io: typeof import('socket.io-client').io } }
      const io = mod.io ?? mod.default?.io
      if (!io) { sess.state = 'closed'; push(sess, { dir: 'error', at: Date.now(), text: 'The Socket.IO client didn’t load.' }); return }
      // WebSocket only: long-polling would need plain HTTP from the page.
      const token = d.auth.kind === 'bearer' ? fill(d.auth.token) : undefined
      const socket = io(url, { transports: ['websocket'], reconnection: false, timeout: 10_000, ...(token ? { auth: { token } } : {}) })
      const names = d.sio.listen.split(',').map((x) => x.trim()).filter(Boolean)
      socket.on('connect', () => { sess.state = 'open'; push(sess, { dir: 'info', at: Date.now(), text: `Connected (id ${socket.id})${names.length ? `, listening to ${names.join(', ')}` : ', listening to every event'}` }) })
      socket.on('connect_error', (e: Error) => { sess.state = 'closed'; push(sess, { dir: 'error', at: Date.now(), text: e.message }) })
      socket.on('disconnect', (why: string) => { sess.state = 'closed'; push(sess, { dir: 'info', at: Date.now(), text: `Disconnected (${why})` }) })
      const show = (event: string, args: unknown[]) => push(sess, { dir: 'in', at: Date.now(), topic: event, text: JSON.stringify(args.length === 1 ? args[0] : args) })
      if (names.length) names.forEach((n) => socket.on(n, (...args: unknown[]) => show(n, args)))
      else socket.onAny((event: string, ...args: unknown[]) => show(event, args))
      sess.send = (text, event = 'message') => {
        let args: unknown[]
        try { const v = JSON.parse(text); args = Array.isArray(v) ? v : [v] } catch { args = [text] }
        socket.emit(event, ...args)
        push(sess, { dir: 'out', at: Date.now(), topic: event, text })
      }
      sess.close = () => { socket.close() }
      return
    }
    if (d.protocol === 'ws') {
      let sock: WebSocket
      try { sock = (createWebSocket ?? ((u, p) => new WebSocket(u, p)))(url, protocols.split(',').map((x) => x.trim()).filter(Boolean)) } catch (e) { sess.state = 'closed'; push(sess, { dir: 'error', at: Date.now(), text: String(e) }); return }
      sock.onopen = () => { sess.state = 'open'; push(sess, { dir: 'info', at: Date.now(), text: `Connected${sock.protocol ? ` (protocol ${sock.protocol})` : ''}` }) }
      sock.onmessage = (ev) => push(sess, { dir: 'in', at: Date.now(), text: typeof ev.data === 'string' ? ev.data : `[binary ${ev.data?.size ?? ev.data?.byteLength ?? ''} bytes]` })
      sock.onerror = () => push(sess, { dir: 'error', at: Date.now(), text: 'Connection error (the browser doesn’t say more; check the URL and that the server accepts this origin).' })
      sock.onclose = (ev) => { sess.state = 'closed'; push(sess, { dir: 'info', at: Date.now(), text: `Closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` }) }
      sess.send = (text) => { sock.send(text); push(sess, { dir: 'out', at: Date.now(), text }) }
      sess.close = () => { try { sock.close(1000) } catch { /* already closed */ } }
    } else {
      // The browser bundle puts connect on the default export; Node's has it at the top level.
      const mod = await import('mqtt') as unknown as { connect?: typeof import('mqtt').connect; default?: { connect: typeof import('mqtt').connect } }
      const mqttConnect = mod.connect ?? mod.default?.connect
      if (!mqttConnect) { sess.state = 'closed'; push(sess, { dir: 'error', at: Date.now(), text: 'The MQTT client didn’t load.' }); return }
      const auth = d.auth.kind === 'basic' ? { username: fill(d.auth.username), password: fill(d.auth.password) } : {}
      let client: ReturnType<typeof mqttConnect>
      try {
        client = mqttConnect(url, { clientId: fill(d.mqtt.clientId) || `dispatch-${Math.random().toString(16).slice(2, 10)}`, reconnectPeriod: 0, connectTimeout: 10_000, ...auth })
      } catch (e) { sess.state = 'closed'; push(sess, { dir: 'error', at: Date.now(), text: e instanceof Error ? e.message : String(e) }); return }
      client.on('connect', () => {
        sess.state = 'open'
        push(sess, { dir: 'info', at: Date.now(), text: 'Connected' })
        for (const t of d.mqtt.topics.filter((x) => x.enabled && x.key.trim())) sess.subscribe!(fill(t.key.trim()), (Number(t.value) || 0) as 0 | 1 | 2)
      })
      client.on('message', (topic, payload) => push(sess, { dir: 'in', at: Date.now(), topic, text: payload.toString() }))
      client.on('error', (e) => push(sess, { dir: 'error', at: Date.now(), text: e.message }))
      client.on('close', () => { if (sess.state !== 'closed') { sess.state = 'closed'; push(sess, { dir: 'info', at: Date.now(), text: 'Disconnected' }) } })
      sess.subscribe = (topic, qos) => client.subscribe(topic, { qos }, (err) => push(sess, err ? { dir: 'error', at: Date.now(), text: `Subscribe ${topic}: ${err.message}` } : { dir: 'info', at: Date.now(), text: `Subscribed to ${topic} (QoS ${qos})` }))
      sess.unsubscribe = (topic) => client.unsubscribe(topic, () => push(sess, { dir: 'info', at: Date.now(), text: `Unsubscribed from ${topic}` }))
      sess.send = (text, topic = '', qos = 0, retain = false) => {
        client.publish(topic, text, { qos, retain }, (err) => { if (err) push(sess, { dir: 'error', at: Date.now(), text: err.message }) })
        push(sess, { dir: 'out', at: Date.now(), topic, text })
      }
      sess.close = () => { sess.state = 'closed'; client.end(true); push(sess, { dir: 'info', at: Date.now(), text: 'Disconnected' }) }
    }
  }

  const send = (text: string) => {
    if (!s || !open) { notify('Connect first.'); return }
    if (d.protocol === 'socketio') { s.send(fill(text), fill(d.sio.emitEvent.trim()) || 'message'); return }
    if (d.protocol === 'mqtt') {
      const topic = fill(d.mqtt.publishTopic.trim())
      if (!topic) { notify('Set a topic to publish to.'); return }
      s.send(fill(text), topic, d.mqtt.qos, d.mqtt.retain)
    } else s.send(fill(text))
  }

  const log = (s?.log ?? []).filter((e) => !filter || e.text.toLowerCase().includes(filter.toLowerCase()) || e.topic?.includes(filter))
  const isWs = d.protocol === 'ws' || d.protocol === 'socketio'
  const isSse = d.protocol === 'sse'
  const label = ({ ws: 'WebSocket', mqtt: 'MQTT', sse: 'Server-sent events', socketio: 'Socket.IO' } as Record<string, string>)[d.protocol]

  return (
    <section className="request realtime" aria-label={label}>
      <div className="urlBar">
        <input className="url mono first" value={d.url} aria-label="URL" spellCheck={false} placeholder={isSse ? 'https://api.example.com/events' : d.protocol === 'socketio' ? 'https://chat.example.com/namespace' : isWs ? 'wss://echo.example.com/socket' : 'wss://broker.example.com:8884/mqtt'}
          onChange={(e) => set({ url: e.target.value })} />
        {open || s?.state === 'connecting'
          ? <button type="button" className="btn" onClick={() => { s?.close(); force() }}>Disconnect</button>
          : <button type="button" className="btn primary" onClick={() => void connect()}>Connect</button>}
      </div>
      <p className="muted small status-line">
        <span className={`connDot ${s?.state ?? 'closed'}`} aria-hidden /> {s?.state === 'open' ? 'Connected' : s?.state === 'connecting' ? 'Connecting…' : 'Not connected'}
        {isSse ? ' · Headers and auth from the request are sent. Events show below as they arrive.'
          : d.protocol === 'socketio' ? ' · Socket.IO over WebSocket. A bearer token on the Auth tab is sent as auth.token.'
          : isWs ? ' · Browsers can’t set custom headers on WebSockets; put tokens in the URL or the first message.' : ' · MQTT here runs over WebSockets (ws:// or wss://). Basic auth on the Auth tab sets username and password.'}
      </p>
      <div className="rtGrid">
        <div>
          {d.protocol === 'socketio' && <>
            <label className="field"><span>Listen to events (comma separated; empty = all)</span><input className="mono" value={d.sio.listen} placeholder="chat, notice" onChange={(e) => set({ sio: { ...d.sio, listen: e.target.value } })} /></label>
            <label className="field"><span>Emit as event</span><input className="mono" value={d.sio.emitEvent} onChange={(e) => set({ sio: { ...d.sio, emitEvent: e.target.value } })} /></label>
          </>}
          {d.protocol === 'ws' && <label className="field"><span>Subprotocols (comma separated)</span><input value={protocols} onChange={(e) => setProtocols(e.target.value)} placeholder="graphql-ws" /></label>}
          {d.protocol === 'mqtt' && <>
            <label className="field"><span>Client ID</span><input className="mono" value={d.mqtt.clientId} placeholder="random" onChange={(e) => set({ mqtt: { ...d.mqtt, clientId: e.target.value } })} /></label>
            <h3 className="subhead">Subscriptions (topic → QoS)</h3>
            <KVTable label="Subscriptions" keyPlaceholder="Topic" valuePlaceholder="QoS 0-2" rows={d.mqtt.topics} onChange={(topics) => set({ mqtt: { ...d.mqtt, topics } })} />
            {open && <button type="button" className="btn small" onClick={() => d.mqtt.topics.filter((t) => t.enabled && t.key.trim()).forEach((t) => s!.subscribe!(fill(t.key.trim()), (Number(t.value) || 0) as 0 | 1 | 2))}>Subscribe now</button>}
            <h3 className="subhead">Publish</h3>
            <div className="mqttPub">
              <label className="field"><span>Topic</span><input className="mono" value={d.mqtt.publishTopic} onChange={(e) => set({ mqtt: { ...d.mqtt, publishTopic: e.target.value } })} /></label>
              <label className="field"><span>QoS</span><select value={d.mqtt.qos} onChange={(e) => set({ mqtt: { ...d.mqtt, qos: Number(e.target.value) as 0 | 1 | 2 } })}><option value={0}>0</option><option value={1}>1</option><option value={2}>2</option></select></label>
              <label className="toggle"><input type="checkbox" checked={d.mqtt.retain} onChange={(e) => set({ mqtt: { ...d.mqtt, retain: e.target.checked } })} /> Retain</label>
            </div>
          </>}
          {!isSse && <>
          <CodeArea label="Message" lang="json" variables={ws.variableNames} rows={6} value={compose} onChange={setCompose} placeholder={isWs ? '{"type": "ping", "at": "{{$isoTimestamp}}"}' : '{"temp": 21.5}'} />
          <div className="actions">
            <button type="button" className="btn primary" disabled={!open} onClick={() => send(compose)}>{isWs ? 'Send' : 'Publish'}</button>
            <button type="button" className="btn ghost" disabled={!compose.trim()} onClick={() => set({ ws: { messages: [...d.ws.messages, kv(compose.split('\n')[0].slice(0, 30) || 'Message', compose)] } })}>Save message</button>
          </div>
          </>}
          {isSse && <p className="muted small">Set headers and auth on the request (switch the protocol to HTTP to edit them); they’re sent when connecting.</p>}
          {!isSse && d.ws.messages.length > 0 && <>
            <h3 className="subhead">Saved messages</h3>
            <ul className="savedMsgs">
              {d.ws.messages.map((m: KV, i) => (
                <li key={m.id}>
                  <button type="button" className="linkBtn small" onClick={() => setCompose(m.value)} title={m.value}>{m.key}</button>
                  <button type="button" className="btn small" disabled={!open} onClick={() => send(m.value)}>{isWs ? 'Send' : 'Publish'}</button>
                  <button type="button" className="icon" aria-label={`Remove ${m.key}`} onClick={() => set({ ws: { messages: d.ws.messages.filter((_, j) => j !== i) } })}>×</button>
                </li>
              ))}
            </ul>
          </>}
        </div>
        <div className="rtLog">
          <div className="row-h">
            <strong>Messages</strong><span className="muted small">{s?.log.length ?? 0}</span><span className="grow" />
            <input type="search" placeholder="Filter" aria-label="Filter messages" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button type="button" className="btn small ghost" disabled={!s} onClick={() => { if (s) { s.log = []; force() } }}>Clear</button>
          </div>
          <ol className="msgLog" aria-label="Message log">
            {log.map((e, i) => (
              <li key={i} className={`msg ${e.dir}`}>
                <span className="msgMeta">{e.dir === 'in' ? '↓' : e.dir === 'out' ? '↑' : e.dir === 'error' ? '!' : '·'} {new Date(e.at).toLocaleTimeString()}{e.topic ? ` · ${e.topic}` : ''}</span>
                <pre className="mono small">{prettyJson(e.text) ?? e.text}</pre>
              </li>
            ))}
            {!log.length && <li className="muted small">Connect, then send a message. Everything sent and received shows here.</li>}
          </ol>
        </div>
      </div>
    </section>
  )
}
