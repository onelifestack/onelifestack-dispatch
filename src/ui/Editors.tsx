import { useEffect, useState } from 'react'
import type { Auth, Collection, Environment, Folder, Scripts } from '../core/types'
import { KVTable } from './KVTable'
import { AuthEditor, authLabel } from './AuthEditor'
import { CodeArea } from './CodeArea'
import type { WorkspaceApi } from './useWorkspace'
import type { AuthActions } from './RequestPane'
import { effectiveAuth } from '../core/prepare'
import { folderChain } from '../core/runtime'
import { newRequest } from '../core/types'
import { toPostmanEnvironment } from '../core/interop'
import { saveTextFile } from './files'

/**
 * Edits save as you type, like settings, so there's no separate Save step to forget. Local state keeps typing
 * smooth; every change is also written straight away, so switching away never loses the last keystroke.
 */
function useSaved<T extends { id: string }>(value: T, save: (v: T) => Promise<void>) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return [local, (next: T) => { setLocal(next); void save(next) }] as const
}

interface Common { ws: WorkspaceApi; confirm: (msg: string) => Promise<boolean>; authActions?: AuthActions; renderDocs?: (md: string) => React.ReactNode }

function ScriptsEditor({ scripts, onChange, scope }: { scripts: Scripts; onChange: (s: Scripts) => void; scope: string }) {
  return <>
    <h2>Scripts</h2>
    <p className="muted small">Run for every request in this {scope}: before-request scripts run outer first (collection, folders, request); after-response scripts in the same order.</p>
    <div className="gqlGrid">
      <CodeArea lang="javascript" label={`${scope} pre-request script`} rows={8} value={scripts.pre} onChange={(pre) => onChange({ ...scripts, pre })} placeholder="// before every request" />
      <CodeArea lang="javascript" label={`${scope} post-response script`} rows={8} value={scripts.post} onChange={(post) => onChange({ ...scripts, post })} placeholder="// after every response" />
    </div>
  </>
}

function DocsEditor({ docs, onChange, render }: { docs: string; onChange: (d: string) => void; render?: (md: string) => React.ReactNode }) {
  const [edit, setEdit] = useState(!docs.trim())
  return <>
    <div className="row-h"><h2>Docs</h2>{render && docs.trim() && <button type="button" className="btn small ghost" onClick={() => setEdit(!edit)}>{edit ? 'Preview' : 'Edit'}</button>}</div>
    {edit || !render
      ? <CodeArea label="Docs (Markdown)" rows={8} value={docs} onChange={onChange} placeholder="Describe what this is for. Markdown works." mono={false} />
      : <div className="markdown">{render(docs)}</div>}
  </>
}

export function CollectionEditor({ ws, confirm, collection, authActions, renderDocs }: Common & { collection: Collection }) {
  const [c, setC] = useSaved(collection, ws.updateCollection)
  const count = ws.requests.filter((r) => r.collectionId === c.id).length
  return (
    <section className="editor" aria-label="Collection">
      <p className="eyebrow">Collection</p>
      <input className="titleInput" value={c.name} aria-label="Collection name" onChange={(e) => setC({ ...c, name: e.target.value })} />
      <p className="muted small">{count} saved request{count === 1 ? '' : 's'}. Changes save automatically.</p>
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => ws.setView({ kind: 'runner', collectionId: c.id, folderId: null })}>▶ Run collection</button>
        <button type="button" className="btn" onClick={() => ws.startNew(c.id)}>New request here</button>
        <button type="button" className="btn" onClick={() => ws.setView({ kind: 'docs', collectionId: c.id })}>View docs</button>
        <button type="button" className="btn" onClick={() => ws.setView({ kind: 'mock', collectionId: c.id })}>Mock server</button>
      </div>
      {ws.transport.unrestricted && <FilesSection ws={ws} c={c} setC={setC} />}
      <DocsEditor docs={c.docs} onChange={(docs) => setC({ ...c, docs })} render={renderDocs} />
      <h2>Auth</h2>
      <p className="muted small">Requests and folders set to “Inherit from parent” use this.</p>
      <AuthEditor auth={c.auth} allowInherit={false} onChange={(auth) => setC({ ...c, auth })}
        onGetToken={authActions ? () => authActions.getToken(c.auth, (auth: Auth) => setC({ ...c, auth })) : undefined} gettingToken={authActions?.gettingToken} />
      <h2>Variables</h2>
      <p className="muted small">Available to every request in this collection as <code>{'{{name}}'}</code>. The active environment overrides them. Secret values are hidden and left out of backups.</p>
      <KVTable label="Collection variables" keyPlaceholder="Variable" allowSecrets rows={c.variables} onChange={(variables) => setC({ ...c, variables })} />
      <ScriptsEditor scope="collection" scripts={c.scripts} onChange={(scripts) => setC({ ...c, scripts })} />
      <div className="actions">
        <button type="button" className="btn danger" onClick={async () => {
          if (await confirm(`Delete “${c.name}” and its ${count} request${count === 1 ? '' : 's'}? This can’t be undone.`)) await ws.removeCollection(c.id)
        }}>Delete collection</button>
      </div>
    </section>
  )
}

/** Desktop: keep the collection as files in a folder (for git). */
function FilesSection({ ws, c, setC }: { ws: WorkspaceApi; c: Collection; setC: (c: Collection) => void }) {
  const [note, setNote] = useState<string | null>(null)
  return <>
    <h2>Files</h2>
    {c.linkedDir ? <>
      <p className="small">Saved as files in <code>{c.linkedDir}</code>. Changes are written there as you work, ready to commit with git.</p>
      <div className="actions">
        <button type="button" className="btn small" onClick={async () => {
          const { readCollectionDir } = await import('./linkedDirs')
          try { const r = await readCollectionDir(ws, c.linkedDir); await ws.replaceCollection(r); setNote(`Reloaded ${r.requests.length} requests from the folder.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`) } catch (e) { setNote(String(e)) }
        }}>Reload from folder</button>
        <button type="button" className="btn small ghost" onClick={() => { setC({ ...c, linkedDir: '' }); setNote('Unlinked; the files stay where they are.') }}>Unlink</button>
      </div>
    </> : <>
      <p className="muted small">Keep this collection as a folder of YAML files (one per request) so it can live in a git repo and be reviewed in pull requests. Literal secrets are never written; use <code>{'{{variables}}'}</code>.</p>
      <div className="actions">
        <button type="button" className="btn small" onClick={async () => {
          const { pickFolder, writeCollectionDir } = await import('./linkedDirs')
          try {
            const dir = await pickFolder(); if (!dir) return
            const left = await writeCollectionDir(ws, c, dir)
            setC({ ...c, linkedDir: dir })
            setNote(left.length ? `Saved. Literal secrets in ${left.join(', ')} weren’t written to the files; move them into variables.` : 'Saved to the folder.')
          } catch (e) { setNote(String(e)) }
        }}>Save to a folder…</button>
      </div>
    </>}
    {note && <p className="small muted">{note}</p>}
  </>
}

export function FolderEditor({ ws, confirm, folder, authActions, renderDocs }: Common & { folder: Folder }) {
  const [f, setF] = useSaved(folder, ws.updateFolder)
  const col = ws.collections.find((c) => c.id === f.collectionId) ?? null
  const parents = folderChain(ws.folders, f.parentId)
  const inherited = effectiveAuth(newRequest({ collectionId: f.collectionId }), col, parents)
  const count = ws.requests.filter((r) => r.folderId === f.id).length
  return (
    <section className="editor" aria-label="Folder">
      <p className="eyebrow">{[col?.name, ...parents.map((p) => p.name).reverse()].filter(Boolean).join(' / ')} / Folder</p>
      <input className="titleInput" value={f.name} aria-label="Folder name" onChange={(e) => setF({ ...f, name: e.target.value })} />
      <p className="muted small">{count} request{count === 1 ? '' : 's'} directly inside. Changes save automatically.</p>
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => ws.setView({ kind: 'runner', collectionId: f.collectionId, folderId: f.id })}>▶ Run folder</button>
        <button type="button" className="btn" onClick={() => ws.startNew(f.collectionId, f.id)}>New request here</button>
      </div>
      <DocsEditor docs={f.docs} onChange={(docs) => setF({ ...f, docs })} render={renderDocs} />
      <h2>Auth</h2>
      <AuthEditor auth={f.auth} allowInherit onChange={(auth) => setF({ ...f, auth })}
        inheritedHint={inherited ? `Inherits ${authLabel(inherited.kind).toLowerCase()} from above.` : 'Nothing above sets auth.'}
        onGetToken={authActions ? () => authActions.getToken(f.auth, (auth: Auth) => setF({ ...f, auth })) : undefined} gettingToken={authActions?.gettingToken} />
      <ScriptsEditor scope="folder" scripts={f.scripts} onChange={(scripts) => setF({ ...f, scripts })} />
      <div className="actions">
        <button type="button" className="btn danger" onClick={async () => { if (await confirm(`Delete folder “${f.name}” and everything in it?`)) await ws.removeFolder(f.id) }}>Delete folder</button>
      </div>
    </section>
  )
}

export function EnvironmentEditor({ ws, confirm, environment }: Common & { environment: Environment }) {
  const [e, setE] = useSaved(environment, ws.updateEnvironment)
  // Scripts may change variables while this is open; pick those up.
  useEffect(() => { if (JSON.stringify(environment.variables) !== JSON.stringify(e.variables)) setE({ ...e, variables: environment.variables }) }, [environment.variables]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = ws.settings.activeEnvId === e.id
  return (
    <section className="editor" aria-label="Environment">
      <p className="eyebrow">Environment</p>
      <input className="titleInput" value={e.name} aria-label="Environment name" onChange={(ev) => setE({ ...e, name: ev.target.value })} />
      <p className="muted small">Changes save automatically. Values stay on this device; secret values are left out of backups.</p>
      <div className="actions">
        <button type="button" className={`btn ${active ? '' : 'primary'}`} onClick={() => ws.setSettings({ activeEnvId: active ? null : e.id })}>
          {active ? 'Stop using' : 'Use this environment'}
        </button>
      </div>
      <h2>Variables</h2>
      <KVTable label="Environment variables" keyPlaceholder="Variable" allowSecrets rows={e.variables} onChange={(variables) => setE({ ...e, variables })} />
      <div className="actions">
        <button type="button" className="btn" onClick={async () => { await saveTextFile(`${e.name.replace(/[^\w.-]+/g, '-')}.postman_environment.json`, toPostmanEnvironment(e)) }}>Export as Postman environment</button>
        <button type="button" className="btn danger" onClick={async () => { if (await confirm(`Delete environment “${e.name}”?`)) await ws.removeEnvironment(e.id) }}>Delete environment</button>
      </div>
    </section>
  )
}

export function GlobalsEditor({ ws }: { ws: WorkspaceApi }) {
  return (
    <section className="editor" aria-label="Globals">
      <p className="eyebrow">Globals</p>
      <h1 className="titleInput">Global variables</h1>
      <p className="muted small">Available to every request, whatever the environment. Collections and environments override them.</p>
      <KVTable label="Global variables" keyPlaceholder="Variable" allowSecrets rows={ws.globals} onChange={(g) => void ws.setGlobals(g)} />
    </section>
  )
}
