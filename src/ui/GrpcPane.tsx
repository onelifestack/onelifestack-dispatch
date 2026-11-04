import { useMemo, useState } from 'react'
import type { RequestDef } from '../core/types'
import { interpolate } from '../core/vars'
import { scopeFor } from '../core/prepare'
import { prepareContext } from '../core/runtime'
import { isDesktop } from '../core/transport'
import { formatMs } from '../core/format'
import { KVTable } from './KVTable'
import { CodeArea } from './CodeArea'
import type { WorkspaceApi } from './useWorkspace'

interface MethodInfo { name: string; path: string; input: string; output: string; client_streaming: boolean; server_streaming: boolean; template: string }
interface ServiceInfo { name: string; methods: MethodInfo[] }
interface CallResult { code: number; code_name: string; message: string; responses: unknown[]; headers: [string, string][]; trailers: [string, string][]; time_ms: number }

/** Services found per address this session, so tab switches don't re-describe. */
const described = new Map<string, ServiceInfo[]>()

/** gRPC requests (desktop): describe via reflection or a pasted .proto, pick a method, send JSON. */
export function GrpcPane({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const d = ws.draft
  const g = d.grpc
  const set = (patch: Partial<RequestDef['grpc']>) => ws.setDraft((x) => ({ ...x, grpc: { ...x.grpc, ...patch } }))
  const fill = useMemo(() => { const scope = scopeFor(prepareContext(ws.runContext(d), d)); return (t: string) => interpolate(t, scope) }, [ws, d])
  const key = `${fill(d.url)}|${g.tls}|${g.useReflection ? '' : g.proto}`
  const [services, setServices] = useState<ServiceInfo[] | null>(() => described.get(key) ?? null)
  const [busy, setBusy] = useState<'describe' | 'call' | null>(null)
  const [result, setResult] = useState<CallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const method = services?.flatMap((s) => s.methods).find((m) => m.path === g.method) ?? null
  const target = () => ({ address: fill(d.url.trim()), tls: g.tls, proto: g.useReflection ? '' : g.proto, timeout_ms: d.settings.timeoutMs ?? ws.settings.timeoutMs })

  if (!isDesktop()) {
    return <section className="request"><p className="warnLine">gRPC needs the desktop app: browsers can’t make the HTTP/2 calls it uses. Your request settings here are kept, so you can save it and send it from the desktop app.</p></section>
  }

  const describe = async () => {
    if (!d.url.trim()) { notify('Enter the server address, like localhost:50051.'); return }
    setBusy('describe'); setError(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const s = await invoke<ServiceInfo[]>('grpc_describe', { target: target() })
      described.set(key, s); setServices(s)
      if (!s.some((x) => x.methods.some((m) => m.path === g.method))) {
        const first = s[0]?.methods[0]
        if (first) set({ method: first.path, message: g.message.trim() && g.message.trim() !== '{}' ? g.message : first.template })
      }
      notify(`Found ${s.reduce((n, x) => n + x.methods.length, 0)} methods in ${s.length} service${s.length === 1 ? '' : 's'}.`)
    } catch (e) { setError(String(e)) } finally { setBusy(null) }
  }

  const call = async () => {
    if (!g.method) { notify('Load the services and pick a method first.'); return }
    setBusy('call'); setError(null); setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const r = await invoke<CallResult>('grpc_call', { call: {
        target: target(), path: g.method, request_json: fill(g.message),
        metadata: g.metadata.filter((m) => m.enabled && m.key.trim()).map((m) => [fill(m.key.trim()), fill(m.value)]),
      } })
      setResult(r)
      ws.log([{ level: r.code === 0 ? 'info' : 'warn', at: Date.now(), source: 'gRPC', text: `${g.method} → ${r.code_name}${r.message ? `: ${r.message}` : ''} · ${r.time_ms} ms · ${r.responses.length} message${r.responses.length === 1 ? '' : 's'}` }])
    } catch (e) { setError(String(e)) } finally { setBusy(null) }
  }

  return (
    <section className="request grpcPane" aria-label="gRPC">
      <div className="urlBar">
        <input className="url mono first" value={d.url} aria-label="Server address" spellCheck={false} placeholder="localhost:50051  or  api.example.com:443"
          onChange={(e) => ws.setDraft((x) => ({ ...x, url: e.target.value }))} />
        <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void call()}>{busy === 'call' ? 'Calling…' : 'Invoke'}</button>
      </div>
      <div className="grpcOpts">
        <label className="toggle"><input type="checkbox" checked={g.tls} onChange={(e) => set({ tls: e.target.checked })} /> TLS</label>
        <label className="toggle"><input type="radio" name="grpcSrc" checked={g.useReflection} onChange={() => set({ useReflection: true })} /> Server reflection</label>
        <label className="toggle"><input type="radio" name="grpcSrc" checked={!g.useReflection} onChange={() => set({ useReflection: false })} /> Paste .proto</label>
        <button type="button" className="btn small" disabled={busy !== null} onClick={() => void describe()}>{busy === 'describe' ? 'Loading…' : services ? 'Reload services' : 'Load services'}</button>
      </div>
      {!g.useReflection && <CodeArea label=".proto definition" rows={8} value={g.proto} onChange={(proto) => set({ proto })} placeholder={'syntax = "proto3";\npackage demo.v1;\nservice Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }\n…'} />}
      {error && <p className="errorBox" role="alert">{error}</p>}
      <div className="rtGrid">
        <div>
          <label className="field"><span>Method</span>
            <select aria-label="gRPC method" value={g.method} onChange={(e) => {
              const m = services?.flatMap((s) => s.methods).find((x) => x.path === e.target.value)
              set({ method: e.target.value, ...(m ? { message: m.template } : {}) })
            }}>
              {!method && <option value={g.method}>{g.method || 'Load services first'}</option>}
              {services?.map((s) => (
                <optgroup key={s.name} label={s.name}>
                  {s.methods.map((m) => <option key={m.path} value={m.path}>{m.name}{m.client_streaming || m.server_streaming ? ` (${[m.client_streaming && 'client', m.server_streaming && 'server'].filter(Boolean).join(' + ')} streaming)` : ''}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          {method && <p className="tiny muted mono">{method.input} → {method.output}{method.client_streaming ? ' · send a JSON array: one item per message' : ''}</p>}
          <div className="row-h"><span className="small muted">Message (JSON, {'{{variables}}'} work)</span>{method && <button type="button" className="btn small ghost" onClick={() => set({ message: method.template })}>Use template</button>}</div>
          <CodeArea label="gRPC message" lang="json" variables={ws.variableNames} rows={10} value={g.message} onChange={(message) => set({ message })} />
          <h3 className="subhead">Metadata</h3>
          <KVTable label="gRPC metadata" keyPlaceholder="Key" rows={g.metadata} onChange={(metadata) => set({ metadata })} />
        </div>
        <div className="rtLog">
          {!result && <p className="muted small">Load the services, pick a method and press Invoke. Responses show here; streams list every message.</p>}
          {result && <>
            <div className="resHead">
              <span className={`status ${result.code === 0 ? 'good' : 'bad'}`}>{result.code} {result.code_name}</span>
              <span className="metric">{formatMs(result.time_ms)}</span>
              <span className="metric">{result.responses.length} message{result.responses.length === 1 ? '' : 's'}</span>
            </div>
            {result.message && <p className="errorBox">{result.message}</p>}
            {result.responses.map((r, i) => <pre key={i} className="code mono out small">{JSON.stringify(r, null, 2)}</pre>)}
            {(result.headers.length > 0 || result.trailers.length > 0) && (
              <details><summary className="small">Headers and trailers</summary>
                <table className="kv readonly"><tbody>{[...result.headers.map(([k, v]) => [k, v, 'header']), ...result.trailers.map(([k, v]) => [k, v, 'trailer'])].map(([k, v, t], i) => <tr key={i}><th className="mono">{k}</th><td className="mono">{v} <span className="tiny muted">{t}</span></td></tr>)}</tbody></table>
              </details>
            )}
          </>}
        </div>
      </div>
    </section>
  )
}
