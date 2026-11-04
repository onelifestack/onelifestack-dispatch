import type { Collection, Environment, Folder, HttpResponse, KV, LogLine, PreparedRequest, RequestDef, Settings, TestResult } from './types'
import { prepare, type PrepareContext } from './prepare'
import { SendError, type SendOptions, type Transport } from './transport'

/** The folder and its parents, nearest first. */
export function folderChain(folders: Folder[], folderId: string | null): Folder[] {
  const chain: Folder[] = []
  const seen = new Set<string>()
  let id = folderId
  while (id && !seen.has(id)) {
    seen.add(id)
    const f = folders.find((x) => x.id === id)
    if (!f) break
    chain.push(f)
    id = f.parentId
  }
  return chain
}

export interface RunContext {
  collection: Collection | null
  folders: Folder[]
  environment: Environment | null
  globals: KV[]
  data?: Record<string, string> | null
  /** Shared across the requests of one run (runner); scripts write here with pm.variables.set. */
  locals?: Map<string, string>
}

export interface Execution {
  sent: PreparedRequest
  response: HttpResponse | null
  error: string | null
  tests: TestResult[]
  logs: LogLine[]
  /** Variables changed by scripts, to be saved: environment/collection/globals. */
  changes: VariableChanges
  /** pm.execution.setNextRequest() (runner): undefined = not called, null = stop. */
  nextRequest?: string | null
  /** A pre-request script threw; the request isn't sent. */
  scriptError?: string
  /** A pre-request script skipped the request. */
  skipped?: boolean
}

export interface VariableChanges {
  environment: KV[] | null
  collection: KV[] | null
  globals: KV[] | null
}

export const noChanges = (): VariableChanges => ({ environment: null, collection: null, globals: null })

export function sendOptions(req: RequestDef, settings: Settings, signal?: AbortSignal): SendOptions {
  return {
    timeoutMs: req.settings.timeoutMs ?? settings.timeoutMs,
    followRedirects: req.settings.followRedirects ?? settings.followRedirects,
    insecureTls: req.settings.insecureTls ?? settings.insecureTls,
    signal,
  }
}

export function prepareContext(ctx: RunContext, req: RequestDef): PrepareContext {
  return {
    collection: ctx.collection, environment: ctx.environment, globals: ctx.globals,
    folders: folderChain(ctx.folders, req.folderId), data: ctx.data ?? null, locals: ctx.locals ?? null,
  }
}

/** Hooks that later steps plug in (scripts, signing, digest). Kept here so the app, runner and CLI share one pipeline. */
export interface Pipeline {
  /** Runs before preparing; may change the request and variables. */
  beforeSend?: (req: RequestDef, ctx: RunContext, out: Execution) => Promise<RequestDef>
  /** Async signing (JWT, AWS SigV4). */
  sign?: (p: PreparedRequest, req: RequestDef, ctx: RunContext) => Promise<PreparedRequest>
  /** Answers auth challenges (Digest) by resending. */
  retry?: (p: PreparedRequest, res: HttpResponse, req: RequestDef, ctx: RunContext, send: (p: PreparedRequest) => Promise<HttpResponse>) => Promise<{ sent: PreparedRequest; response: HttpResponse } | null>
  /** Runs after the response (tests). */
  afterResponse?: (req: RequestDef, ctx: RunContext, out: Execution) => Promise<void>
}

/** Runs one request: hooks, variables, auth, send, tests. Never throws; failures land in `error`. */
export async function execute(req: RequestDef, ctx: RunContext, transport: Transport, opts: SendOptions, pipeline: Pipeline = {}): Promise<Execution> {
  const out: Execution = { sent: prepare(req, prepareContext(ctx, req)), response: null, error: null, tests: [], logs: [], changes: noChanges() }
  try {
    const finalReq = pipeline.beforeSend ? await pipeline.beforeSend(req, ctx, out) : req
    if (out.scriptError) throw new SendError(`Not sent: the pre-request script failed. ${out.scriptError}`)
    let sent = prepare(finalReq, prepareContext(ctx, finalReq))
    if (pipeline.sign) sent = await pipeline.sign(sent, finalReq, ctx)
    out.sent = sent
    if (!sent.url) throw new SendError('Enter a URL to send the request to.')
    try { new URL(sent.url) } catch {
      throw new SendError(sent.unresolved.length
        ? `The URL still has {{${sent.unresolved[0]}}} in it. Pick an environment that defines it, or add it as a variable.`
        : 'That URL isn’t valid.')
    }
    let response = await transport.send(sent, opts)
    if (pipeline.retry) {
      const again = await pipeline.retry(sent, response, finalReq, ctx, (p) => transport.send(p, opts))
      if (again) { out.sent = again.sent; response = again.response }
    }
    out.response = response
    if (pipeline.afterResponse) await pipeline.afterResponse(finalReq, ctx, out)
  } catch (e) {
    if (e instanceof Error && e.name === 'SkipRequest') out.skipped = true
    out.error = e instanceof SendError ? e.message : `The request failed: ${e instanceof Error ? e.message : String(e)}`
  }
  return out
}
