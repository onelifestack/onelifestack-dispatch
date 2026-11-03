import { useEffect, useMemo, useState } from 'react'
import { contentType, formatBytes, formatMs, prettyJson, statusTone } from '../core/format'
import { toCurl } from '../core/curl'
import type { WorkspaceApi } from './useWorkspace'

type Tab = 'body' | 'headers' | 'sent'

/** Shows long bodies in full only on request, so a huge response doesn't freeze the page. */
const PREVIEW_LIMIT = 200_000

export function ResponsePane({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const { result, sending } = ws
  const [tab, setTab] = useState<Tab>('body')
  const [raw, setRaw] = useState(false)
  const [full, setFull] = useState(false)
  const res = result?.response ?? null
  useEffect(() => setFull(false), [result])
  const pretty = useMemo(() => (res && !res.binary ? prettyJson(res.body) : null), [res])
  const shown = !res ? '' : raw || pretty == null ? res.body : pretty
  const truncated = shown.length > PREVIEW_LIMIT && !full

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`${what} copied.`) } catch { notify('Couldn’t reach the clipboard.') }
  }

  if (sending) return <section className="response empty" aria-label="Response" aria-busy="true"><p className="pulse">Sending…</p></section>
  if (!result) {
    return (
      <section className="response empty" aria-label="Response">
        <div>
          <p className="lead">Send a request to see the response here.</p>
          <p className="muted small">Tip: paste a curl command into the URL bar to import it.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="response" aria-label="Response">
      <div className="resHead">
        {res ? <>
          <span className={`status ${statusTone(res.status)}`}>{res.status} {res.statusText}</span>
          <span className="metric" title="Time">{formatMs(res.timeMs)}</span>
          <span className="metric" title="Size">{formatBytes(res.size)}</span>
        </> : <span className="status bad">Not sent</span>}
        <span className="grow" />
        <button type="button" className="btn ghost small" onClick={() => copy(toCurl(result.sent), 'curl command')}>Copy as curl</button>
        {res && !res.binary && <button type="button" className="btn ghost small" onClick={() => copy(res.body, 'Body')}>Copy body</button>}
      </div>
      {result.error && <p className="errorBox" role="alert">{result.error}</p>}
      <div className="tabs" role="tablist" aria-label="Response parts">
        {res && <button type="button" role="tab" aria-selected={tab === 'body'} className={tab === 'body' ? 'on' : ''} onClick={() => setTab('body')}>Body</button>}
        {res && <button type="button" role="tab" aria-selected={tab === 'headers'} className={tab === 'headers' ? 'on' : ''} onClick={() => setTab('headers')}>Headers<span className="badge">{res.headers.length}</span></button>}
        <button type="button" role="tab" aria-selected={tab === 'sent' || !res} className={tab === 'sent' || !res ? 'on' : ''} onClick={() => setTab('sent')}>Sent</button>
        {res && tab === 'body' && !res.binary && pretty != null && (
          <label className="toggle small"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw</label>
        )}
      </div>
      <div className="tabBody" role="tabpanel">
        {res && tab === 'body' && (res.binary
          ? <p className="muted">Binary body ({contentType(res.headers) || 'unknown type'}, {formatBytes(res.size)}). It isn’t shown as text.</p>
          : res.body === '' ? <p className="muted">Empty body.</p>
          : <>
              <pre className="code mono out">{truncated ? shown.slice(0, PREVIEW_LIMIT) : shown}</pre>
              {truncated && <button type="button" className="btn small" onClick={() => setFull(true)}>Show all {formatBytes(shown.length)}</button>}
            </>)}
        {res && tab === 'headers' && (
          <table className="kv readonly" aria-label="Response headers">
            <tbody>{res.headers.map(([k, v], i) => <tr key={i}><th className="mono">{k}</th><td className="mono">{v}</td></tr>)}</tbody>
          </table>
        )}
        {(tab === 'sent' || !res) && (
          <div>
            <p className="muted small">Exactly what was sent, after variables and auth were filled in.</p>
            <pre className="code mono out">{`${result.sent.method} ${result.sent.url}\n${result.sent.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}${result.sent.body ? `\n\n${result.sent.body}` : ''}`}</pre>
          </div>
        )}
      </div>
    </section>
  )
}
