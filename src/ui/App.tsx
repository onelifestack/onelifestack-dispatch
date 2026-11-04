import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspace, type WorkspaceApi } from './useWorkspace'
import { useDialogs } from './Dialogs'
import { Sidebar } from './Sidebar'
import { RequestPane } from './RequestPane'
import { ResponsePane } from './ResponsePane'
import { CollectionEditor, EnvironmentEditor, FolderEditor, GlobalsEditor } from './Editors'
import { exportCollection, exportWorkspace, importFile, type ImportResult } from '../core/backup'
import { nameFromUrl } from '../core/curl'
import { withScheme } from '../core/url'
import type { Transport } from '../core/transport'
import { saveAnyFile, saveTextFile } from './files'
import { RunnerView } from './RunnerView'
import { LoadView } from './LoadView'
import type { Collection } from '../core/types'
import type { Pipeline } from '../core/runtime'
import type { ScriptEngine } from '../core/scriptPipeline'

const readText = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Couldn’t read that file.'))
  r.readAsText(file)
})

function Console({ ws, onClose }: { ws: WorkspaceApi; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [ws.logs.length])
  return (
    <section className="console" aria-label="Console">
      <div className="consoleHead">
        <strong>Console</strong><span className="muted small">script output and network log</span><span className="grow" />
        <button type="button" className="btn small ghost" onClick={() => ws.setLogs([])}>Clear</button>
        <button type="button" className="btn small ghost" aria-label="Close console" onClick={onClose}>×</button>
      </div>
      <div className="consoleBody mono" role="log">
        {ws.logs.map((l, i) => (
          <div key={i} className={`logLine ${l.level}`}>
            <span className="muted">{new Date(l.at).toLocaleTimeString()}</span>
            {l.source && <span className="logSrc">{l.source}</span>}
            <span className="logText">{l.text}</span>
          </div>
        ))}
        {!ws.logs.length && <p className="muted small">Nothing yet. <code>console.log()</code> in a script, or send a request.</p>}
        <div ref={end} />
      </div>
    </section>
  )
}

/** Other importers (OpenAPI, HAR) register here so App doesn't need to know them. */
export type Importer = (text: string, fileName: string) => ImportResult | null

function TabBar({ ws, onClose }: { ws: WorkspaceApi; onClose: (id: string) => void }) {
  return (
    <div className="tabBar" role="tablist" aria-label="Open requests">
      {ws.tabs.map((t) => {
        const on = t.id === ws.activeId && ws.view.kind === 'request'
        const dirty = ws.isDirty(t.draft)
        return (
          <div key={t.id} className={`reqTab ${on ? 'on' : ''}`}>
            <button type="button" role="tab" aria-selected={on} className="reqTabMain" onClick={() => ws.selectTab(t.id)} title={t.draft.url || t.draft.name}
              onAuxClick={(e) => { if (e.button === 1) onClose(t.id) }}>
              <span className={`mtag m-${t.draft.method}`}>{t.draft.method === 'DELETE' ? 'DEL' : t.draft.method === 'OPTIONS' ? 'OPT' : t.draft.method}</span>
              <span className="reqTabName">{t.draft.name}</span>
              {t.sending && <span className="spin" aria-label="sending" />}
            </button>
            <button type="button" className={`reqTabX ${dirty ? 'dirty' : ''}`} aria-label={`Close ${t.draft.name}`} onClick={() => onClose(t.id)}>{dirty ? '●' : '×'}</button>
          </div>
        )
      })}
      <button type="button" className="reqTabNew" aria-label="New tab" title="New request (Ctrl+T)" onClick={() => ws.startNew()}>+</button>
    </div>
  )
}

export interface AppExtras {
  /** Extra panels by view kind (runner, load test...). */
  views?: Partial<Record<'runner' | 'load', (ws: WorkspaceApi, notify: (m: string) => void) => React.ReactNode>>
  importers?: Importer[]
  extend?: (base: Pipeline, transport: Transport) => Pipeline
}

export function App({ transport, engine, extras = {} }: { transport?: Transport; engine?: ScriptEngine; extras?: AppExtras }) {
  const ws = useWorkspace({ transport, engine, extend: extras.extend })
  const { ask, confirm, askSave, askPlace, node: dialog } = useDialogs()
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const fileInput = useRef<HTMLInputElement>(null)
  const [consoleOpen, setConsoleOpen] = useState(false)

  const notify = useCallback((msg: string) => {
    setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), msg.length > 80 ? 8000 : 3500)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (ws.settings.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', ws.settings.theme)
  }, [ws.settings.theme])

  const save = useCallback(async () => {
    if (ws.saved) { await ws.saveDraft(); notify('Saved.'); return }
    // Name from the URL as written (/users/:id), not as filled in (/users/42).
    const suggested = ws.draft.name === 'New request' && ws.draft.url.trim() ? nameFromUrl(withScheme(ws.draft.url)) : ws.draft.name
    const choice = await askSave(suggested, ws.collections, ws.folders, ws.draft)
    if (!choice) return
    let collectionId = choice.collectionId
    if (choice.newCollection) collectionId = (await ws.addCollection(choice.newCollection)).id
    await ws.saveDraft({ collectionId, folderId: choice.folderId, name: choice.name })
    notify('Saved.')
  }, [ws, askSave, notify])

  const closeTab = useCallback(async (id: string) => {
    const t = ws.tabs.find((x) => x.id === id)
    if (t && ws.isDirty(t.draft) && !(await confirm(`Discard unsaved changes to “${t.draft.name}”?`))) return
    ws.closeTab(id)
  }, [ws, confirm])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && e.key === 'Enter') { e.preventDefault(); void ws.send() }
      else if (mod && k === 's') { e.preventDefault(); void save() }
      else if (mod && (k === 't' || (e.altKey && k === 'n'))) { e.preventDefault(); ws.startNew(ws.draft.collectionId, ws.draft.folderId) }
      else if (mod && k === 'w') { e.preventDefault(); void closeTab(ws.activeId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ws, save, closeTab])

  const onImport = async (file: File) => {
    try {
      const text = await readText(file)
      let r: ImportResult | null = null
      for (const imp of extras.importers ?? []) { r = imp(text, file.name); if (r) break }
      r ??= importFile(text)
      await ws.importWorkspace(r)
      const n = (x: number, w: string) => x && `${x} ${w}${x > 1 ? 's' : ''}`
      const what = [n(r.collections.length, 'collection'), n(r.folders.length, 'folder'), n(r.requests.length, 'request'), n(r.environments.length, 'environment')].filter(Boolean).join(', ')
      notify(`Imported ${what || 'nothing'}.${r.warnings.length ? ` ${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}: ${r.warnings.slice(0, 3).join(' ')}${r.warnings.length > 3 ? ' …' : ''}` : ''}`)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    }
  }

  const workspace = () => ({ collections: ws.collections, folders: ws.folders, requests: ws.requests, environments: ws.environments, globals: ws.globals })
  const onExport = async () => {
    try {
      if (await saveTextFile(`dispatch-backup-${new Date().toISOString().slice(0, 10)}.json`, exportWorkspace(workspace())))
        notify('Backup saved. It includes environment values (not secret ones), so keep it somewhere safe.')
    } catch (e) { notify(`Couldn’t save the backup: ${String(e)}`) }
  }
  const onExportCollection = async (c: Collection) => {
    try {
      if (await saveTextFile(`${c.name.replace(/[^\w.-]+/g, '-')}.dispatch.json`, exportCollection(workspace(), c.id))) notify(`Exported ${c.name}.`)
    } catch (e) { notify(`Couldn’t export: ${String(e)}`) }
  }

  const closeMenu = (e: React.MouseEvent) => { (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open') }

  if (!ws.ready) return <p className="loading">Opening…</p>

  const viewed = ws.view
  const col = viewed.kind === 'collection' ? ws.collections.find((c) => c.id === viewed.id) : undefined
  const folder = viewed.kind === 'folder' ? ws.folders.find((f) => f.id === viewed.id) : undefined
  const env = viewed.kind === 'environment' ? ws.environments.find((e) => e.id === viewed.id) : undefined
  const extraView = (viewed.kind === 'runner' || viewed.kind === 'load') ? extras.views?.[viewed.kind] : undefined
  const dialogs = { ask, confirm, pickPlace: (title: string, cur: { collectionId: string | null; folderId: string | null }) => askPlace(title, ws.collections, ws.folders, cur) }

  return (
    <div className="app">
      <header className="top">
        <span className="brand"><img src="./icon.svg" alt="" width="26" height="26" />Dispatch</span>
        <button type="button" className="btn small" onClick={() => ws.startNew(ws.draft.collectionId, ws.draft.folderId)}>+ New request</button>
        <span className="grow" />
        <label className="envPick">
          <span className="sr">Environment</span>
          <select value={ws.settings.activeEnvId ?? ''} onChange={(e) => ws.setSettings({ activeEnvId: e.target.value || null })}>
            <option value="">No environment</option>
            {ws.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <details className="menu">
          <summary className="btn small ghost" aria-label="Menu">☰</summary>
          <div className="menuList right" role="menu">
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); fileInput.current?.click() }}>Import (backup, Postman, OpenAPI, HAR)…</button>
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); void onExport() }}>Export backup</button>
            <hr />
            <label className="menuRow">Theme
              <select value={ws.settings.theme} onChange={(e) => ws.setSettings({ theme: e.target.value as 'system' | 'light' | 'dark' })}>
                <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
              </select>
            </label>
            <label className="menuRow">Timeout (s)
              <input type="number" min={1} max={600} value={Math.round(ws.settings.timeoutMs / 1000)}
                onChange={(e) => ws.setSettings({ timeoutMs: Math.min(600, Math.max(1, Number(e.target.value) || 30)) * 1000 })} />
            </label>
            <label className="menuRow"><input type="checkbox" checked={ws.settings.followRedirects} onChange={(e) => ws.setSettings({ followRedirects: e.target.checked })} /> Follow redirects</label>
            {ws.transport.unrestricted && <>
              <label className="menuRow"><input type="checkbox" checked={ws.settings.insecureTls} onChange={(e) => ws.setSettings({ insecureTls: e.target.checked })} /> Allow self-signed certificates</label>
              <label className="menuRow"><input type="checkbox" checked={ws.settings.cookieJar} onChange={(e) => ws.setSettings({ cookieJar: e.target.checked })} /> Keep cookies between requests</label>
            </>}
          </div>
        </details>
        <input ref={fileInput} type="file" accept="application/json,.json,.yaml,.yml,.har" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onImport(f) }} />
      </header>
      <Sidebar ws={ws} dialogs={dialogs} onExportCollection={(c) => void onExportCollection(c)} />
      <main className="work">
        {col ? <CollectionEditor key={col.id} ws={ws} confirm={confirm} collection={col} />
          : folder ? <FolderEditor key={folder.id} ws={ws} confirm={confirm} folder={folder} />
          : env ? <EnvironmentEditor key={env.id} ws={ws} confirm={confirm} environment={env} />
          : viewed.kind === 'globals' ? <GlobalsEditor ws={ws} />
          : viewed.kind === 'runner' ? <RunnerView key={`${viewed.collectionId}:${viewed.folderId}`} ws={ws} notify={notify} start={viewed.collectionId ? { collectionId: viewed.collectionId, folderId: viewed.folderId } : null} />
          : viewed.kind === 'load' ? <LoadView key={viewed.requestId ?? 'tab'} ws={ws} notify={notify} requestId={viewed.requestId} />
          : extraView ? extraView(ws, notify)
          : <>
              <TabBar ws={ws} onClose={(id) => void closeTab(id)} />
              <div className="split">
                <RequestPane ws={ws} onSave={save} notify={notify} />
                <ResponsePane ws={ws} notify={notify} saveFile={saveAnyFile} />
              </div>
            </>}
      </main>
      {consoleOpen && <Console ws={ws} onClose={() => setConsoleOpen(false)} />}
      <footer className="statusBar small">
        <button type="button" className="linkBtn" aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>
          Console{ws.logs.some((l) => l.level === 'error') ? ' ⚠' : ''} ({ws.logs.length})
        </button>
        <span>{ws.transport.unrestricted ? 'Desktop: sends directly, no CORS limits' : 'Browser: servers must allow this page (CORS)'}</span>
        <span className="grow" />
        <span>{ws.environment ? `Environment: ${ws.environment.name}` : 'No environment'}</span>
        <span>Saved on this device only</span>
      </footer>
      {toast && <div className="toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
      {dialog}
    </div>
  )
}
