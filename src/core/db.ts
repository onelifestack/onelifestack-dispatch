import type { Collection, Environment, Folder, HistoryEntry, KV, RequestDef, Settings } from './types'
import { defaultSettings, normalizeCollection, normalizeFolder, normalizeRequest } from './types'
import { resetVaultForTests, secretsOf, seal, unseal, vaultKey } from './vault'

/** Everything lives in this device's IndexedDB; nothing is sent anywhere except the requests you send. */
const NAME = 'dispatch'
const VERSION = 2
export const HISTORY_LIMIT = 200
let opening: Promise<IDBDatabase> | null = null

export function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      // v1: the first stores. v2: folders. Old records are upgraded when read (normalize*).
      if (ev.oldVersion < 1) {
        db.createObjectStore('requests', { keyPath: 'id' })
        db.createObjectStore('collections', { keyPath: 'id' })
        db.createObjectStore('environments', { keyPath: 'id' })
        db.createObjectStore('history', { keyPath: 'id' }).createIndex('at', 'at')
        db.createObjectStore('meta')
      }
      if (ev.oldVersion < 2) db.createObjectStore('folders', { keyPath: 'id' })
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
  resetVaultForTests()
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = r.onerror = r.onblocked = () => res() })
}

const wrap = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error) })
async function all<T>(store: string): Promise<T[]> { const db = await open(); return wrap<T[]>(db.transaction(store).objectStore(store).getAll()) }
async function put(store: string, v: unknown, key?: string) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(v, key); await done(t) }
async function del(store: string, key: string) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); await done(t) }

// Secrets are sealed on the way in and unsealed on the way out (see vault.ts).
const key = () => vaultKey({
  get: async () => { const db = await open(); return wrap(db.transaction('meta').objectStore('meta').get('vaultKey')) },
  set: (v) => put('meta', v, 'vaultKey'),
})
const sealer = async () => { const k = await key(); return (s: string) => seal(k, s) }
const unsealer = async () => { const k = await key(); return (s: string) => unseal(k, s) }

export const listRequests = async () => { const f = await unsealer(); return Promise.all((await all<RequestDef>('requests')).map((r) => secretsOf.request(normalizeRequest(r), f))) }
export const listCollections = async () => { const f = await unsealer(); return Promise.all((await all<Collection>('collections')).map((c) => secretsOf.collection(normalizeCollection(c), f))) }
export const listFolders = async () => { const f = await unsealer(); return Promise.all((await all<Folder>('folders')).map((x) => secretsOf.folder(normalizeFolder(x), f))) }
export const listEnvironments = async () => { const f = await unsealer(); return Promise.all((await all<Environment>('environments')).map((e) => secretsOf.environment(e, f))) }
export const putFolder = async (x: Folder) => put('folders', await secretsOf.folder(x, await sealer()))
export const putRequest = async (r: RequestDef) => put('requests', await secretsOf.request(r, await sealer()))
export const putCollection = async (c: Collection) => put('collections', await secretsOf.collection(c, await sealer()))
export const putEnvironment = async (e: Environment) => put('environments', await secretsOf.environment(e, await sealer()))
export const deleteRequest = (id: string) => del('requests', id)
export const deleteEnvironment = (id: string) => del('environments', id)

/** Deletes a collection and every request saved in it. */
export async function deleteCollection(id: string) {
  const db = await open()
  const t = db.transaction(['collections', 'requests', 'folders'], 'readwrite')
  t.objectStore('collections').delete(id)
  deleteWhere(t.objectStore('folders'), (f: Folder) => f.collectionId === id)
  deleteWhere(t.objectStore('requests'), (r: RequestDef) => r.collectionId === id)
  await done(t)
}

function deleteWhere<T>(store: IDBObjectStore, test: (v: T) => boolean) {
  const cursor = store.openCursor()
  cursor.onsuccess = () => {
    const c = cursor.result
    if (!c) return
    if (test(c.value as T)) c.delete()
    c.continue()
  }
}

/** Deletes folders (a folder and its subfolders) and the requests in them. */
export async function deleteFolders(ids: string[]) {
  const set = new Set(ids)
  const db = await open()
  const t = db.transaction(['folders', 'requests'], 'readwrite')
  ids.forEach((id) => t.objectStore('folders').delete(id))
  deleteWhere(t.objectStore('requests'), (r: RequestDef) => !!r.folderId && set.has(r.folderId))
  await done(t)
}

/** Global variables (available in every request). */
export async function getGlobals(): Promise<KV[]> {
  const db = await open()
  return secretsOf.globals((await wrap<KV[] | undefined>(db.transaction('meta').objectStore('meta').get('globals'))) ?? [], await unsealer())
}
export const putGlobals = async (g: KV[]) => put('meta', await secretsOf.globals(g, await sealer()), 'globals')

/** Small UI state kept between sessions (open tabs...). */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await open()
  return wrap<T | undefined>(db.transaction('meta').objectStore('meta').get(key))
}
export const putMeta = (key: string, v: unknown) => put('meta', v, key)

/** Newest first. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const f = await unsealer()
  return Promise.all((await all<HistoryEntry>('history')).sort((a, b) => b.at - a.at).map((h) => secretsOf.history(h, f)))
}

/** Adds an entry and trims history to the newest HISTORY_LIMIT entries. */
export async function addHistory(plain: HistoryEntry) {
  const e = await secretsOf.history(plain, await sealer())
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
export async function putMany(plain: { collections?: Collection[]; folders?: Folder[]; requests?: RequestDef[]; environments?: Environment[] }) {
  const f = await sealer()
  const data = {
    collections: plain.collections && await Promise.all(plain.collections.map((c) => secretsOf.collection(c, f))),
    folders: plain.folders && await Promise.all(plain.folders.map((x) => secretsOf.folder(x, f))),
    requests: plain.requests && await Promise.all(plain.requests.map((r) => secretsOf.request(r, f))),
    environments: plain.environments && await Promise.all(plain.environments.map((e) => secretsOf.environment(e, f))),
  }
  const db = await open()
  const t = db.transaction(['collections', 'folders', 'requests', 'environments'], 'readwrite')
  data.folders?.forEach((f) => t.objectStore('folders').put(f))
  data.collections?.forEach((c) => t.objectStore('collections').put(c))
  data.requests?.forEach((r) => t.objectStore('requests').put(r))
  data.environments?.forEach((e) => t.objectStore('environments').put(e))
  await done(t)
}

/** Open tabs (drafts included), with their secrets sealed like saved requests. */
export async function putOpenTabs(drafts: RequestDef[], active: number) {
  const f = await sealer()
  await put('meta', { tabs: await Promise.all(drafts.map((d) => secretsOf.request(d, f))), active }, 'tabs')
}
export async function getOpenTabs(): Promise<{ tabs: RequestDef[]; active: number } | undefined> {
  const saved = await getMeta<{ tabs: RequestDef[]; active: number }>('tabs')
  if (!saved?.tabs) return saved
  const f = await unsealer()
  return { ...saved, tabs: await Promise.all(saved.tabs.map((d) => secretsOf.request(normalizeRequest(d), f))) }
}
