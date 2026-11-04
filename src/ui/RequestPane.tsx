import { useState } from 'react'
import type { Auth, BodyKind, Method, RequestDef } from '../core/types'
import { METHODS } from '../core/types'
import { paramsFromUrl, urlWithParams } from '../core/url'
import { fromCurl, looksLikeCurl } from '../core/curl'
import { effectiveAuth, jsonProblem, pathVarsFromUrl } from '../core/prepare'
import { FilePick, KVTable } from './KVTable'
import { AuthEditor, authLabel } from './AuthEditor'
import { CodeArea } from './CodeArea'
import type { WorkspaceApi } from './useWorkspace'

type Tab = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'docs' | 'settings'

export interface AuthActions { getToken: (auth: Auth, apply: (a: Auth) => void) => void; gettingToken: boolean }
interface Props { ws: WorkspaceApi; onSave: () => void; notify: (msg: string) => void; authActions?: AuthActions; scriptHelp?: React.ReactNode }

const BODY_KINDS: [BodyKind, string][] = [
  ['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['xml', 'XML'], ['html', 'HTML'],
  ['urlencoded', 'Form (urlencoded)'], ['formdata', 'Form-data (files)'], ['binary', 'Binary file'], ['graphql', 'GraphQL'],
]

export function RequestPane({ ws, onSave, notify, authActions, scriptHelp }: Props) {
  const { draft, setDraft, sending } = ws
  const [tab, setTab] = useState<Tab>('params')
  const [scriptTab, setScriptTab] = useState<'pre' | 'post'>('pre')
  const set = (patch: Partial<RequestDef>) => setDraft((d) => ({ ...d, ...patch }))
  const setBody = (patch: Partial<RequestDef['body']>) => setDraft((d) => ({ ...d, body: { ...d.body, ...patch } }))

  const onUrl = (url: string) => setDraft((d) => ({ ...d, url, params: paramsFromUrl(url, d.params), pathVars: pathVarsFromUrl(url, d.pathVars) }))
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!looksLikeCurl(text)) return
    e.preventDefault()
    try {
      const { request, warnings } = fromCurl(text)
      setDraft((d) => ({ ...request, id: d.id, name: d.name === 'New request' ? request.name : d.name, collectionId: d.collectionId, folderId: d.folderId, pathVars: pathVarsFromUrl(request.url, []) }))
      notify(warnings.length ? `Imported from curl. ${warnings.join(' ')}` : 'Imported from curl.')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  }

  const count = (rows: { enabled: boolean; key: string }[]) => rows.filter((r) => r.enabled && r.key).length
  const scriptCount = (draft.scripts.pre.trim() ? 1 : 0) + (draft.scripts.post.trim() ? 1 : 0)
  const overrides = [draft.settings.timeoutMs, draft.settings.followRedirects, draft.settings.insecureTls].filter((v) => v !== null).length
  const tabs: [Tab, string, string | number | null][] = [
    ['params', 'Params', count(draft.params) + draft.pathVars.length || null],
    ['headers', 'Headers', count(draft.headers) || null],
    ['body', 'Body', draft.body.kind === 'none' ? null : (BODY_KINDS.find(([k]) => k === draft.body.kind)?.[1].split(' ')[0].toLowerCase() ?? null)],
    ['auth', 'Auth', draft.auth.kind === 'inherit' || draft.auth.kind === 'none' ? null : authLabel(draft.auth.kind).split(' ')[0]],
    ['scripts', 'Scripts', scriptCount || null],
    ['docs', 'Docs', draft.docs.trim() ? '•' : null],
    ['settings', 'Settings', overrides || null],
  ]
  const problem = draft.body.kind === 'json' ? jsonProblem(draft.body.text) : draft.body.kind === 'graphql' ? jsonProblem(draft.body.graphqlVariables) : null

  // Where inherited auth comes from, nearest first.
  const inherited = effectiveAuth({ ...draft, auth: { ...draft.auth, kind: 'inherit' } }, ws.collection, ws.chain)
  const source = ws.chain.find((f) => f.auth.kind !== 'inherit')?.name ?? ws.collection?.name
  const inheritedHint = inherited
    ? `Uses ${source}’s auth (${authLabel(inherited.kind).toLowerCase()}).`
    : ws.collection ? 'Nothing to inherit: the folders and collection have no auth.' : 'This request isn’t in a collection, so nothing is inherited.'

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
        <input className="url mono" value={draft.url} placeholder="https://api.example.com/items/:id   (or paste a curl command)" aria-label="URL"
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
      <div className="tabs scrollTabs" role="tablist" aria-label="Request parts">
        {tabs.map(([id, label, badge]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}{badge != null && <span className="badge">{badge}</span>}
          </button>
        ))}
      </div>
      <div className="tabBody" role="tabpanel">
        {tab === 'params' && <>
          <KVTable label="Query params" rows={draft.params}
            onChange={(params) => setDraft((d) => ({ ...d, params, url: urlWithParams(d.url, params) }))} />
          {draft.pathVars.length > 0 && <>
            <h3 className="subhead">Path variables</h3>
            <KVTable label="Path variables" keyPlaceholder="Name" fixedKeys rows={draft.pathVars} onChange={(pathVars) => set({ pathVars })} />
          </>}
          {draft.pathVars.length === 0 && <p className="muted small">Tip: write <code>/users/:id</code> in the URL to get a path variable.</p>}
        </>}
        {tab === 'headers' && <KVTable label="Headers" keyPlaceholder="Header" rows={draft.headers} onChange={(headers) => set({ headers })} />}
        {tab === 'body' && (
          <div className="body">
            <label className="field inline">
              <span>Body type</span>
              <select aria-label="Body type" value={draft.body.kind} onChange={(e) => setBody({ kind: e.target.value as BodyKind })}>
                {BODY_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {draft.body.kind === 'json' && (
                <button type="button" className="btn ghost small" disabled={!!problem || !draft.body.text.trim() || /\{\{/.test(draft.body.text)}
                  onClick={() => setBody({ text: JSON.stringify(JSON.parse(draft.body.text), null, 2) })}>Tidy</button>
              )}
            </label>
            {['json', 'text', 'xml', 'html'].includes(draft.body.kind) &&
              <CodeArea label="Body" value={draft.body.text} rows={12} onChange={(text) => setBody({ text })}
                placeholder={draft.body.kind === 'json' ? '{\n  "name": "{{name}}"\n}' : draft.body.kind === 'xml' ? '<item>\n  <name>{{name}}</name>\n</item>' : ''} />}
            {draft.body.kind === 'graphql' && <div className="gqlGrid">
              <CodeArea label="GraphQL query" value={draft.body.text} rows={12} onChange={(text) => setBody({ text })} placeholder={'query Me {\n  me { id name }\n}'} />
              <CodeArea label="GraphQL variables" value={draft.body.graphqlVariables} rows={12} onChange={(graphqlVariables) => setBody({ graphqlVariables })} placeholder={'{\n  "id": "{{userId}}"\n}'} />
            </div>}
            {problem && <p className="warnLine small" role="status">JSON problem: {problem}</p>}
            {draft.body.kind === 'urlencoded' && (
              <KVTable label="Form fields" keyPlaceholder="Field" rows={draft.body.fields} onChange={(fields) => setBody({ fields })} />
            )}
            {draft.body.kind === 'formdata' && <>
              <KVTable label="Form-data fields" keyPlaceholder="Field" allowFiles rows={draft.body.fields} onChange={(fields) => setBody({ fields })} />
              <p className="muted small">Files are kept with the request on this device (up to 25 MB each).</p>
            </>}
            {draft.body.kind === 'binary' && <FilePick label="Body file" file={draft.body.file} onPick={(file) => setBody({ file })} onError={notify} />}
            {draft.body.kind === 'none' && <p className="muted small">This request has no body.</p>}
          </div>
        )}
        {tab === 'auth' && (
          <AuthEditor auth={draft.auth} allowInherit onChange={(auth) => set({ auth })} inheritedHint={inheritedHint}
            onGetToken={authActions ? () => authActions.getToken(draft.auth, (auth) => set({ auth })) : undefined} gettingToken={authActions?.gettingToken} />
        )}
        {tab === 'scripts' && (
          <div className="scripts">
            <div className="segmented" role="tablist" aria-label="Script">
              <button type="button" role="tab" aria-selected={scriptTab === 'pre'} className={`seg ${scriptTab === 'pre' ? 'on' : ''}`} onClick={() => setScriptTab('pre')}>Before request</button>
              <button type="button" role="tab" aria-selected={scriptTab === 'post'} className={`seg ${scriptTab === 'post' ? 'on' : ''}`} onClick={() => setScriptTab('post')}>After response (tests)</button>
            </div>
            <CodeArea label={scriptTab === 'pre' ? 'Pre-request script' : 'Post-response script'} rows={14} value={draft.scripts[scriptTab]}
              onChange={(v) => set({ scripts: { ...draft.scripts, [scriptTab]: v } })}
              placeholder={scriptTab === 'pre'
                ? '// Runs before the request is sent.\npm.environment.set("now", Date.now())'
                : '// Runs after the response arrives.\npm.test("status is 200", () => {\n  pm.expect(pm.response.code).to.equal(200)\n})'} />
            {scriptHelp}
          </div>
        )}
        {tab === 'docs' && (
          <div className="docsEdit">
            <CodeArea label="Request docs (Markdown)" rows={10} value={draft.docs} onChange={(docs) => set({ docs })} placeholder="What this request does, what it needs, what it returns. Markdown works." mono={false} />
          </div>
        )}
        {tab === 'settings' && (
          <div className="auth">
            <p className="muted small">Leave a setting on “App default” to use the one from the menu.</p>
            <label className="field"><span>Timeout (seconds)</span>
              <input type="number" min={1} max={600} placeholder={`App default (${Math.round(ws.settings.timeoutMs / 1000)})`} value={draft.settings.timeoutMs == null ? '' : Math.round(draft.settings.timeoutMs / 1000)}
                onChange={(e) => set({ settings: { ...draft.settings, timeoutMs: e.target.value === '' ? null : Math.min(600, Math.max(1, Number(e.target.value))) * 1000 } })} />
            </label>
            <TriState label="Follow redirects" value={draft.settings.followRedirects} app={ws.settings.followRedirects} onChange={(followRedirects) => set({ settings: { ...draft.settings, followRedirects } })} />
            {ws.transport.unrestricted && <TriState label="Allow self-signed certificates" value={draft.settings.insecureTls} app={ws.settings.insecureTls} onChange={(insecureTls) => set({ settings: { ...draft.settings, insecureTls } })} />}
          </div>
        )}
      </div>
    </section>
  )
}

function TriState({ label, value, app, onChange }: { label: string; value: boolean | null; app: boolean; onChange: (v: boolean | null) => void }) {
  return (
    <label className="field"><span>{label}</span>
      <select value={value == null ? '' : value ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'on')}>
        <option value="">App default ({app ? 'on' : 'off'})</option><option value="on">On</option><option value="off">Off</option>
      </select>
    </label>
  )
}
