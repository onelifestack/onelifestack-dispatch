import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as db from '../core/db'
import type { Collection, Environment, Folder, HistoryEntry, HttpResponse, KV, LogLine, PreparedRequest, RequestDef, Settings, TestResult } from '../core/types'
import { DEFAULT_SPACE, type Space, bySort, defaultSettings, newCollection, newEnvironment, newFolder, newRequest, normalizeRequest, spaceOf, uid } from '../core/types'
import { prepare } from '../core/prepare'
import { CookieTransport, type Transport, defaultTransport, isDesktop } from '../core/transport'
import { browserHook } from '../core/browserPipeline'
import type { BrowserLauncher } from '../core/browser'
import { desktopLauncher } from './desktopBrowser'
import { CookieJar } from '../core/cookies'
import type { Workspace } from '../core/backup'
import { type Execution, type Pipeline, type RunContext, execute, folderChain, prepareContext, sendOptions } from '../core/runtime'
import { type ScriptEngine, scriptPipeline } from '../core/scriptPipeline'
import { WorkerEngine } from '../core/workerEngine'
import { FAKE } from '../core/fake'
import { authPipeline } from '../core/auth'

export type View =
  | { kind: 'request' }
  | { kind: 'collection'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'environment'; id: string }
  | { kind: 'globals' }
  | { kind: 'runner'; collectionId: string | null; folderId: string | null }
  | { kind: 'load'; requestId: string | null }
  | { kind: 'docs'; collectionId: string }
  | { kind: 'mock'; collectionId: string }
  | { kind: 'backups' }
  | { kind: 'settings' }
  | { kind: 'cookies' }
  | { kind: 'schedules' }
  | { kind: 'spaces' }

export interface Result {
  sent: PreparedRequest
  response: HttpResponse | null
  error: string | null
  tests: TestResult[]
  visualizer?: { html: string }
  browser?: import('../core/browser').BrowserRunResult
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
  browserLauncher?: BrowserLauncher
  /** Extra hooks merged after scripts (auth signing...). */
  extend?: (base: Pipeline, transport: Transport) => Pipeline
}

export function useWorkspace(opts: WorkspaceOptions = {}) {
  const settingsRef = useRef<Settings>(defaultSettings)
  // On desktop, cookies from responses go back on later requests (the browser does this itself on the web).
  const [transport] = useState<Transport>(() => {
    const t = opts.transport ?? defaultTransport()
    return t.unrestricted && !opts.transport ? new CookieTransport(t, new CookieJar(), () => settingsRef.current.cookieJar) : t
  })
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
  /** Recently deleted things, newest last, so a delete can be undone. */
  const [trash, setTrash] = useState<{ label: string; data: Workspace }[]>([])
  const [backups, setBackups] = useState<db.BackupInfo[]>([])
  const [spaces, setSpacesState] = useState<Space[]>([DEFAULT_SPACE])
  const aborts = useRef(new Map<string, AbortController>())
  const [pipeline] = useState<Pipeline>(() => {
    const sendOpts = () => ({ timeoutMs: settingsRef.current.timeoutMs, followRedirects: settingsRef.current.followRedirects, insecureTls: settingsRef.current.insecureTls })
    const scripted = authPipeline(scriptPipeline({ engine: opts.engine ?? new WorkerEngine(), transport, sendOptions: sendOpts }), transport, sendOpts)
    // Browser login steps need a browser the app can start: the desktop app (or a launcher passed in, for tests).
    const launcher = opts.browserLauncher ?? (isDesktop() ? desktopLauncher : null)
    const base: Pipeline = launcher ? { ...scripted, browser: browserHook(launcher, () => (transport instanceof CookieTransport ? transport.jar : null)) } : scripted
    return opts.extend ? opts.extend(base, transport) : base
  })
  const pipelineRef = useRef(pipeline)

  useEffect(() => {
    let live = true
    void (async () => {
      const [c, f, r, e, g, h, s, saved] = await Promise.all([
        db.listCollections(), db.listFolders(), db.listRequests(), db.listEnvironments(), db.getGlobals(), db.listHistory(), db.getSettings(),
        db.getOpenTabs(),
      ])
      if (!live) return
      setCollections(c.sort(byName)); setFolders(f); setRequests(r); setEnvironments(e.sort(byName)); setGlobalsState(g)
      setHistory(h); setSettingsState(s)
      setSpacesState(await db.getSpaces())
      if (transport instanceof CookieTransport) {
        transport.jar.load(await db.getCookies() as never[])
        let timer: ReturnType<typeof setTimeout> | undefined
        transport.jar.onChange = () => { clearTimeout(timer); timer = setTimeout(() => { void db.putCookies(transport.jar.entries()) }, 300) }
      }
      // A daily backup, taken quietly when the app opens.
      void (async () => {
        let list = await db.listBackups()
        if (!list.length || Date.now() - list[0].at > 24 * 3600_000) {
          if (c.length || r.length || e.length) { await db.addBackup({ collections: c, folders: f, requests: r, environments: e, globals: g }, 'daily'); list = await db.listBackups() }
        }
        if (live) setBackups(list)
      })()
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
    const t = setTimeout(() => { void db.putOpenTabs(tabs.map((x) => x.draft), Math.max(0, tabs.findIndex((x) => x.id === activeId))) }, 400)
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
  /** Variable names for "{{" completion: what's in scope for the open request, then the fake-data generators. */
  const variableNames = useCallback(() => {
    const out = new Map<string, string>()
    const add = (rows: KV[] | undefined, from: string) => rows?.forEach((v) => { if (v.enabled && v.key.trim()) out.set(v.key.trim(), v.secret ? `${from} · secret` : `${from} · ${v.value.slice(0, 30)}`) })
    add(globals, 'globals'); add(collection?.variables, 'collection'); add(environment?.variables, environment?.name ?? 'environment')
    return [...[...out].map(([name, detail]) => ({ name, detail })), ...Object.keys(FAKE).map((name) => ({ name, detail: 'generated' }))]
  }, [globals, collection, environment])
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

  const toTrash = useCallback((label: string, data: Partial<Workspace>) => {
    setTrash((t) => [...t, { label, data: { collections: [], folders: [], requests: [], environments: [], ...data } }].slice(-20))
  }, [])

  const removeRequest = useCallback(async (id: string) => {
    const r = requests.find((x) => x.id === id)
    await db.deleteRequest(id)
    setRequests((rs) => rs.filter((x) => x.id !== id))
    if (r) toTrash(`“${r.name}”`, { requests: [r] })
    // Open tabs keep the request as an unsaved draft.
    setTabs((ts) => ts.map((t) => (t.draft.id === id ? { ...t, draft: { ...t.draft, id: uid() } } : t)))
  }, [requests, toTrash])

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

  /** Saves OAuth tokens refreshed during a send back to the request, folder or collection that owns the auth. */
  const applyAuthUpdate = useCallback(async (u: NonNullable<Execution['authUpdate']>) => {
    if (u.owner === 'request') {
      setTabs((ts) => ts.map((t) => (t.draft.id === u.id ? { ...t, draft: { ...t.draft, auth: { ...t.draft.auth, ...u.patch } } } : t)))
      const savedReq = requests.find((r) => r.id === u.id)
      if (savedReq) { const next = { ...savedReq, auth: { ...savedReq.auth, ...u.patch } }; await db.putRequest(next); setRequests((rs) => rs.map((r) => (r.id === u.id ? next : r))) }
    } else if (u.owner === 'folder') {
      const f = folders.find((x) => x.id === u.id)
      if (f) { const next = { ...f, auth: { ...f.auth, ...u.patch } }; setFolders((fs) => fs.map((x) => (x.id === u.id ? next : x))); await db.putFolder(next) }
    } else {
      const c = collections.find((x) => x.id === u.id)
      if (c) { const next = { ...c, auth: { ...c.auth, ...u.patch } }; setCollections((cs) => cs.map((x) => (x.id === u.id ? next : x))); await db.putCollection(next) }
    }
  }, [requests, folders, collections])

  const send = useCallback(async () => {
    const tab = active
    if (tab.sending) return
    const ctrl = new AbortController(); aborts.current.set(tab.id, ctrl)
    patchTab(tab.id, { sending: true })
    const ctx = runContext(tab.draft)
    const x = await execute(tab.draft, ctx, transport, sendOptions(tab.draft, settings, ctrl.signal), pipelineRef.current)
    aborts.current.delete(tab.id)
    patchTab(tab.id, { sending: false, result: { sent: x.sent, response: x.response, error: x.error, tests: x.tests, visualizer: x.visualizer, browser: x.browser } })
    log([...x.logs, {
      level: x.error ? 'error' : 'info', at: Date.now(), source: 'network',
      text: `${x.sent.method} ${x.sent.url} → ${x.response ? `${x.response.status} ${x.response.statusText} · ${x.response.timeMs} ms` : x.error}`,
    }])
    await applyChanges(x, ctx)
    if (x.authUpdate) await applyAuthUpdate(x.authUpdate)
    let entry: HistoryEntry = { id: uid(), at: Date.now(), request: structuredClone(tab.draft), sent: x.sent, response: x.response, error: x.error, tests: x.tests }
    // Large bodies would bloat history; keep the first 256 KB and drop binary data.
    if (entry.response) entry = { ...entry, response: { ...entry.response, body: entry.response.body.slice(0, 262_144), base64: undefined } }
    await db.addHistory(entry)
    setHistory((h) => [entry, ...h].slice(0, db.HISTORY_LIMIT))
  }, [active, patchTab, runContext, transport, settings, log, applyChanges, applyAuthUpdate])

  const cancel = useCallback(() => aborts.current.get(active.id)?.abort(), [active.id])

  const openHistory = useCallback((h: HistoryEntry) => {
    // Opens as a fresh draft, so editing it never changes the saved request it came from.
    const tab = { ...newTab({ ...normalizeRequest(structuredClone(h.request)), id: uid() }), result: { sent: h.sent, response: h.response, error: h.error, tests: h.tests ?? [] } }
    setTabs((ts) => [...ts, tab]); setActiveId(tab.id); setView({ kind: 'request' })
  }, [])
  const clearHistory = useCallback(async () => { await db.clearHistory(); setHistory([]) }, [])

  const addCollection = useCallback(async (name: string) => {
    const c = { ...newCollection(name), workspaceId: settingsRef.current.activeSpaceId }; await db.putCollection(c)
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
    const c = collections.find((x) => x.id === id)
    const gone = c ? { collections: [c], folders: folders.filter((f) => f.collectionId === id), requests: requests.filter((r) => r.collectionId === id) } : null
    await db.deleteCollection(id)
    setCollections((cs) => cs.filter((c) => c.id !== id))
    setFolders((fs) => fs.filter((f) => f.collectionId !== id))
    setRequests((rs) => rs.filter((r) => r.collectionId !== id))
    setTabs((ts) => ts.map((t) => (t.draft.collectionId === id ? { ...t, draft: { ...t.draft, id: uid(), collectionId: null, folderId: null } } : t)))
    setView((v) => (v.kind === 'collection' && v.id === id ? { kind: 'request' } : v))
    if (c && gone) toTrash(`“${c.name}”`, gone)
  }, [collections, folders, requests, toTrash])

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
    const top = folders.find((f) => f.id === id)
    const gone = { folders: folders.filter((f) => ids.has(f.id)), requests: requests.filter((r) => r.folderId && ids.has(r.folderId)) }
    await db.deleteFolders([...ids])
    setFolders((fs) => fs.filter((f) => !ids.has(f.id)))
    setRequests((rs) => rs.filter((r) => !r.folderId || !ids.has(r.folderId)))
    setTabs((ts) => ts.map((t) => (t.draft.folderId && ids.has(t.draft.folderId) ? { ...t, draft: { ...t.draft, id: uid(), folderId: null } } : t)))
    setView((v) => (v.kind === 'folder' && ids.has(v.id) ? { kind: 'request' } : v))
    if (top) toTrash(`“${top.name}”`, gone)
  }, [folders, requests, toTrash])

  const addEnvironment = useCallback(async (name: string) => {
    const e = { ...newEnvironment(name), workspaceId: settingsRef.current.activeSpaceId }; await db.putEnvironment(e)
    setEnvironments((es) => [...es, e].sort(byName))
    return e
  }, [])
  const updateEnvironment = useCallback(async (e: Environment) => {
    const next = { ...e, updatedAt: Date.now() }
    setEnvironments((es) => es.map((x) => (x.id === e.id ? next : x)))
    await db.putEnvironment(next)
  }, [])
  const removeEnvironment = useCallback(async (id: string) => {
    const e = environments.find((x) => x.id === id)
    await db.deleteEnvironment(id)
    setEnvironments((es) => es.filter((e) => e.id !== id))
    setSettingsState((s) => { if (s.activeEnvId !== id) return s; const n = { ...s, activeEnvId: null }; void db.putSettings(n); return n })
    setView((v) => (v.kind === 'environment' && v.id === id ? { kind: 'request' } : v))
    if (e) toTrash(`“${e.name}”`, { environments: [e] })
  }, [environments, toTrash])
  /** Copies an environment (values included, secrets too: it stays on this device) as "<name> copy". */
  const duplicateEnvironment = useCallback(async (e: Environment) => {
    const copy: Environment = { ...structuredClone(e), id: uid(), name: `${e.name} copy`, updatedAt: Date.now(), variables: e.variables.map((v) => ({ ...v, id: uid() })) }
    await db.putEnvironment(copy)
    setEnvironments((es) => [...es, copy].sort(byName))
    return copy
  }, [])
  const setGlobals = useCallback(async (g: KV[]) => { setGlobalsState(g); await db.putGlobals(g) }, [])

  const importWorkspace = useCallback(async (w0: Workspace) => {
    // Imports land in the workspace you're looking at (unless they name one that exists here).
    const here = settingsRef.current.activeSpaceId
    const known = (id?: string) => !!id && spaces.some((x) => x.id === id)
    const w: Workspace = {
      ...w0,
      collections: w0.collections.map((c) => (known(c.workspaceId) && c.workspaceId !== DEFAULT_SPACE.id ? c : { ...c, workspaceId: here })),
      environments: w0.environments.map((e) => (known(e.workspaceId) && e.workspaceId !== DEFAULT_SPACE.id ? e : { ...e, workspaceId: here })),
    }
    await db.putMany(w)
    setCollections((cs) => [...cs, ...w.collections].sort(byName))
    setFolders((fs) => [...fs, ...w.folders])
    setRequests((rs) => [...rs, ...w.requests])
    setEnvironments((es) => [...es, ...w.environments].sort(byName))
    if (w.globals?.length) {
      const merged = [...globals, ...w.globals.filter((g) => !globals.some((x) => x.key === g.key))]
      await setGlobals(merged)
    }
  }, [globals, setGlobals, spaces])

  // ---------- workspaces ----------
  const activeSpaceId = spaces.some((x) => x.id === settings.activeSpaceId) ? settings.activeSpaceId : DEFAULT_SPACE.id
  const visibleCollections = useMemo(() => collections.filter((c) => spaceOf(c) === activeSpaceId), [collections, activeSpaceId])
  const visibleEnvironments = useMemo(() => environments.filter((e) => spaceOf(e) === activeSpaceId), [environments, activeSpaceId])
  const saveSpaces = useCallback(async (next: Space[]) => { setSpacesState(next); await db.putSpaces(next) }, [])
  /** Shows another workspace, and picks up the environment last used there. */
  const switchSpace = useCallback((id: string) => {
    const s = settingsRef.current
    const remembered = s.spaceEnv[id] ?? null
    const env = remembered && environments.some((e) => e.id === remembered && spaceOf(e) === id) ? remembered : null
    setSettings({ activeSpaceId: id, activeEnvId: env, spaceEnv: { ...s.spaceEnv, [s.activeSpaceId]: s.activeEnvId } })
    setView({ kind: 'request' })
  }, [environments, setSettings])
  const addSpace = useCallback(async (name: string) => {
    const sp = { id: uid(), name }
    await saveSpaces([...spaces, sp])
    return sp
  }, [spaces, saveSpaces])
  const renameSpace = useCallback((id: string, name: string) => saveSpaces(spaces.map((x) => (x.id === id ? { ...x, name } : x))), [spaces, saveSpaces])
  /** Only empty workspaces can be removed (move or delete their collections and environments first). */
  const removeSpace = useCallback(async (id: string) => {
    if (id === DEFAULT_SPACE.id || collections.some((c) => spaceOf(c) === id) || environments.some((e) => spaceOf(e) === id)) return false
    await saveSpaces(spaces.filter((x) => x.id !== id))
    if (settingsRef.current.activeSpaceId === id) switchSpace(DEFAULT_SPACE.id)
    return true
  }, [collections, environments, spaces, saveSpaces, switchSpace])
  const moveToSpace = useCallback(async (kind: 'collection' | 'environment', id: string, spaceId: string) => {
    if (kind === 'collection') {
      const c = collections.find((x) => x.id === id); if (c) await updateCollection({ ...c, workspaceId: spaceId })
    } else {
      const e = environments.find((x) => x.id === id); if (!e) return
      await updateEnvironment({ ...e, workspaceId: spaceId })
      if (settingsRef.current.activeEnvId === id) setSettings({ activeEnvId: null })
    }
  }, [collections, environments, updateCollection, updateEnvironment, setSettings])

  /**
   * Moves requests and folders under a parent (a collection's top level, or a folder), placed before `beforeId`
   * (a sibling request or folder) or at the end. Siblings are renumbered so the order is exact. Folders carry their
   * contents along, also to another collection. A folder can't move into itself or its own subfolders.
   */
  const placeItems = useCallback(async (items: { kind: 'request' | 'folder'; id: string }[], parent: { collectionId: string; folderId: string | null }, beforeId: string | null = null) => {
    const descendants = (fid: string) => {
      const ids = new Set([fid])
      for (let grew = true; grew;) { grew = false; for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true } }
      return ids
    }
    if (parent.folderId && items.some((i) => i.kind === 'folder' && descendants(i.id).has(parent.folderId!))) return false
    const moving = new Set(items.map((i) => i.id))
    let nextFolders = folders.map((f) => ({ ...f }))
    let nextRequests = requests.map((r) => ({ ...r }))
    // Re-parent.
    for (const it of items) {
      if (it.kind === 'request') nextRequests = nextRequests.map((r) => (r.id === it.id ? { ...r, collectionId: parent.collectionId, folderId: parent.folderId } : r))
      else {
        const ids = descendants(it.id)
        nextFolders = nextFolders.map((f) => (f.id === it.id ? { ...f, collectionId: parent.collectionId, parentId: parent.folderId } : ids.has(f.id) ? { ...f, collectionId: parent.collectionId } : f))
        nextRequests = nextRequests.map((r) => (r.folderId && ids.has(r.folderId) ? { ...r, collectionId: parent.collectionId } : r))
      }
    }
    // Renumber the new siblings with the moved items placed before `beforeId`.
    const siblings = [
      ...nextFolders.filter((f) => f.collectionId === parent.collectionId && f.parentId === parent.folderId).map((f) => ({ kind: 'folder' as const, id: f.id, sort: f.sort, name: f.name })),
      ...nextRequests.filter((r) => r.collectionId === parent.collectionId && (r.folderId ?? null) === parent.folderId).map((r) => ({ kind: 'request' as const, id: r.id, sort: r.sort, name: r.name })),
    ].sort(bySort)
    const rest = siblings.filter((x) => !moving.has(x.id))
    const moved = items.map((i) => siblings.find((x) => x.id === i.id)!).filter(Boolean)
    const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1
    const ordered = at >= 0 ? [...rest.slice(0, at), ...moved, ...rest.slice(at)] : [...rest, ...moved]
    ordered.forEach((x, i) => {
      if (x.kind === 'folder') nextFolders = nextFolders.map((f) => (f.id === x.id ? { ...f, sort: i + 1 } : f))
      else nextRequests = nextRequests.map((r) => (r.id === x.id ? { ...r, sort: i + 1 } : r))
    })
    const changedF = nextFolders.filter((f, i) => JSON.stringify(f) !== JSON.stringify(folders[i]))
    const changedR = nextRequests.filter((r, i) => JSON.stringify(r) !== JSON.stringify(requests[i]))
    setFolders(nextFolders); setRequests(nextRequests)
    setTabs((ts) => ts.map((t) => { const r = changedR.find((x) => x.id === t.draft.id); return r ? { ...t, draft: { ...t.draft, collectionId: r.collectionId, folderId: r.folderId, sort: r.sort } } : t }))
    await db.putMany({ folders: changedF, requests: changedR })
    return true
  }, [folders, requests])

  /** Replaces a collection's contents (e.g. reloaded from its folder); adds it if it's new. */
  const replaceCollection = useCallback(async (w: Workspace) => {
    const c = w.collections[0]
    await db.deleteCollection(c.id)
    await db.putMany({ collections: [c], folders: w.folders, requests: w.requests })
    setCollections((cs) => [...cs.filter((x) => x.id !== c.id), c].sort(byName))
    setFolders((fs) => [...fs.filter((f) => f.collectionId !== c.id), ...w.folders])
    setRequests((rs) => [...rs.filter((r) => r.collectionId !== c.id), ...w.requests])
    setTabs((ts) => ts.map((t) => { const r = w.requests.find((x) => x.id === t.draft.id); return r ? { ...t, draft: structuredClone(r) } : t }))
  }, [])

  /** Deletes several requests with one undo. */
  const removeRequests = useCallback(async (ids: string[]) => {
    const gone = requests.filter((r) => ids.includes(r.id))
    for (const id of ids) await db.deleteRequest(id)
    setRequests((rs) => rs.filter((r) => !ids.includes(r.id)))
    setTabs((ts) => ts.map((t) => (ids.includes(t.draft.id) ? { ...t, draft: { ...t.draft, id: uid() } } : t)))
    if (gone.length) toTrash(gone.length === 1 ? `“${gone[0].name}”` : `${gone.length} requests`, { requests: gone })
  }, [requests, toTrash])

  /** Puts back the most recent delete. */
  const undoDelete = useCallback(async () => {
    const last = trash[trash.length - 1]
    if (!last) return null
    setTrash((t) => t.slice(0, -1))
    await importWorkspace(last.data)
    return last.label
  }, [trash, importWorkspace])

  const snapshot = useCallback((): db.BackupData => ({ collections, folders, requests, environments, globals }), [collections, folders, requests, environments, globals])
  const backupNow = useCallback(async (reason: db.BackupInfo['reason'] = 'manual') => {
    await db.addBackup(snapshot(), reason); setBackups(await db.listBackups())
  }, [snapshot])
  /** Replaces everything with a backup, after backing up what's there now. */
  const restoreBackup = useCallback(async (id: string) => {
    const data = await db.getBackup(id)
    if (!data) return false
    await db.addBackup(snapshot(), 'before-restore')
    await db.replaceAll(data)
    setCollections(data.collections.sort(byName)); setFolders(data.folders); setRequests(data.requests)
    setEnvironments(data.environments.sort(byName)); setGlobalsState(data.globals)
    setBackups(await db.listBackups()); setView({ kind: 'request' })
    return true
  }, [snapshot])

  return {
    trash, undoDelete, backups, backupNow, restoreBackup, placeItems, removeRequests, replaceCollection,
    spaces, activeSpaceId, switchSpace, addSpace, renameSpace, removeSpace, moveToSpace,
    /** Everything, across workspaces (exports, backups, file sync). The plain lists below are this workspace's. */
    allCollections: collections, allEnvironments: environments,
    ready, transport, collections: visibleCollections, folders, requests, environments: visibleEnvironments, globals, history, settings, logs,
    tabs, activeId, active, draft, view, result: active.result, sending: active.sending, saved, dirty, isDirty,
    collection, environment, prepared, chain, runContext, pipeline: pipelineRef, variableNames,
    setDraft, setView, setSettings, setLogs, log, openRequest, startNew, closeTab, selectTab, saveDraft, renameRequest,
    moveRequest, removeRequest, duplicateRequest, send, cancel, applyChanges, openHistory, clearHistory,
    addCollection, updateCollection, removeCollection, addFolder, updateFolder, removeFolder,
    addEnvironment, updateEnvironment, removeEnvironment, duplicateEnvironment, setGlobals, importWorkspace,
  }
}

export type WorkspaceApi = ReturnType<typeof useWorkspace>
