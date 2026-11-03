import { useState } from 'react'
import type { BodyKind, Method, RequestDef } from '../core/types'
import { METHODS } from '../core/types'
import { paramsFromUrl, urlWithParams } from '../core/url'
import { fromCurl, looksLikeCurl } from '../core/curl'
import { jsonProblem } from '../core/prepare'
import { KVTable } from './KVTable'
import { AuthEditor, authLabel } from './AuthEditor'
import type { WorkspaceApi } from './useWorkspace'

type Tab = 'params' | 'headers' | 'body' | 'auth'

interface Props { ws: WorkspaceApi; onSave: () => void; notify: (msg: string) => void }

export function RequestPane({ ws, onSave, notify }: Props) {
  const { draft, setDraft, sending } = ws
  const [tab, setTab] = useState<Tab>('params')
  const set = (patch: Partial<RequestDef>) => setDraft((d) => ({ ...d, ...patch }))

  const onUrl = (url: string) => setDraft((d) => ({ ...d, url, params: paramsFromUrl(url, d.params) }))
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!looksLikeCurl(text)) return
    e.preventDefault()
    try {
      const { request, warnings } = fromCurl(text)
      setDraft((d) => ({ ...request, id: d.id, name: d.name === 'New request' ? request.name : d.name, collectionId: d.collectionId }))
      notify(warnings.length ? `Imported from curl. ${warnings.join(' ')}` : 'Imported from curl.')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  }

  const count = (rows: { enabled: boolean; key: string }[]) => rows.filter((r) => r.enabled && r.key).length
  const tabs: [Tab, string, string | number | null][] = [
    ['params', 'Params', count(draft.params) || null],
    ['headers', 'Headers', count(draft.headers) || null],
    ['body', 'Body', draft.body.kind === 'none' ? null : draft.body.kind === 'urlencoded' ? 'form' : draft.body.kind],
    ['auth', 'Auth', draft.auth.kind === 'inherit' || draft.auth.kind === 'none' ? null : authLabel(draft.auth.kind).split(' ')[0]],
  ]
  const problem = draft.body.kind === 'json' ? jsonProblem(draft.body.text) : null

  return (
    <section className="request" aria-label="Request">
      <div className="titleRow">
        <input className="reqName" value={draft.name} aria-label="Request name" onChange={(e) => set({ name: e.target.value })} />
        {ws.dirty && <span className="dot" title="Unsaved changes" aria-label="Unsaved changes" />}
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onSave}>Save <kbd>Ctrl S</kbd></button>
      </div>
      <form className="urlBar" onSubmit={(e) => { e.preventDefault(); void ws.send() }}>
        <select className={`method m-${draft.method}`} value={draft.method} aria-label="Method" onChange={(e) => set({ method: e.target.value as Method })}>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="url mono" value={draft.url} placeholder="https://api.example.com/items   (or paste a curl command)" aria-label="URL"
          spellCheck={false} autoComplete="off" onChange={(e) => onUrl(e.target.value)} onPaste={onPaste} />
        {sending
          ? <button type="button" className="btn" onClick={ws.cancel}>Cancel</button>
          : <button type="submit" className="btn primary">Send <kbd>Ctrl ↵</kbd></button>}
      </form>
      {ws.prepared.unresolved.length > 0 && (
        <p className="warnLine small" role="status">
          No value for {ws.prepared.unresolved.map((n) => <code key={n}>{`{{${n}}}`}</code>)}
          {ws.environment ? ` in ${ws.environment.name}` : ' (no environment selected)'}.
        </p>
      )}
      <div className="tabs" role="tablist" aria-label="Request parts">
        {tabs.map(([id, label, badge]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}{badge != null && <span className="badge">{badge}</span>}
          </button>
        ))}
      </div>
      <div className="tabBody" role="tabpanel">
        {tab === 'params' && (
          <KVTable label="Query params" rows={draft.params}
            onChange={(params) => setDraft((d) => ({ ...d, params, url: urlWithParams(d.url, params) }))} />
        )}
        {tab === 'headers' && <KVTable label="Headers" keyPlaceholder="Header" rows={draft.headers} onChange={(headers) => set({ headers })} />}
        {tab === 'body' && (
          <div className="body">
            <div className="segmented" role="radiogroup" aria-label="Body type">
              {(['none', 'json', 'text', 'urlencoded'] as BodyKind[]).map((k) => (
                <label key={k} className={draft.body.kind === k ? 'on' : ''}>
                  <input type="radio" name="bodyKind" value={k} checked={draft.body.kind === k} onChange={() => set({ body: { ...draft.body, kind: k } })} />
                  {k === 'none' ? 'None' : k === 'json' ? 'JSON' : k === 'text' ? 'Text' : 'Form (urlencoded)'}
                </label>
              ))}
              {draft.body.kind === 'json' && (
                <button type="button" className="btn ghost small" disabled={!!problem || !draft.body.text.trim() || /\{\{/.test(draft.body.text)}
                  onClick={() => set({ body: { ...draft.body, text: JSON.stringify(JSON.parse(draft.body.text), null, 2) } })}>Tidy</button>
              )}
            </div>
            {(draft.body.kind === 'json' || draft.body.kind === 'text') && <>
              <textarea className="code mono" value={draft.body.text} aria-label="Body" spellCheck={false} rows={12}
                placeholder={draft.body.kind === 'json' ? '{\n  "name": "{{name}}"\n}' : ''}
                onChange={(e) => set({ body: { ...draft.body, text: e.target.value } })}
                onKeyDown={(e) => {
                  if (e.key !== 'Tab' || e.shiftKey) return
                  e.preventDefault()
                  const t = e.currentTarget; const s = t.selectionStart
                  const text = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd)
                  set({ body: { ...draft.body, text } })
                  requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2 })
                }} />
              {problem && <p className="warnLine small" role="status">JSON problem: {problem}</p>}
            </>}
            {draft.body.kind === 'urlencoded' && (
              <KVTable label="Form fields" keyPlaceholder="Field" rows={draft.body.fields} onChange={(fields) => set({ body: { ...draft.body, fields } })} />
            )}
            {draft.body.kind === 'none' && <p className="muted small">This request has no body.</p>}
          </div>
        )}
        {tab === 'auth' && (
          <AuthEditor auth={draft.auth} allowInherit onChange={(auth) => set({ auth })}
            inheritedHint={ws.collection
              ? `Uses ${ws.collection.name}’s auth (${authLabel(ws.collection.auth.kind).toLowerCase()}).`
              : 'This request isn’t in a collection, so nothing is inherited.'} />
        )}
      </div>
    </section>
  )
}
