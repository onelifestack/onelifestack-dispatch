import { useEffect, useMemo, useState } from 'react'
import { contentType, formatBytes, formatMs, prettyJson, statusTone } from '../core/format'
import { toCurl } from '../core/curl'
import { queryJson } from '../core/jsonpath'
import { parseSetCookie } from '../core/cookies'
import { uid } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'
import { CodeArea } from './CodeArea'

type Tab = 'body' | 'preview' | 'visualize' | 'headers' | 'cookies' | 'tests' | 'sent'

/** Shows long bodies in full only on request, so a huge response doesn't freeze the page. */
const PREVIEW_LIMIT = 200_000

export interface FileSaver { (fileName: string, data: { text?: string; base64?: string }, type: string): Promise<boolean> }

const extFor = (ct: string) => ct.includes('json') ? 'json' : ct.includes('html') ? 'html' : ct.includes('xml') ? 'xml' : ct.includes('png') ? 'png'
  : ct.includes('jpeg') ? 'jpg' : ct.includes('gif') ? 'gif' : ct.includes('pdf') ? 'pdf' : ct.includes('csv') ? 'csv' : ct.startsWith('text/') ? 'txt' : 'bin'

export function ResponsePane({ ws, notify, saveFile }: { ws: WorkspaceApi; notify: (m: string) => void; saveFile?: FileSaver }) {
  const { result, sending } = ws
  const [tab, setTab] = useState<Tab>('body')
  const [raw, setRaw] = useState(false)
  const [full, setFull] = useState(false)
  const [filter, setFilter] = useState('')
  const res = result?.response ?? null
  useEffect(() => setFull(false), [result])
  const ct = res ? contentType(res.headers) : ''
  const pretty = useMemo(() => (res && !res.binary ? prettyJson(res.body) : null), [res])
  const filtered = useMemo(() => {
    if (!filter.trim() || !res || pretty == null) return null
    try { return { text: JSON.stringify(queryJson(JSON.parse(res.body), filter), null, 2), error: null } } catch (e) { return { text: '', error: e instanceof Error ? e.message : String(e) } }
  }, [filter, res, pretty])
  const shown = !res ? '' : filtered && !filtered.error ? filtered.text : raw || pretty == null ? res.body : pretty
  const truncated = shown.length > PREVIEW_LIMIT && !full
  const cookies = useMemo(() => (res ? res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => parseSetCookie(v)) : []), [res])
  const tests = result?.tests ?? []
  const passed = tests.filter((t) => t.passed).length
  const isHtml = ct.includes('html')
  const isImage = ct.startsWith('image/') && !!res?.base64
  const canPreview = !!res && (isHtml || isImage)

  // Keep the chosen tab when it exists for this response; otherwise fall back.
  const avail: Tab[] = res ? ['body', ...(result?.visualizer ? ['visualize' as Tab] : []), ...(canPreview ? ['preview' as Tab] : []), 'headers', ...(cookies.length ? ['cookies' as Tab] : []), ...(tests.length ? ['tests' as Tab] : []), 'sent'] : [...(tests.length ? ['tests' as Tab] : []), 'sent']
  const current: Tab = avail.includes(tab) ? tab : avail[0]

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

  const label: Record<Tab, React.ReactNode> = {
    body: 'Body', preview: 'Preview', visualize: 'Visualize', headers: <>Headers<span className="badge">{res?.headers.length}</span></>,
    cookies: <>Cookies<span className="badge">{cookies.length}</span></>,
    tests: <>Tests<span className={`badge ${passed === tests.length ? 'goodBadge' : 'badBadge'}`}>{passed}/{tests.length}</span></>, sent: 'Sent',
  }

  return (
    <section className="response" aria-label="Response">
      <div className="resHead">
        {res ? <>
          <span className={`status ${statusTone(res.status)}`}>{res.status} {res.statusText}</span>
          <span className="metric" title={res.timings ? `Waiting for first byte ${formatMs(res.timings.ttfbMs)}, download ${formatMs(res.timings.downloadMs)}` : 'Time'}>
            {formatMs(res.timeMs)}{res.timings && <span className="muted"> (first byte {formatMs(res.timings.ttfbMs)})</span>}
          </span>
          <span className="metric" title="Size">{formatBytes(res.size)}</span>
        </> : <span className="status bad">{result.error?.startsWith('Skipped') ? 'Skipped' : 'Not sent'}</span>}
        {tests.length > 0 && <span className={`metric ${passed === tests.length ? 'goodText' : 'badText'}`}>{passed}/{tests.length} tests passed</span>}
        <span className="grow" />
        <button type="button" className="btn ghost small" onClick={() => copy(toCurl(result.sent), 'curl command')}>Copy as curl</button>
        {res && !res.binary && <button type="button" className="btn ghost small" onClick={() => copy(res.body, 'Body')}>Copy body</button>}
        {res && saveFile && <button type="button" className="btn ghost small" onClick={async () => {
          try { if (await saveFile(`response.${extFor(ct)}`, res.binary ? { base64: res.base64 } : { text: res.body }, ct || 'application/octet-stream')) notify('Response saved.') } catch (e) { notify(`Couldn’t save: ${String(e)}`) }
        }}>Save to file</button>}
        {res && !res.binary && <button type="button" className="btn ghost small" onClick={() => {
          ws.setDraft((d) => ({ ...d, examples: [...d.examples, { id: uid(), name: `${res.status} ${res.statusText}`.trim(), status: res.status, headers: res.headers, body: res.body }] }))
          notify('Saved as an example on this request (save the request to keep it).')
        }}>Save as example</button>}
      </div>
      {result.error && <p className="errorBox" role="alert">{result.error}</p>}
      <div className="tabs" role="tablist" aria-label="Response parts">
        {avail.map((t) => <button key={t} type="button" role="tab" aria-selected={current === t} className={current === t ? 'on' : ''} onClick={() => setTab(t)}>{label[t]}</button>)}
        {res && current === 'body' && !res.binary && pretty != null && <>
          <input className="mono jsonFilter" placeholder="Filter: $.items[*].id" aria-label="JSON filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="toggle small"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw</label>
        </>}
      </div>
      <div className="tabBody" role="tabpanel">
        {res && current === 'body' && (res.binary
          ? <p className="muted">Binary body ({ct || 'unknown type'}, {formatBytes(res.size)}). {canPreview ? 'See Preview, or save it to a file.' : 'Save it to a file to open it.'}</p>
          : res.body === '' ? <p className="muted">Empty body.</p>
          : <>
              {filtered?.error && <p className="warnLine small">Filter: {filtered.error}</p>}
              {pretty != null && !raw && !filtered && !truncated
                ? <CodeArea key={res.timeMs + res.size} label="Response body" lang="json" readOnly value={shown} onChange={() => {}} rows={20} />
                : <pre className="code mono out">{truncated ? shown.slice(0, PREVIEW_LIMIT) : shown}</pre>}
              {truncated && <button type="button" className="btn small" onClick={() => setFull(true)}>Show all {formatBytes(shown.length)}</button>}
            </>)}
        {res && current === 'preview' && (isImage
          ? <img className="imgPreview" alt="Response image" src={`data:${ct};base64,${res.base64}`} />
          : <>
              <p className="muted small">Shown in a sandbox: scripts, forms and links in the page don’t run.</p>
              <iframe className="htmlPreview" title="Response preview" sandbox="" srcDoc={res.body} />
            </>)}
        {current === 'visualize' && result.visualizer && <>
          <p className="muted small">Made by <code>pm.visualizer.set()</code> in a script, shown in a sandbox{ws.transport.unrestricted ? ' (scripts inside the template run in the web version only)' : ''}.</p>
          <iframe className="htmlPreview" title="Visualization" sandbox="allow-scripts" srcDoc={result.visualizer.html} />
        </>}
        {res && current === 'headers' && (
          <table className="kv readonly" aria-label="Response headers">
            <tbody>{res.headers.map(([k, v], i) => <tr key={i}><th className="mono">{k}</th><td className="mono">{v}</td></tr>)}</tbody>
          </table>
        )}
        {res && current === 'cookies' && (
          <table className="kv readonly" aria-label="Response cookies">
            <thead><tr><th>Name</th><td className="small muted">Value · attributes</td></tr></thead>
            <tbody>{cookies.map((c, i) => <tr key={i}><th className="mono">{c.name}</th><td className="mono">{c.value}<span className="muted small">{[c.domain && ` · domain ${c.domain}`, c.path && ` · path ${c.path}`, c.expires && ` · expires ${c.expires}`, c.httpOnly && ' · HttpOnly', c.secure && ' · Secure', c.sameSite && ` · SameSite=${c.sameSite}`].filter(Boolean).join('')}</span></td></tr>)}</tbody>
          </table>
        )}
        {current === 'tests' && (
          <ul className="testList" aria-label="Test results">
            {tests.map((t, i) => (
              <li key={i} className={t.passed ? 'pass' : 'fail'}>
                <span className="testMark" aria-label={t.passed ? 'passed' : 'failed'}>{t.passed ? '✓' : '✗'}</span>
                <span>{t.name}{t.error && <span className="testErr mono small">{t.error}</span>}</span>
              </li>
            ))}
          </ul>
        )}
        {current === 'sent' && (
          <div>
            <p className="muted small">Exactly what was sent, after scripts, variables and auth.</p>
            <pre className="code mono out">{`${result.sent.method} ${result.sent.url}\n${result.sent.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}${result.sent.body ? `\n\n${result.sent.body}` : result.sent.multipart ? `\n\n[form-data: ${result.sent.multipart.map((p) => p.file ? `${p.name}=<${p.file.name}>` : `${p.name}=${p.value}`).join(', ')}]` : result.sent.bodyFile ? `\n\n[file: ${result.sent.bodyFile.name}]` : ''}`}</pre>
          </div>
        )}
      </div>
    </section>
  )
}
