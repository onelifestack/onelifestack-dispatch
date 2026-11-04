import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as db from '../core/db'
import type { Collection, Environment, Folder, HistoryEntry, HttpResponse, KV, LogLine, PreparedRequest, RequestDef, Settings, TestResult } from '../core/types'
import { defaultSettings, newCollection, newEnvironment, newFolder, newRequest, normalizeRequest, uid } from '../core/types'
import { prepare } from '../core/prepare'
import { type Transport, defaultTransport } from '../core/transport'
import type { Workspace } from '../core/backup'
import { type Execution, type Pipeline, type RunContext, execute, folderChain, prepareContext, sendOptions } from '../core/runtime'
import { type ScriptEngine, scriptPipeline } from '../core/scriptPipeline'
import { WorkerEngine } from '../core/workerEngine'

export type View =
  | { kind: 'request' }
  | { kind: 'collection'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'environment'; id: string }
  | { kind: 'globals' }
  | { kind: 'runner'; collectionId: string | null; folderId: string | null }
  | { kind: 'load'; requestId: string | null }

export interface Result {
  sent: PreparedRequest
  response: HttpResponse | null
  error: string | null
  tests: TestResult[]
}

export interface Tab {
  id: string
  draft: RequestDef
  result: Result | null
  sending: boolean
}

const same = (a: RequestDef, b: RequestDef) => JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 })
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
const LOG_LIMIT = 500
const newTab = (draft: RequestDef = newRequest()): Tab => ({ id: uid(), draft, result: null, sending: false })

/** All app state and actions. Saved data lives in IndexedDB; open tabs are drafts until saved. */
export interface WorkspaceOptions {
  transport?: Transport
  engine?: ScriptEngine
  /** Extra hooks merged after scripts (auth signing...). */
  extend?: (base: Pipeline, transport: Transport) => Pipeline
}

export function useWorkspace(opts: WorkspaceOptions = {}) {
  const [transport] = useState<Transport>(() => opts.transport ?? defaultTransport())
  const settingsRef = useRef<Settings>(defaultSettings)
  const [ready, setReady] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [requests, setRequests] = useState<RequestDef[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [globals, setGlobalsState] = useState<KV[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [settings, setSettingsState] = useState<Settings>(defaultSettings)
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()])
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id)
  const [view, setView] = useState<View>({ kind: 'request' })
  const [logs, setLogs] = useState<LogLine[]>([])
  const aborts = useRef(new Map<string, AbortController>())
  const [pipeline] = useState<Pipeline>(() => {
    const base = scriptPipeline({
      engine: opts.engine ?? new WorkerEngine(), transport,
      sendOptions: () => ({ timeoutMs: settingsRef.current.timeoutMs, followRedirects: settingsRef.current.followRedirects, insecureTls: settingsRef.current.insecureTls }),
    })
    return opts.extend ? opts.extend(base, transport) : base
  })
  const pipelineRef = useRef(pipeline)

  useEffect(() => {
    let live = true
    void (async () => {
      const [c, f, r, e, g, h, s, saved] = await Promise.all([
        db.listCollections(), db.listFolders(), db.listRequests(), db.listEnvironments(), db.getGlobals(), db.listHistory(), db.getSettings(),
        db.getMeta<{ tabs: RequestDef[]; active: number }>('tabs'),
      ])
      if (!live) return
      setCollections(c.sort(byName)); setFolders(f); setRequests(r); setEnvironments(e.sort(byName)); setGlobalsState(g)
      setHistory(h); setSettingsState(s)
      if (saved?.tabs?.length) {
        const restored = saved.tabs.map((d) => newTab(normalizeRequest(d)))
        setTabs(restored); setActiveId(restored[Math.min(saved.active, restored.length - 1)]?.id ?? restored[0].id)
      }
      setReady(true)
    })()
    return () => { live = false }
  }, [])

  // Open tabs survive a reload (drafts included).
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => { void db.putMeta('tabs', { tabs: tabs.map((x) => x.draft), active: Math.max(0, tabs.findIndex((x) => x.id === activeId)) }) }, 400)
    return () => clearTimeout(t)
  }, [tabs, activeId, ready])

  settingsRef.current = settings
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const draft = active.draft
  const savedOf = useCallback((d: RequestDef) => requests.find((r) => r.id === d.id) ?? null, [requests])
  const isDirty = useCallback((d: RequestDef) => {
    const s = savedOf(d)
    return s ? !same(s, d) : d.url.trim() !== '' || d.body.text !== '' || d.scripts.pre !== '' || d.scripts.post !== ''
  }, [savedOf])
  const saved = savedOf(draft)
  const dirty = isDirty(draft)
  const collection = collections.find((c) => c.id === draft.collectionId) ?? null
  const environment = environments.find((e) => e.id === settings.activeEnvId) ?? null
  const runContext = useCallback((d: RequestDef, extra: Partial<RunContext> = {}): RunContext => ({
    collection: collections.find((c) => c.id === d.collectionId) ?? null,
    folders, environment, globals, ...extra,
  }), [collections, folders, environment, globals])
  const prepared = useMemo(() => prepare(draft, prepareContext(runContext(draft), draft)), [draft, runContext])
  const chain = useMemo(() => folderChain(folders, draft.folderId), [folders, draft.folderId])

  const patchTab = useCallback((id: string, patch: Partial<Tab> | ((t: Tab) => Partial<Tab>)) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
  }, [])
  /** Edits the active tab's request. */
  const setDraft = useCallback((u: RequestDef | ((d: RequestDef) => RequestDef)) => {
    setTabs((ts) => ts.map((t) => (t.id === activeId ? { ...t, draft: typeof u === 'function' ? u(t.draft) : u } : t)))
  }, [activeId])

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => { const next = { ...s, ...patch }; void db.putSettings(next); return next })
  }, [])
  const log = useCallback((lines: LogLine[]) => { if (lines.length) setLogs((l) => [...l, ...lines].slice(-LOG_LIMIT)) }, [])

  /** Opens a request: switches to its tab if already open, otherwise opens a new tab (or reuses an empty one). */
  const openRequest = useCallback((r: RequestDef, result: Result | null = null) => {
    setView({ kind: 'request' })
    setTabs((ts) => {
      const open = ts.find((t) => t.draft.id === r.id)
      if (open) { setActiveId(open.id); return result ? ts.map((t) => (t.id === open.id ? { ...t, result } : t)) : ts }
      const tab = { ...newTab(structuredClone(r)), result }
      const cur = ts.find((t) => t.id === activeId)
      // Replace the current tab when it's an untouched new request.
      if (cur && !requests.some((x) => x.id === cur.draft.id) && !cur.draft.url && !cur.draft.body.text && !cur.result) {
        setActiveId(tab.id); return ts.map((t) => (t.id === cur.id ? tab : t))
      }
      setActiveId(tab.id); return [...ts, tab]
    })
  }, [activeId, requests])

  const startNew = useCallback((collectionId: string | null = null, folderId: string | null = null) => {
    const tab = newTab(newRequest({ collectionId, folderId }))
    setTabs((ts) => [...ts, tab]); setActiveId(tab.id); setView({ kind: 'request' })
  }, [])

  const closeTab = useCallback((id: string) => {
    aborts.current.get(id)?.abort()
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id)
      const rest = ts.filter((t) => t.id !== id)
      if (!rest.length) { const t = newTab(); setActiveId(t.id); return [t] }
      if (id === activeId) setActiveId(rest[Math.max(0, i - 1)].id)
      return rest
    })
  }, [activeId])

  const selectTab = useCallback((id: string) => { setActiveId(id); setView({ kind: 'request' }) }, [])

  const persistRequest = useCallback(async (r: RequestDef) => {
    await db.putRequest(r)
    setRequests((rs) => [...rs.filter((x) => x.id !== r.id), r])
  }, [])

  const saveDraft = useCallback(async (into?: { collectionId: string | null; folderId?: string | null; name: string }) => {
    const r: RequestDef = { ...draft, ...(into ?? {}), updatedAt: Date.now() }
    if (into && into.folderId === undefined) r.folderId = into.collectionId === draft.collectionId ? draft.folderId : null
    await persistRequest(r)
    setDraft(r)
    return r
  }, [draft, persistRequest, setDraft])

  const renameRequest = useCallback(async (r: RequestDef, name: string) => {
    await persistRequest({ ...r, name, updatedAt: Date.now() })
    setTabs((ts) => ts.map((t) => (t.draft.id === r.id ? { ...t, draft: { ...t.draft, name } } : t)))
  }, [persistRequest])

  const moveRequest = useCallback(async (r: RequestDef, collectionId: string | null, folderId: string | null) => {
    await persistRequest({ ...r, collectionId, folderId, updatedAt: Date.now() })
    setTabs((ts) => ts.map((t) => (t.draft.id === r.id ? { ...t, draft: { ...t.draft, collectionId, folderId } } : t)))
  }, [persistRequest])

  const removeRequest = useCallback(async (id: string) => {
    await db.deleteRequest(id)
    setRequests((rs) => rs.filter((r) => r.id !== id))
    // Open tabs keep the request as an unsaved draft.
    setTabs((ts) => ts.map((t) => (t.draft.id === id ? { ...t, draft: { ...t.draft, id: uid() } } : t)))
  }, [])

  const duplicateRequest = useCallback(async (r: RequestDef) => {
    const copy: RequestDef = { ...structuredClone(r), id: uid(), name: `${r.name} copy`, updatedAt: Date.now() }
    await persistRequest(copy)
    return copy
  }, [persistRequest])

  /** Saves variables changed by scripts. */
  const applyChanges = useCallback(async (x: Execution, ctx: RunContext) => {
    const { environment: env, collection: col, globals: glob } = x.changes
    if (env && ctx.environment) {
      const next = { ...ctx.environment, variables: env, updatedAt: Date.now() }
      setEnvironments((es) => es.map((e) => (e.id === next.id ? next : e))); await db.putEnvironment(next)
    }
    if (col && ctx.collection) {
      const next = { ...ctx.collection, variables: col, updatedAt: Date.now() }
      setCollections((cs) => cs.map((c) => (c.id === next.id ? next : c))); await db.putCollection(next)
    }
    if (glob) { setGlobalsState(glob); await db.putGlobals(glob) }
  }, [])

  const send = useCallback(async () => {
    const tab = active
    if (tab.sending) return
    const ctrl = new AbortController(); aborts.current.set(tab.id, ctrl)
    patchTab(tab.id, { sending: true })
    const ctx = runContext(tab.draft)
    const x = await execute(tab.draft, ctx, transport, sendOptions(tab.draft, settings, ctrl.signal), pipelineRef.current)
    aborts.current.delete(tab.id)
    patchTab(tab.id, { sending: false, result: { sent: x.sent, response: x.response, error: x.error, tests: x.tests } })
    log([...x.logs, {
      level: x.error ? 'error' : 'info', at: Date.now(), source: 'network',
      text: `${x.sent.method} ${x.sent.url} → ${x.response ? `${x.response.status} ${x.response.statusText} · ${x.response.timeMs} ms` : x.error}`,
    }])
    await applyChanges(x, ctx)
    let entry: HistoryEntry = { id: uid(), at: Date.now(), request: structuredClone(tab.draft), sent: x.sent, response: x.response, error: x.error, tests: x.tests }
    // Large bodies would bloat history; keep the first 256 KB and drop binary data.
    if (entry.response) entry = { ...entry, response: { ...entry.response, body: entry.response.body.slice(0, 262_144), base64: undefined } }
    await db.addHistory(entry)
    setHistory((h) => [entry, ...h].slice(0, db.HISTORY_LIMIT))
  }, [active, patchTab, runContext, transport, settings, log, applyChanges])

  const cancel = useCallback(() => aborts.current.get(active.id)?.abort(), [active.id])

  const openHistory = useCallback((h: HistoryEntry) => {
    // Opens as a fresh draft, so editing it never changes the saved request it came from.
    const tab = { ...newTab({ ...normalizeRequest(structuredClone(h.request)), id: uid() }), result: { sent: h.sent, response: h.response, error: h.error, tests: h.tests ?? [] } }
    setTabs((ts) => [...ts, tab]); setActiveId(tab.id); setView({ kind: 'request' })
  }, [])
  const clearHistory = useCallback(async () => { await db.clearHistory(); setHistory([]) }, [])

  const addCollection = useCallback(async (name: string) => {
    const c = newCollection(name); await db.putCollection(c)
    setCollections((cs) => [...cs, c].sort(byName))
    return c
  }, [])
  const updateCollection = useCallback(async (c: Collection) => {
    // State first so a request sent right after an edit already uses it; then persist.
    const next = { ...c, updatedAt: Date.now() }
    setCollections((cs) => cs.map((x) => (x.id === c.id ? next : x)))
    await db.putCollection(next)
  }, [])
  const removeCollection = useCallback(async (id: string) => {
    await db.deleteCollection(id)
    setCollections((cs) => cs.filter((c) => c.id !== id))
    setFolders((fs) => fs.filter((f) => f.collectionId !== id))
    setRequests((rs) => rs.filter((r) => r.collectionId !== id))
    setTabs((ts) => ts.map((t) => (t.draft.collectionId === id ? { ...t, draft: { ...t.draft, id: uid(), collectionId: null, folderId: null } } : t)))
    setView((v) => (v.kind === 'collection' && v.id === id ? { kind: 'request' } : v))
  }, [])

  const addFolder = useCallback(async (collectionId: string, name: string, parentId: string | null = null) => {
    const f = newFolder(collectionId, name, parentId); await db.putFolder(f)
    setFolders((fs) => [...fs, f])
    return f
  }, [])
  const updateFolder = useCallback(async (f: Folder) => {
    const next = { ...f, updatedAt: Date.now() }
    setFolders((fs) => fs.map((x) => (x.id === f.id ? next : x)))
    await db.putFolder(next)
  }, [])
  const removeFolder = useCallback(async (id: string) => {
    const ids = new Set([id])
    for (let grew = true; grew;) { grew = false; for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true } }
    await db.deleteFolders([...ids])
    setFolders((fs) => fs.filter((f) => !ids.has(f.id)))
    setRequests((rs) => rs.filter((r) => !r.folderId || !ids.has(r.folderId)))
    setTabs((ts) => ts.map((t) => (t.draft.folderId && ids.has(t.draft.folderId) ? { ...t, draft: { ...t.draft, id: uid(), folderId: null } } : t)))
    setView((v) => (v.kind === 'folder' && ids.has(v.id) ? { kind: 'request' } : v))
  }, [folders])

  const addEnvironment = useCallback(async (name: string) => {
    const e = newEnvironment(name); await db.putEnvironment(e)
    setEnvironments((es) => [...es, e].sort(byName))
    return e
  }, [])
  const updateEnvironment = useCallback(async (e: Environment) => {
    const next = { ...e, updatedAt: Date.now() }
    setEnvironments((es) => es.map((x) => (x.id === e.id ? next : x)))
    await db.putEnvironment(next)
  }, [])
  const removeEnvironment = useCallback(async (id: string) => {
    await db.deleteEnvironment(id)
    setEnvironments((es) => es.filter((e) => e.id !== id))
    setSettingsState((s) => { if (s.activeEnvId !== id) return s; const n = { ...s, activeEnvId: null }; void db.putSettings(n); return n })
    setView((v) => (v.kind === 'environment' && v.id === id ? { kind: 'request' } : v))
  }, [])
  const setGlobals = useCallback(async (g: KV[]) => { setGlobalsState(g); await db.putGlobals(g) }, [])

  const importWorkspace = useCallback(async (w: Workspace) => {
    await db.putMany(w)
    setCollections((cs) => [...cs, ...w.collections].sort(byName))
    setFolders((fs) => [...fs, ...w.folders])
    setRequests((rs) => [...rs, ...w.requests])
    setEnvironments((es) => [...es, ...w.environments].sort(byName))
    if (w.globals?.length) {
      const merged = [...globals, ...w.globals.filter((g) => !globals.some((x) => x.key === g.key))]
      await setGlobals(merged)
    }
  }, [globals, setGlobals])

  return {
    ready, transport, collections, folders, requests, environments, globals, history, settings, logs,
    tabs, activeId, active, draft, view, result: active.result, sending: active.sending, saved, dirty, isDirty,
    collection, environment, prepared, chain, runContext, pipeline: pipelineRef,
    setDraft, setView, setSettings, setLogs, log, openRequest, startNew, closeTab, selectTab, saveDraft, renameRequest,
    moveRequest, removeRequest, duplicateRequest, send, cancel, applyChanges, openHistory, clearHistory,
    addCollection, updateCollection, removeCollection, addFolder, updateFolder, removeFolder,
    addEnvironment, updateEnvironment, removeEnvironment, setGlobals, importWorkspace,
  }
}

export type WorkspaceApi = ReturnType<typeof useWorkspace>
