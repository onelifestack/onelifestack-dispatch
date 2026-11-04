import { useMemo, useState } from 'react'
import type { HistoryEntry, HttpResponse } from '../core/types'
import { diffLines, withContext } from '../core/diff'
import { formatBytes, formatMs, prettyJson, statusTone, timeAgo } from '../core/format'
import type { WorkspaceApi } from './useWorkspace'

/** Earlier sends of the open request: saved requests by id; unsaved drafts by method + URL. */
export function useRequestHistory(ws: WorkspaceApi): HistoryEntry[] {
  return useMemo(() => {
    const d = ws.draft
    return ws.history.filter((h) => (ws.saved ? h.request.id === d.id : h.sent.method === ws.prepared.method && h.sent.url === ws.prepared.url))
  }, [ws.history, ws.draft, ws.saved, ws.prepared])
}

const asText = (r: HttpResponse | null) => (r ? (r.binary ? `(binary, ${formatBytes(r.size)})` : prettyJson(r.body) ?? r.body) : '(no response)')
const headersText = (r: HttpResponse | null) => (r ? [...r.headers].map(([k, v]) => `${k.toLowerCase()}: ${v}`).sort().join('\n') : '')

function Diff({ a, b }: { a: string; b: string }) {
  const lines = useMemo(() => withContext(diffLines(a, b), 3), [a, b])
  if (lines.every((l) => l.type === 'same' || l.type === 'gap')) return <p className="muted small">No differences.</p>
  return (
    <pre className="diff mono small" aria-label="Differences">
      {lines.map((l, i) => l.type === 'gap'
        ? <div key={i} className="dgap">⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}</div>
        : <div key={i} className={`d${l.type}`}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}{l.text}</div>)}
    </pre>
  )
}

/** The History tab: earlier responses for this request, open one, or compare it with the current one. */
export function ResponseHistory({ ws, entries, current }: { ws: WorkspaceApi; entries: HistoryEntry[]; current: HttpResponse | null }) {
  const [cmp, setCmp] = useState<HistoryEntry | null>(null)
  const [what, setWhat] = useState<'body' | 'headers'>('body')
  if (!entries.length) return <p className="muted small">No earlier responses for this request yet.</p>
  return (
    <div className="respHistory">
      <table className="resultTable" aria-label="Earlier responses">
        <tbody>
          {entries.slice(0, 50).map((h) => (
            <tr key={h.id} className={cmp?.id === h.id ? 'on' : ''}>
              <td className="small">{new Date(h.at).toLocaleString()} <span className="muted tiny">{timeAgo(h.at)}</span></td>
              <td>{h.response ? <span className={`hstat ${statusTone(h.response.status)}`}>{h.response.status}</span> : <span className="badText small">error</span>}</td>
              <td className="mono small">{h.response ? formatMs(h.response.timeMs) : '—'}</td>
              <td className="mono small">{h.response ? formatBytes(h.response.size) : ''}</td>
              <td className="rowActions">
                <button type="button" className="btn small ghost" onClick={() => ws.openHistory(h)}>Open</button>
                {current && <button type="button" className="btn small" onClick={() => setCmp(cmp?.id === h.id ? null : h)}>{cmp?.id === h.id ? 'Hide' : 'Compare'}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cmp && current && (
        <div className="compare" aria-label="Comparison">
          <div className="row-h">
            <strong className="small">{new Date(cmp.at).toLocaleTimeString()} → now</strong>
            <span className="small">
              status {cmp.response?.status ?? '—'} → {current.status} · time {cmp.response ? formatMs(cmp.response.timeMs) : '—'} → {formatMs(current.timeMs)} · size {cmp.response ? formatBytes(cmp.response.size) : '—'} → {formatBytes(current.size)}
            </span>
            <span className="grow" />
            <div className="segmented">
              <button type="button" className={`seg ${what === 'body' ? 'on' : ''}`} onClick={() => setWhat('body')}>Body</button>
              <button type="button" className={`seg ${what === 'headers' ? 'on' : ''}`} onClick={() => setWhat('headers')}>Headers</button>
            </div>
          </div>
          {what === 'body' ? <Diff a={asText(cmp.response)} b={asText(current)} /> : <Diff a={headersText(cmp.response)} b={headersText(current)} />}
        </div>
      )}
    </div>
  )
}
