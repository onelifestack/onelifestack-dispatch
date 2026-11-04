import { useState } from 'react'
import type { Collection, Folder, RequestDef } from '../core/types'
import { bySort } from '../core/types'
import { statusTone, timeAgo } from '../core/format'
import type { WorkspaceApi } from './useWorkspace'

type Tab = 'collections' | 'history' | 'environments'

export interface SidebarDialogs {
  ask: (title: string, initial?: string) => Promise<string | null>
  confirm: (msg: string) => Promise<boolean>
  pickPlace: (title: string, current: { collectionId: string | null; folderId: string | null }) => Promise<{ collectionId: string | null; folderId: string | null } | null>
}

interface Props { ws: WorkspaceApi; dialogs: SidebarDialogs; onExportCollection: (c: Collection) => void }

const Method = ({ m }: { m: string }) => <span className={`mtag m-${m}`}>{m === 'DELETE' ? 'DEL' : m === 'OPTIONS' ? 'OPT' : m}</span>
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

/** A ⋯ menu; each item closes it before running. */
function Menu({ label, items }: { label: string; items: [string, () => void, ('danger' | undefined)?][] }) {
  return (
    <details className="menu">
      <summary aria-label={label}>⋯</summary>
      <div className="menuList" role="menu">
        {items.map(([text, run, tone]) => (
          <button key={text} type="button" role="menuitem" className={tone ?? ''} onClick={(e) => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; run() }}>{text}</button>
        ))}
      </div>
    </details>
  )
}

export function Sidebar({ ws, dialogs, onExportCollection }: Props) {
  const { ask, confirm, pickPlace } = dialogs
  const [tab, setTab] = useState<Tab>('collections')
  const [filter, setFilter] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const f = filter.trim().toLowerCase()
  const match = (r: RequestDef) => !f || r.name.toLowerCase().includes(f) || r.url.toLowerCase().includes(f)
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const openTabIds = new Set(ws.tabs.map((t) => t.draft.id))

  const reqRow = (r: RequestDef) => (
    <li key={r.id} className={`row ${ws.draft.id === r.id && ws.view.kind === 'request' ? 'on' : ''}`}>
      <button type="button" className="rowMain" onClick={() => ws.openRequest(r)} title={r.url}>
        {r.protocol === 'http' ? <Method m={r.method} /> : <span className="mtag m-proto">{({ ws: 'WS', mqtt: 'MQTT', grpc: 'gRPC' } as Record<string, string>)[r.protocol]}</span>}<span className="rowName">{r.name}</span>
        {openTabIds.has(r.id) && ws.draft.id !== r.id && <span className="openDot" aria-label="open in a tab" />}
      </button>
      <Menu label={`More for ${r.name}`} items={[
        ['Rename', async () => { const name = await ask('Rename request', r.name); if (name) await ws.renameRequest(r, name) }],
        ['Duplicate', async () => ws.openRequest(await ws.duplicateRequest(r))],
        ['Move to…', async () => { const to = await pickPlace(`Move “${r.name}”`, r); if (to) await ws.moveRequest(r, to.collectionId, to.folderId) }],
        ['Load test…', () => ws.setView({ kind: 'load', requestId: r.id })],
        ['Delete', async () => { if (await confirm(`Delete “${r.name}”?`)) await ws.removeRequest(r.id) }, 'danger'],
      ]} />
    </li>
  )

  /** Requests and subfolders under a collection (folderId null) or a folder. Returns null when the filter hides everything. */
  const children = (c: Collection, parent: string | null): JSX.Element[] => {
    const subs = ws.folders.filter((x) => x.collectionId === c.id && x.parentId === parent)
      .map((sub) => ({ sort: sub.sort, name: sub.name, node: () => folderNode(c, sub) }))
    const reqs = ws.requests.filter((r) => r.collectionId === c.id && (r.folderId ?? null) === parent && match(r))
      .map((r) => ({ sort: r.sort, name: r.name, node: () => reqRow(r) }))
    return [...subs, ...reqs].sort(bySort).map((x) => x.node()).filter((x): x is JSX.Element => x !== null)
  }

  const folderNode = (c: Collection, fo: Folder): JSX.Element | null => {
    const kids = children(c, fo.id)
    if (f && !kids.length && !fo.name.toLowerCase().includes(f)) return null
    const open = !closed.has(fo.id) || !!f
    return (
      <li key={fo.id} className="folder">
        <div className={`row ${ws.view.kind === 'folder' && ws.view.id === fo.id ? 'on' : ''}`}>
          <button type="button" className="caret" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${fo.name}`} onClick={() => toggle(fo.id)}>{open ? '▾' : '▸'}</button>
          <button type="button" className="rowMain folderName" onClick={() => ws.setView({ kind: 'folder', id: fo.id })}><span className="folderIcon" aria-hidden>▤</span><span className="rowName">{fo.name}</span></button>
          <Menu label={`More for ${fo.name}`} items={[
            ['New request', () => ws.startNew(c.id, fo.id)],
            ['New subfolder', async () => { const n = await ask('New folder'); if (n) await ws.addFolder(c.id, n, fo.id) }],
            ['Run folder…', () => ws.setView({ kind: 'runner', collectionId: c.id, folderId: fo.id })],
            ['Rename', async () => { const n = await ask('Rename folder', fo.name); if (n) await ws.updateFolder({ ...fo, name: n }) }],
            ['Delete', async () => { if (await confirm(`Delete folder “${fo.name}” and everything in it?`)) await ws.removeFolder(fo.id) }, 'danger'],
          ]} />
        </div>
        {open && <ul>{kids}{!kids.length && <li className="muted small pad">Empty folder.</li>}</ul>}
      </li>
    )
  }

  const loose = ws.requests.filter((r) => !r.collectionId && match(r)).sort(byName)

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
            const kids = children(c, null)
            if (f && !kids.length && !c.name.toLowerCase().includes(f)) return null
            const open = !closed.has(c.id) || !!f
            return (
              <li key={c.id} className="folder">
                <div className={`row ${ws.view.kind === 'collection' && ws.view.id === c.id ? 'on' : ''}`}>
                  <button type="button" className="caret" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${c.name}`} onClick={() => toggle(c.id)}>{open ? '▾' : '▸'}</button>
                  <button type="button" className="rowMain folderName" onClick={() => ws.setView({ kind: 'collection', id: c.id })}>{c.name}</button>
                  <button type="button" className="icon" aria-label={`New request in ${c.name}`} title="New request here" onClick={() => ws.startNew(c.id)}>+</button>
                  <Menu label={`More for ${c.name}`} items={[
                    ['New request', () => ws.startNew(c.id)],
                    ['New folder', async () => { const n = await ask('New folder'); if (n) await ws.addFolder(c.id, n) }],
                    ['Run collection…', () => ws.setView({ kind: 'runner', collectionId: c.id, folderId: null })],
                    ['View docs', () => ws.setView({ kind: 'docs', collectionId: c.id })],
                    ['Mock server…', () => ws.setView({ kind: 'mock', collectionId: c.id })],
                    ['Rename', async () => { const n = await ask('Rename collection', c.name); if (n) await ws.updateCollection({ ...c, name: n }) }],
                    ['Export collection', () => onExportCollection(c)],
                    ['Delete', async () => { if (await confirm(`Delete “${c.name}” and everything in it? This can’t be undone.`)) await ws.removeCollection(c.id) }, 'danger'],
                  ]} />
                </div>
                {open && <ul>{kids}{!kids.length && <li className="muted small pad">No requests yet.</li>}</ul>}
              </li>
            )
          })}
          {loose.length > 0 && <li className="folder"><div className="row label muted small">Not in a collection</div><ul>{loose.map(reqRow)}</ul></li>}
          {!ws.collections.length && !loose.length && (
            <li className="muted small pad">Saved requests show up here. Make a request and press Save, or import a Postman collection or OpenAPI file from the menu.</li>
          )}
        </ul>
        <div className="sideFoot">
          <button type="button" className="btn small ghost" onClick={() => ws.setView({ kind: 'runner', collectionId: null, folderId: null })}>▶ Runner</button>
          <button type="button" className="btn small ghost" onClick={() => ws.setView({ kind: 'load', requestId: null })}>⚡ Load test</button>
        </div>
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
          <li className={`row ${ws.view.kind === 'globals' ? 'on' : ''}`}>
            <button type="button" className="rowMain" onClick={() => ws.setView({ kind: 'globals' })}>
              <span className="rowName">Globals</span><span className="muted tiny">{ws.globals.length} variable{ws.globals.length === 1 ? '' : 's'}, always on</span>
            </button>
          </li>
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
