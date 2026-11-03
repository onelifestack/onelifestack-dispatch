import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspace } from './useWorkspace'
import { useDialogs } from './Dialogs'
import { Sidebar } from './Sidebar'
import { RequestPane } from './RequestPane'
import { ResponsePane } from './ResponsePane'
import { CollectionEditor, EnvironmentEditor } from './Editors'
import { exportWorkspace, importFile } from '../core/backup'
import { nameFromUrl } from '../core/curl'
import { isDesktop, type Transport } from '../core/transport'

const readText = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Couldn’t read that file.'))
  r.readAsText(file)
})

export function App({ transport }: { transport?: Transport }) {
  const ws = useWorkspace(transport)
  const { ask, confirm, askSave, node: dialog } = useDialogs()
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const fileInput = useRef<HTMLInputElement>(null)

  const notify = useCallback((msg: string) => {
    setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), msg.length > 80 ? 8000 : 3500)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (ws.settings.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', ws.settings.theme)
  }, [ws.settings.theme])

  const save = useCallback(async () => {
    if (ws.saved) { await ws.saveDraft(); notify('Saved.'); return }
    const suggested = ws.draft.name === 'New request' && ws.prepared.url ? nameFromUrl(ws.prepared.url) : ws.draft.name
    const choice = await askSave(suggested, ws.collections, ws.draft.collectionId)
    if (!choice) return
    let collectionId = choice.collectionId
    if (choice.newCollection) collectionId = (await ws.addCollection(choice.newCollection)).id
    await ws.saveDraft({ collectionId, name: choice.name })
    notify('Saved.')
  }, [ws, askSave, notify])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'Enter') { e.preventDefault(); void ws.send() }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save() }
      else if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); ws.startNew(ws.draft.collectionId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ws, save])

  const newRequest = async () => {
    if (ws.dirty && !(await confirm('Discard unsaved changes to this request?'))) return
    ws.startNew(ws.draft.collectionId)
  }

  const onImport = async (file: File) => {
    try {
      const r = importFile(await readText(file))
      await ws.importWorkspace(r)
      const what = [
        r.collections.length && `${r.collections.length} collection${r.collections.length > 1 ? 's' : ''}`,
        r.requests.length && `${r.requests.length} request${r.requests.length > 1 ? 's' : ''}`,
        r.environments.length && `${r.environments.length} environment${r.environments.length > 1 ? 's' : ''}`,
      ].filter(Boolean).join(', ')
      notify(`Imported ${what || 'nothing'}.${r.warnings.length ? ` ${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}: ${r.warnings.slice(0, 3).join(' ')}${r.warnings.length > 3 ? ' …' : ''}` : ''}`)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e))
    }
  }

  const onExport = async () => {
    const text = exportWorkspace({ collections: ws.collections, requests: ws.requests, environments: ws.environments })
    const fileName = `dispatch-backup-${new Date().toISOString().slice(0, 10)}.json`
    const warning = 'It includes environment values, so keep it somewhere safe.'
    if (isDesktop()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        if (await invoke<boolean>('save_text_file', { fileName, contents: text })) notify(`Backup saved. ${warning}`)
      } catch (e) { notify(`Couldn’t save the backup: ${String(e)}`) }
      return
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = fileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    notify(`Backup downloaded. ${warning}`)
  }

  const closeMenu = (e: React.MouseEvent) => { (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open') }

  if (!ws.ready) return <p className="loading">Opening…</p>

  const viewed = ws.view
  const col = viewed.kind === 'collection' ? ws.collections.find((c) => c.id === viewed.id) : undefined
  const env = viewed.kind === 'environment' ? ws.environments.find((e) => e.id === viewed.id) : undefined

  return (
    <div className="app">
      <header className="top">
        <span className="brand"><img src="./icon.svg" alt="" width="26" height="26" />Dispatch</span>
        <button type="button" className="btn small" onClick={newRequest}>+ New request</button>
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
            <button type="button" role="menuitem" onClick={(e) => { closeMenu(e); fileInput.current?.click() }}>Import (Dispatch backup or Postman)…</button>
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
            {ws.transport.unrestricted && (
              <label className="menuRow"><input type="checkbox" checked={ws.settings.insecureTls} onChange={(e) => ws.setSettings({ insecureTls: e.target.checked })} /> Allow self-signed certificates</label>
            )}
          </div>
        </details>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onImport(f) }} />
      </header>
      <Sidebar ws={ws} ask={ask} confirm={confirm} />
      <main className="work">
        {col ? <CollectionEditor key={col.id} ws={ws} confirm={confirm} collection={col} />
          : env ? <EnvironmentEditor key={env.id} ws={ws} confirm={confirm} environment={env} />
          : <div className="split">
              <RequestPane ws={ws} onSave={save} notify={notify} />
              <ResponsePane ws={ws} notify={notify} />
            </div>}
      </main>
      <footer className="statusBar small">
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
