import type { Collection, Environment, HistoryEntry, RequestDef, Settings } from './types'
import { defaultSettings } from './types'

/** Everything lives in this device's IndexedDB; nothing is sent anywhere except the requests you send. */
const NAME = 'dispatch'
const VERSION = 1
export const HISTORY_LIMIT = 200
let opening: Promise<IDBDatabase> | null = null

export function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('requests', { keyPath: 'id' })
      db.createObjectStore('collections', { keyPath: 'id' })
      db.createObjectStore('environments', { keyPath: 'id' })
      db.createObjectStore('history', { keyPath: 'id' }).createIndex('at', 'at')
      db.createObjectStore('meta')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return opening
}

/** For tests: forget the open connection and delete the database. */
export async function resetForTests() {
  if (opening) (await opening).close()
  opening = null
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = r.onerror = r.onblocked = () => res() })
}

const wrap = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error) })
async function all<T>(store: string): Promise<T[]> { const db = await open(); return wrap<T[]>(db.transaction(store).objectStore(store).getAll()) }
async function put(store: string, v: unknown, key?: string) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(v, key); await done(t) }
async function del(store: string, key: string) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); await done(t) }

export const listRequests = () => all<RequestDef>('requests')
export const listCollections = () => all<Collection>('collections')
export const listEnvironments = () => all<Environment>('environments')
export const putRequest = (r: RequestDef) => put('requests', r)
export const putCollection = (c: Collection) => put('collections', c)
export const putEnvironment = (e: Environment) => put('environments', e)
export const deleteRequest = (id: string) => del('requests', id)
export const deleteEnvironment = (id: string) => del('environments', id)

/** Deletes a collection and every request saved in it. */
export async function deleteCollection(id: string) {
  const db = await open()
  const t = db.transaction(['collections', 'requests'], 'readwrite')
  t.objectStore('collections').delete(id)
  const reqs = t.objectStore('requests')
  const cursor = reqs.openCursor()
  cursor.onsuccess = () => {
    const c = cursor.result
    if (!c) return
    if ((c.value as RequestDef).collectionId === id) c.delete()
    c.continue()
  }
  await done(t)
}

/** Newest first. */
export async function listHistory(): Promise<HistoryEntry[]> {
  return (await all<HistoryEntry>('history')).sort((a, b) => b.at - a.at)
}

/** Adds an entry and trims history to the newest HISTORY_LIMIT entries. */
export async function addHistory(e: HistoryEntry) {
  const db = await open()
  const t = db.transaction('history', 'readwrite')
  const store = t.objectStore('history')
  store.put(e)
  const keys = await wrap(store.index('at').getAllKeys())
  const extra = keys.length - HISTORY_LIMIT
  for (let i = 0; i < extra; i++) store.delete(keys[i])
  await done(t)
}

export async function clearHistory() {
  const db = await open(); const t = db.transaction('history', 'readwrite'); t.objectStore('history').clear(); await done(t)
}

export async function getSettings(): Promise<Settings> {
  const db = await open()
  const s = await wrap<Settings | undefined>(db.transaction('meta').objectStore('meta').get('settings'))
  return { ...defaultSettings, ...s }
}
export const putSettings = (s: Settings) => put('meta', s, 'settings')

/** Writes a whole workspace (imports) in one transaction. */
export async function putMany(data: { collections?: Collection[]; requests?: RequestDef[]; environments?: Environment[] }) {
  const db = await open()
  const t = db.transaction(['collections', 'requests', 'environments'], 'readwrite')
  data.collections?.forEach((c) => t.objectStore('collections').put(c))
  data.requests?.forEach((r) => t.objectStore('requests').put(r))
  data.environments?.forEach((e) => t.objectStore('environments').put(e))
  await done(t)
}
