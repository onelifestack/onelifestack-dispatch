import { useState } from 'react'
import type { RequestDef } from '../core/types'
import { statusTone, timeAgo } from '../core/format'
import type { WorkspaceApi } from './useWorkspace'

type Tab = 'collections' | 'history' | 'environments'

interface Props { ws: WorkspaceApi; ask: (title: string, initial?: string) => Promise<string | null>; confirm: (msg: string) => Promise<boolean> }

const Method = ({ m }: { m: string }) => <span className={`mtag m-${m}`}>{m === 'DELETE' ? 'DEL' : m === 'OPTIONS' ? 'OPT' : m}</span>

export function Sidebar({ ws, ask, confirm }: Props) {
  const [tab, setTab] = useState<Tab>('collections')
  const [filter, setFilter] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const f = filter.trim().toLowerCase()
  const match = (r: RequestDef) => !f || r.name.toLowerCase().includes(f) || r.url.toLowerCase().includes(f)
  const byName = (a: RequestDef, b: RequestDef) => a.name.localeCompare(b.name)
  const loose = ws.requests.filter((r) => !r.collectionId && match(r)).sort(byName)
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const reqRow = (r: RequestDef) => (
    <li key={r.id} className={`row ${ws.draft.id === r.id && ws.view.kind === 'request' ? 'on' : ''}`}>
      <button type="button" className="rowMain" onClick={() => ws.openRequest(r)} title={r.url}>
        <Method m={r.method} /><span className="rowName">{r.name}</span>
      </button>
      <details className="menu">
        <summary aria-label={`More for ${r.name}`}>⋯</summary>
        <div className="menuList" role="menu">
          <button type="button" role="menuitem" onClick={async (e) => {
            (e.currentTarget.closest('details') as HTMLDetailsElement).open = false
            const name = await ask('Rename request', r.name)
            if (name) await ws.renameRequest(r, name)
          }}>Rename</button>
          <button type="button" role="menuitem" onClick={async (e) => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; ws.openRequest(await ws.duplicateRequest(r)) }}>Duplicate</button>
          <button type="button" role="menuitem" className="danger" onClick={async (e) => {
            (e.currentTarget.closest('details') as HTMLDetailsElement).open = false
            if (await confirm(`Delete “${r.name}”?`)) await ws.removeRequest(r.id)
          }}>Delete</button>
        </div>
      </details>
    </li>
  )

  return (
    <aside className="side" aria-label="Library">
      <div className="tabs side-tabs" role="tablist">
        {(['collections', 'history', 'environments'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'collections' ? 'Collections' : t === 'history' ? 'History' : 'Environments'}
          </button>
        ))}
      </div>

      {tab === 'collections' && <>
        <div className="sideTools">
          <input type="search" placeholder="Filter" aria-label="Filter requests" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="btn small" onClick={async () => { const n = await ask('New collection'); if (n) await ws.addCollection(n) }}>+ Collection</button>
        </div>
        <ul className="tree">
          {ws.collections.map((c) => {
            const reqs = ws.requests.filter((r) => r.collectionId === c.id && match(r)).sort(byName)
            if (f && !reqs.length && !c.name.toLowerCase().includes(f)) return null
            const open = !closed.has(c.id) || !!f
            return (
              <li key={c.id} className="folder">
                <div className={`row ${ws.view.kind === 'collection' && ws.view.id === c.id ? 'on' : ''}`}>
                  <button type="button" className="caret" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${c.name}`} onClick={() => toggle(c.id)}>{open ? '▾' : '▸'}</button>
                  <button type="button" className="rowMain folderName" onClick={() => ws.setView({ kind: 'collection', id: c.id })}>{c.name}</button>
                  <button type="button" className="icon" aria-label={`New request in ${c.name}`} title="New request here" onClick={() => ws.startNew(c.id)}>+</button>
                </div>
                {open && <ul>{reqs.map(reqRow)}{!reqs.length && <li className="muted small pad">No requests yet.</li>}</ul>}
              </li>
            )
          })}
          {loose.length > 0 && <li className="folder"><div className="row label muted small">Not in a collection</div><ul>{loose.map(reqRow)}</ul></li>}
          {!ws.collections.length && !loose.length && (
            <li className="muted small pad">Saved requests show up here. Make a request and press Save, or import a Postman collection from the menu.</li>
          )}
        </ul>
      </>}

      {tab === 'history' && <>
        <div className="sideTools">
          <span className="muted small grow">Last {ws.history.length} sent</span>
          {ws.history.length > 0 && <button type="button" className="btn small" onClick={async () => { if (await confirm('Clear all history?')) await ws.clearHistory() }}>Clear</button>}
        </div>
        <ul className="tree">
          {ws.history.map((h) => (
            <li key={h.id} className="row">
              <button type="button" className="rowMain hist" onClick={() => ws.openHistory(h)} title={h.sent.url}>
                <Method m={h.sent.method} />
                <span className="rowName">{h.sent.url.replace(/^https?:\/\//, '')}</span>
                <span className={`hstat ${h.response ? statusTone(h.response.status) : 'bad'}`}>{h.response ? h.response.status : '—'}</span>
                <span className="muted tiny">{timeAgo(h.at)}</span>
              </button>
            </li>
          ))}
          {!ws.history.length && <li className="muted small pad">Requests you send are listed here.</li>}
        </ul>
      </>}

      {tab === 'environments' && <>
        <div className="sideTools">
          <span className="muted small grow">Variable sets, like local and prod</span>
          <button type="button" className="btn small" onClick={async () => {
            const n = await ask('New environment'); if (n) { const e = await ws.addEnvironment(n); ws.setView({ kind: 'environment', id: e.id }) }
          }}>+ New</button>
        </div>
        <ul className="tree">
          {ws.environments.map((e) => (
            <li key={e.id} className={`row ${ws.view.kind === 'environment' && ws.view.id === e.id ? 'on' : ''}`}>
              <button type="button" className="rowMain" onClick={() => ws.setView({ kind: 'environment', id: e.id })}>
                <span className="rowName">{e.name}</span>
                {ws.settings.activeEnvId === e.id && <span className="pill">active</span>}
              </button>
            </li>
          ))}
          {!ws.environments.length && <li className="muted small pad">Make an environment to keep base URLs and tokens out of your requests, then use them as <code>{'{{name}}'}</code>.</li>}
        </ul>
      </>}
    </aside>
  )
}
