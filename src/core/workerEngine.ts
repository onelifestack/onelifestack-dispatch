import type { ScriptHost, ScriptInput, ScriptOutput } from './scripts'
import { InlineEngine, SCRIPT_TIMEOUT_MS, type ScriptEngine } from './scriptPipeline'

/**
 * One fresh Worker per script: nothing leaks between scripts, and a script that loops forever is simply terminated.
 * Falls back to running inline where Workers don't exist (tests).
 */
export class WorkerEngine implements ScriptEngine {
  private readonly fallback = new InlineEngine()
  constructor(private readonly timeoutMs = SCRIPT_TIMEOUT_MS) {}

  run(input: ScriptInput, host: ScriptHost): Promise<ScriptOutput> {
    if (typeof Worker === 'undefined') return this.fallback.run(input, host)
    return new Promise((resolve) => {
      const worker = new Worker(new URL('./scriptWorker.ts', import.meta.url), { type: 'module' })
      const finish = (o: ScriptOutput) => { clearTimeout(timer); worker.terminate(); resolve(o) }
      const fail = (error: string) => finish({
        tests: [], logs: [{ level: 'error', text: `${input.source}: ${error}`, at: Date.now(), source: input.source }],
        vars: input.vars, request: input.request, skip: false, error,
      })
      const timer = setTimeout(() => fail(`script took longer than ${this.timeoutMs / 1000} s and was stopped.`), this.timeoutMs)
      worker.onerror = (e) => { e.preventDefault(); fail(e.message || 'the script couldn’t start.') }
      worker.onmessage = async (ev: MessageEvent) => {
        const msg = ev.data as { type: 'done'; output: ScriptOutput } | { type: 'send'; id: number; request: Parameters<ScriptHost['sendRequest']>[0] }
        if (msg.type === 'done') { finish(msg.output); return }
        try {
          const response = await host.sendRequest(msg.request)
          worker.postMessage({ type: 'sendResult', id: msg.id, response })
        } catch (e) {
          worker.postMessage({ type: 'sendResult', id: msg.id, error: e instanceof Error ? e.message : String(e) })
        }
      }
      worker.postMessage({ type: 'run', input })
    })
  }
}
