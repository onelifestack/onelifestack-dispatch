import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as db from '../core/db'
import type { Collection, Environment, HistoryEntry, HttpResponse, PreparedRequest, RequestDef, Settings } from '../core/types'
import { defaultSettings, newCollection, newEnvironment, newRequest, uid } from '../core/types'
import { prepare } from '../core/prepare'
import { SendError, type Transport, defaultTransport } from '../core/transport'
import type { Workspace } from '../core/backup'

export type View = { kind: 'request' } | { kind: 'collection'; id: string } | { kind: 'environment'; id: string }

export interface Result {
  sent: PreparedRequest
  response: HttpResponse | null
  error: string | null
}

const same = (a: RequestDef, b: RequestDef) => JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 })

/** All app state and actions. Saved data lives in IndexedDB; the open request is a draft until saved. */
export function useWorkspace(given?: Transport) {
  const [transport] = useState<Transport>(() => given ?? defaultTransport())
  const [ready, setReady] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [requests, setRequests] = useState<RequestDef[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [settings, setSettingsState] = useState<Settings>(defaultSettings)
  const [draft, setDraft] = useState<RequestDef>(() => newRequest())
  const [view, setView] = useState<View>({ kind: 'request' })
  const [result, setResult] = useState<Result | null>(null)
  const [sending, setSending] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const [c, r, e, h, s] = await Promise.all([db.listCollections(), db.listRequests(), db.listEnvironments(), db.listHistory(), db.getSettings()])
      if (!live) return
      setCollections(c.sort((a, b) => a.name.localeCompare(b.name)))
      setRequests(r); setEnvironments(e.sort((a, b) => a.name.localeCompare(b.name))); setHistory(h); setSettingsState(s)
      setReady(true)
    })()
    return () => { live = false }
  }, [])

  const saved = requests.find((r) => r.id === draft.id) ?? null
  const dirty = saved ? !same(saved, draft) : draft.url.trim() !== '' || draft.body.text !== ''
  const collection = collections.find((c) => c.id === draft.collectionId) ?? null
  const environment = environments.find((e) => e.id === settings.activeEnvId) ?? null
  const prepared = useMemo(() => prepare(draft, { collection, environment }), [draft, collection, environment])

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => { const next = { ...s, ...patch }; void db.putSettings(next); return next })
  }, [])

  const openRequest = useCallback((r: RequestDef) => { setDraft(structuredClone(r)); setResult(null); setView({ kind: 'request' }) }, [])
  const startNew = useCallback((collectionId: string | null = null) => {
    setDraft(newRequest({ collectionId })); setResult(null); setView({ kind: 'request' })
  }, [])

  const saveDraft = useCallback(async (into?: { collectionId: string | null; name: string }) => {
    const r: RequestDef = { ...draft, ...(into ?? {}), updatedAt: Date.now() }
    await db.putRequest(r)
    setRequests((rs) => [...rs.filter((x) => x.id !== r.id), r])
    setDraft(r)
    return r
  }, [draft])

  /** Saves a copy of the open request as a new saved request. */
  const saveAs = useCallback(async (collectionId: string | null, name: string) => {
    const r: RequestDef = { ...structuredClone(draft), id: uid(), collectionId, name, updatedAt: Date.now() }
    await db.putRequest(r)
    setRequests((rs) => [...rs, r]); setDraft(r)
    return r
  }, [draft])

  const removeRequest = useCallback(async (id: string) => {
    await db.deleteRequest(id)
    setRequests((rs) => rs.filter((r) => r.id !== id))
    setDraft((d) => (d.id === id ? { ...d, id: uid() } : d)) // keep editing it as an unsaved draft
  }, [])

  const renameRequest = useCallback(async (r: RequestDef, name: string) => {
    const next = { ...r, name, updatedAt: Date.now() }
    await db.putRequest(next)
    setRequests((rs) => rs.map((x) => (x.id === r.id ? next : x)))
    setDraft((d) => (d.id === r.id ? { ...d, name } : d))
  }, [])

  const duplicateRequest = useCallback(async (r: RequestDef) => {
    const copy: RequestDef = { ...structuredClone(r), id: uid(), name: `${r.name} copy`, updatedAt: Date.now() }
    await db.putRequest(copy)
    setRequests((rs) => [...rs, copy])
    return copy
  }, [])

  const send = useCallback(async () => {
    if (sending) return
    const sent = prepare(draft, { collection, environment })
    if (!sent.url) { setResult({ sent, response: null, error: 'Enter a URL to send the request to.' }); return }
    try { new URL(sent.url) } catch {
      setResult({ sent, response: null, error: sent.unresolved.length
        ? `The URL still has {{${sent.unresolved[0]}}} in it. Pick an environment that defines it, or add it as a variable.`
        : 'That URL isn’t valid.' })
      return
    }
    const ctrl = new AbortController(); abort.current = ctrl
    setSending(true)
    let entry: HistoryEntry
    try {
      const response = await transport.send(sent, {
        timeoutMs: settings.timeoutMs, followRedirects: settings.followRedirects, insecureTls: settings.insecureTls, signal: ctrl.signal,
      })
      setResult({ sent, response, error: null })
      entry = { id: uid(), at: Date.now(), request: structuredClone(draft), sent, response, error: null }
    } catch (e) {
      const error = e instanceof SendError ? e.message : `The request failed: ${e instanceof Error ? e.message : String(e)}`
      setResult({ sent, response: null, error })
      entry = { id: uid(), at: Date.now(), request: structuredClone(draft), sent, response: null, error }
    } finally {
      setSending(false); abort.current = null
    }
    // Large bodies would bloat history; keep the first 256 KB.
    if (entry.response && entry.response.body.length > 262_144) entry = { ...entry, response: { ...entry.response, body: entry.response.body.slice(0, 262_144) } }
    await db.addHistory(entry)
    setHistory((h) => [entry, ...h].slice(0, db.HISTORY_LIMIT))
  }, [sending, draft, collection, environment, transport, settings])

  const cancel = useCallback(() => abort.current?.abort(), [])

  const openHistory = useCallback((h: HistoryEntry) => {
    // Opens as a fresh draft, so editing it never changes the saved request it came from.
    setDraft({ ...structuredClone(h.request), id: uid() })
    setResult({ sent: h.sent, response: h.response, error: h.error })
    setView({ kind: 'request' })
  }, [])
  const clearHistory = useCallback(async () => { await db.clearHistory(); setHistory([]) }, [])

  const addCollection = useCallback(async (name: string) => {
    const c = newCollection(name); await db.putCollection(c)
    setCollections((cs) => [...cs, c].sort((a, b) => a.name.localeCompare(b.name)))
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
    setRequests((rs) => rs.filter((r) => r.collectionId !== id))
    setDraft((d) => (d.collectionId === id ? { ...d, id: uid(), collectionId: null } : d))
    setView((v) => (v.kind === 'collection' && v.id === id ? { kind: 'request' } : v))
  }, [])

  const addEnvironment = useCallback(async (name: string) => {
    const e = newEnvironment(name); await db.putEnvironment(e)
    setEnvironments((es) => [...es, e].sort((a, b) => a.name.localeCompare(b.name)))
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

  const importWorkspace = useCallback(async (w: Workspace) => {
    await db.putMany(w)
    setCollections((cs) => [...cs, ...w.collections].sort((a, b) => a.name.localeCompare(b.name)))
    setRequests((rs) => [...rs, ...w.requests])
    setEnvironments((es) => [...es, ...w.environments].sort((a, b) => a.name.localeCompare(b.name)))
  }, [])

  return {
    ready, transport, collections, requests, environments, history, settings, draft, view, result, sending, saved, dirty,
    collection, environment, prepared,
    setDraft, setView, setSettings, openRequest, startNew, saveDraft, saveAs, renameRequest, removeRequest, duplicateRequest, send, cancel,
    openHistory, clearHistory, addCollection, updateCollection, removeCollection, addEnvironment, updateEnvironment,
    removeEnvironment, importWorkspace,
  }
}

export type WorkspaceApi = ReturnType<typeof useWorkspace>
