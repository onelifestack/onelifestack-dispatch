import type { Collection, Environment, Folder, HistoryEntry, KV, RequestDef, Settings } from './types'
import { defaultSettings, normalizeCollection, normalizeFolder, normalizeRequest } from './types'
import { resetVaultForTests, secretsOf, seal, unseal, vaultKey } from './vault'

/** Everything lives in this device's IndexedDB; nothing is sent anywhere except the requests you send. */
const NAME = 'dispatch'
const VERSION = 4
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
      if (ev.oldVersion < 3) db.createObjectStore('backups', { keyPath: 'id' }).createIndex('at', 'at')
      if (ev.oldVersion < 4) db.createObjectStore('flows', { keyPath: 'id' })
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
  const s = { ...defaultSettings, ...await wrap<Settings | undefined>(db.transaction('meta').objectStore('meta').get('settings')) }
  const f = await unsealer()
  return { ...s, clientCerts: await Promise.all((s.clientCerts ?? []).map(async (c) => ({ ...c, key: await f(c.key) }))) }
}
/** Client-certificate private keys are sealed like other secrets. */
export async function putSettings(s: Settings) {
  const f = await sealer()
  await put('meta', { ...s, clientCerts: await Promise.all(s.clientCerts.map(async (c) => ({ ...c, key: await f(c.key) }))) }, 'settings')
}

/** The cookie jar (desktop), sealed as a whole: cookies are often session secrets. */
export async function getCookies(): Promise<unknown[]> {
  const sealedJar = await getMeta<string>('cookies')
  if (!sealedJar) return []
  try { return JSON.parse(await (await unsealer())(sealedJar)) } catch { return [] }
}
export async function putCookies(list: unknown[]) { await put('meta', await (await sealer())(JSON.stringify(list)), 'cookies') }

/** Writes a whole workspace (imports) in one transaction. */
export async function putMany(plain: { collections?: Collection[]; folders?: Folder[]; requests?: RequestDef[]; environments?: Environment[]; flows?: Flow[] }) {
  if (plain.flows?.length) for (const f of plain.flows) await putFlow(f)
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

// ---------- local backups ----------

export interface BackupData { collections: Collection[]; folders: Folder[]; requests: RequestDef[]; environments: Environment[]; globals: KV[]; flows?: Flow[] }
export interface BackupInfo { id: string; at: number; reason: 'daily' | 'manual' | 'before-restore'; counts: { collections: number; requests: number; environments: number } }
export const BACKUP_KEEP = 10

/** Saves a snapshot of everything (secrets stay sealed) and keeps the newest BACKUP_KEEP. */
export async function addBackup(plain: BackupData, reason: BackupInfo['reason']): Promise<BackupInfo> {
  const f = await sealer()
  const data: BackupData = {
    collections: await Promise.all(plain.collections.map((c) => secretsOf.collection(c, f))),
    folders: await Promise.all(plain.folders.map((x) => secretsOf.folder(x, f))),
    requests: await Promise.all(plain.requests.map((r) => secretsOf.request(r, f))),
    environments: await Promise.all(plain.environments.map((e) => secretsOf.environment(e, f))),
    globals: await secretsOf.globals(plain.globals, f),
    flows: plain.flows ?? [],
  }
  const info: BackupInfo = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), reason,
    counts: { collections: data.collections.length, requests: data.requests.length, environments: data.environments.length } }
  const db = await open()
  const t = db.transaction('backups', 'readwrite')
  const store = t.objectStore('backups')
  store.put({ ...info, data })
  const keys = await wrap(store.index('at').getAllKeys())
  for (let i = 0; i < keys.length - BACKUP_KEEP; i++) store.delete(keys[i])
  await done(t)
  return info
}

export async function listBackups(): Promise<BackupInfo[]> {
  return (await all<BackupInfo & { data: unknown }>('backups')).map(({ data: _d, ...i }) => i).sort((a, b) => b.at - a.at)
}

export async function getBackup(id: string): Promise<BackupData | null> {
  const db = await open()
  const b = await wrap<{ data: BackupData } | undefined>(db.transaction('backups').objectStore('backups').get(id))
  if (!b) return null
  const f = await unsealer()
  return {
    collections: await Promise.all(b.data.collections.map((c) => secretsOf.collection(normalizeCollection(c), f))),
    folders: await Promise.all(b.data.folders.map((x) => secretsOf.folder(normalizeFolder(x), f))),
    requests: await Promise.all(b.data.requests.map((r) => secretsOf.request(normalizeRequest(r), f))),
    environments: await Promise.all(b.data.environments.map((e) => secretsOf.environment(e, f))),
    globals: await secretsOf.globals(b.data.globals ?? [], f),
    flows: b.data.flows ?? [],
  }
}

/** Replaces the whole workspace with `data` in one transaction. */
export async function replaceAll(data: BackupData) {
  const f = await sealer()
  const sealed = {
    collections: await Promise.all(data.collections.map((c) => secretsOf.collection(c, f))),
    folders: await Promise.all(data.folders.map((x) => secretsOf.folder(x, f))),
    requests: await Promise.all(data.requests.map((r) => secretsOf.request(r, f))),
    environments: await Promise.all(data.environments.map((e) => secretsOf.environment(e, f))),
    globals: await secretsOf.globals(data.globals, f),
  }
  const db = await open()
  const t = db.transaction(['collections', 'folders', 'requests', 'environments', 'meta', 'flows'], 'readwrite')
  for (const s of ['collections', 'folders', 'requests', 'environments'] as const) {
    t.objectStore(s).clear()
    for (const x of sealed[s]) t.objectStore(s).put(x)
  }
  t.objectStore('meta').put(sealed.globals, 'globals')
  if (data.flows) { t.objectStore('flows').clear(); for (const x of data.flows) t.objectStore('flows').put(x) }
  await done(t)
}

// ---------- schedules ----------
import type { Schedule, ScheduleRun } from './schedules'
export const getSchedules = async () => (await getMeta<Schedule[]>('schedules')) ?? []
export const putSchedules = (s: Schedule[]) => put('meta', s, 'schedules')
export const getScheduleRuns = async () => (await getMeta<ScheduleRun[]>('scheduleRuns')) ?? []
export const putScheduleRuns = (r: ScheduleRun[]) => put('meta', r, 'scheduleRuns')

// ---------- workspaces ----------
import { DEFAULT_SPACE, type Space } from './types'
export const getSpaces = async (): Promise<Space[]> => { const s = await getMeta<Space[]>('spaces'); return s?.length ? s : [DEFAULT_SPACE] }
export const putSpaces = (s: Space[]) => put('meta', s, 'spaces')

// ---------- flows ----------
import type { Flow } from './flows'
export const listFlows = () => all<Flow>('flows')
export const putFlow = (f: Flow) => put('flows', f)
export const deleteFlow = (id: string) => del('flows', id)
