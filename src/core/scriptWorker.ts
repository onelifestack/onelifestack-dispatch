/// <reference lib="webworker" />
/**
 * Runs one script in a Web Worker: no DOM, and network/storage APIs are removed before user code runs, so a script
 * imported with someone else's collection can't read your saved data or send it anywhere. pm.sendRequest goes
 * through the app (postMessage), which uses the normal transport.
 */
import { type PmRequestData, type PmResponseData, type ScriptInput, compileWithFunction, runScript } from './scripts'
import { loadLibs, neededLibs } from './scriptLibs'

declare const self: DedicatedWorkerGlobalScope

for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'indexedDB', 'caches', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'WebTransport']) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }) } catch { /* not present */ }
}
try { Object.defineProperty(self.navigator, 'sendBeacon', { value: undefined }) } catch { /* not present */ }

let nextId = 1
const waiting = new Map<number, { resolve: (r: PmResponseData) => void; reject: (e: Error) => void }>()

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as { type: 'run'; input: ScriptInput } | { type: 'sendResult'; id: number; response?: PmResponseData; error?: string }
  if (msg.type === 'sendResult') {
    const w = waiting.get(msg.id)
    waiting.delete(msg.id)
    if (msg.error !== undefined) w?.reject(new Error(msg.error)); else w?.resolve(msg.response!)
    return
  }
  const libs = await loadLibs(neededLibs(msg.input.code))
  const output = await runScript(msg.input, {
    sendRequest: (request: PmRequestData) => new Promise<PmResponseData>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      self.postMessage({ type: 'send', id, request })
    }),
  }, compileWithFunction, libs)
  self.postMessage({ type: 'done', output })
}
