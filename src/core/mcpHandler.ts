/**
 * The MCP tools Dispatch offers to AI assistants: list_requests, send_request, run_collection, and run_flow when
 * there are flows. Transport-free (one JSON-RPC message in, one reply out), so the same handler serves
 * `dispatch-run mcp` over stdio and the desktop app's local MCP endpoint over HTTP.
 */
import type { ImportResult } from './backup'
import type { Collection, Environment, KV, Settings } from './types'
import type { Transport } from './transport'
import { type Execution, type Pipeline, type RunContext, execute, sendOptions } from './runtime'
import { collectItems, failed, runCollection, type RunItem, type RunSummary } from './runner'
import { type Flow, type FlowRun, runFlow } from './flows'
import type { ScriptEngine } from './scriptPipeline'

export interface McpServeOptions {
  ws: ImportResult
  environment: Environment | null
  globals: KV[]
  settings: Settings
  transport: Transport
  pipeline: Pipeline
  /** Methods the assistant may send; empty = all. */
  allowMethods: string[]
  version: string
  /** Runs If/Script blocks in flows. */
  engine?: ScriptEngine
  /** Serve every collection in `ws` (names become the first path segment); otherwise only the first. */
  allCollections?: boolean
  /** The desktop app saves what a send or run changed (variables set by scripts, refreshed tokens). */
  hooks?: {
    afterSend?: (x: Execution, ctx: RunContext) => Promise<void>
    afterRun?: (s: RunSummary) => Promise<void>
    runFlow?: (f: Flow) => Promise<FlowRun>
  }
}

const BODY_LIMIT = 20_000

export function mcpTools(flowNames: string[] = [], multi = false) {
  return [
    {
      name: 'list_requests',
      description: `List the saved requests${multi ? ' in every collection' : ' in this collection'}: their names, folders, methods and URLs (with {{variables}}).`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'send_request',
      description: 'Send one saved request (with its auth, scripts and tests) and return the status, headers, body and test results.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: multi ? 'The path from list_requests, like "Collection/Folder/Request", or just the request name when it is unique.' : 'The request name, or "Folder/Sub/Request" when names repeat.' },
          variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for {{variables}}, overriding the environment for this call.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'run_collection',
      description: `Run every request in ${multi ? 'a collection' : 'the collection'} (or one folder) in order, with tests, and return a summary with any failures.`,
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: multi ? 'A collection, or a folder path like "Collection/Orders/Admin".' : 'A folder path like "Orders/Admin"; leave out for the whole collection.' },
          data: { type: 'array', items: { type: 'object' }, description: 'Optional data rows: one run per row, the keys become {{variables}}.' },
        },
        ...(multi ? { required: ['folder'] } : {}),
      },
    },
    ...(flowNames.length ? [{
      name: 'run_flow',
      description: `Run a flow (requests chained with conditions and loops) and return each step. Flows: ${flowNames.join(', ')}.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', enum: flowNames, description: 'The flow to run.' } }, required: ['name'] },
    }] : []),
  ]
}

/** Handles one JSON-RPC message; returns the reply (or null for notifications). */
export async function handleMcp(msg: any, o: McpServeOptions): Promise<any | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  const text = (t: string, isError = false) => reply({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })
  if (msg.id === undefined) return null
  const cols: Collection[] = o.allCollections ? o.ws.collections : o.ws.collections.slice(0, 1)
  const multi = !!o.allCollections
  const col = cols[0]
  const items = (): RunItem[] => cols.flatMap((c) => collectItems(c, null, o.ws.folders, o.ws.requests))
  const pathOf = (it: RunItem) => [...it.path.split(' / ').slice(multi ? 0 : 1), it.request.name].join('/')
  const colOf = (it: RunItem) => cols.find((c) => c.id === it.request.collectionId) ?? col
  const canFlow = !!(o.engine || o.hooks?.runFlow)
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'dispatch', version: o.version },
        instructions: `${multi ? `Requests from Dispatch (collections: ${cols.map((c) => `“${c.name}”`).join(', ') || 'none'})` : `Requests from the Dispatch collection “${col?.name ?? '(none)'}”`}${o.environment ? ` with environment “${o.environment.name}”` : ''}. Use list_requests to see what's there.`,
      })
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: mcpTools(canFlow ? (o.ws.flows ?? []).map((f) => f.name) : [], multi) })
    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      if (name === 'list_requests') {
        const list = items().map((it) => `${it.request.method.padEnd(6)} ${pathOf(it)}  ${it.request.url}`)
        return text(list.length ? list.join('\n') : 'No requests.')
      }
      if (name === 'send_request') {
        const want = String(args.name ?? '')
        const all = items()
        const named = all.filter((x) => x.request.name === want)
        const it = all.find((x) => pathOf(x) === want) ?? (named.length === 1 || !multi ? named[0] : undefined)
        if (!it) return text(named.length > 1 ? `Several requests are named “${want}”: ${named.map(pathOf).join(', ')}. Use the full path.` : `No request named “${want}”. Use list_requests.`, true)
        if (o.allowMethods.length && !o.allowMethods.includes(it.request.method)) return text(`${it.request.method} requests aren’t allowed here (allowed: ${o.allowMethods.join(', ')}).`, true)
        const locals = new Map(Object.entries(args.variables ?? {}).map(([k, v]) => [k, String(v)]))
        const ctx: RunContext = { collection: colOf(it), folders: o.ws.folders, environment: o.environment, globals: o.globals, locals }
        const x = await execute(it.request, ctx, o.transport, sendOptions(it.request, o.settings), o.pipeline)
        await o.hooks?.afterSend?.(x, ctx)
        if (x.error && !x.response) return text(`Not sent: ${x.error}`, true)
        const r = x.response!
        const body = r.binary ? `(binary, ${r.size} bytes)` : r.body.length > BODY_LIMIT ? `${r.body.slice(0, BODY_LIMIT)}\n… (cut at ${BODY_LIMIT} characters)` : r.body
        const tests = x.tests.length ? `\n\nTests:\n${x.tests.map((t) => `${t.passed ? '✓' : '✗'} ${t.name}${t.error ? ` — ${t.error}` : ''}`).join('\n')}` : ''
        return text(`${x.sent.method} ${x.sent.url}\n→ ${r.status} ${r.statusText} (${r.timeMs} ms)\n${r.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body}${tests}`, r.status >= 400 || x.tests.some((t) => !t.passed))
      }
      if (name === 'run_collection') {
        let list = items()
        if (args.folder) {
          const prefix = `${String(args.folder).replace(/^\/|\/$/g, '')}/`
          list = list.filter((x) => pathOf(x).startsWith(prefix))
          if (!list.length) return text(`No ${multi ? 'collection or folder' : 'folder'} “${args.folder}”.`, true)
        } else if (multi) return text('Name a collection (or a folder in one) to run.', true)
        if (o.allowMethods.length) {
          const blocked = list.filter((x) => !o.allowMethods.includes(x.request.method))
          if (blocked.length) return text(`This run includes ${blocked.map((b) => `${b.request.method} ${b.request.name}`).join(', ')}, which aren’t allowed here.`, true)
        }
        const data = Array.isArray(args.data) ? args.data.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))) : null
        const s = await runCollection({ items: list, iterations: data ? 0 : 1, data, delayMs: 0, stopOnFailure: false, environment: o.environment, collections: o.ws.collections, folders: o.ws.folders, globals: o.globals, settings: o.settings }, o.transport, o.pipeline)
        await o.hooks?.afterRun?.(s)
        const bad = s.results.filter(failed)
        return text([
          `${s.requests} requests in ${s.iterations} iteration(s): ${s.testsPassed} tests passed, ${s.testsFailed} failed, ${s.failedRequests} errors, avg ${s.avgTimeMs} ms.`,
          ...bad.slice(0, 20).map((r) => `✗ ${r.name}: ${r.error ?? r.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error ?? 'failed'}`).join('; ')}`),
        ].join('\n'), bad.length > 0)
      }
      if (name === 'run_flow' && canFlow) {
        const f = (o.ws.flows ?? []).find((x) => x.name === args.name)
        if (!f) return text(`No flow named “${args.name}”.`, true)
        if (o.allowMethods.length) {
          const blocked = f.nodes.flatMap((n) => (n.type === 'request' ? o.ws.requests.filter((r) => r.id === n.config.requestId && !o.allowMethods.includes(r.method)) : []))
          if (blocked.length) return text(`This flow sends ${blocked.map((b) => `${b.method} ${b.name}`).join(', ')}, which aren’t allowed here.`, true)
        }
        const r = o.hooks?.runFlow
          ? await o.hooks.runFlow(f)
          : await runFlow(f, { collections: o.ws.collections, folders: o.ws.folders, requests: o.ws.requests, environment: o.environment, globals: o.globals, settings: o.settings }, o.transport, o.pipeline, o.engine!)
        return text([
          `${r.ok ? 'Passed' : `Failed: ${r.error}`} (${r.steps.length} steps, ${r.durationMs} ms)`,
          ...r.steps.filter((x) => x.status !== 'running').slice(0, 100).map((x) => `${x.status === 'ok' ? '✓' : x.status === 'failed' ? '✗' : '·'} ${x.label}${x.status_code !== undefined ? ` ${x.status_code}` : ''}${x.port ? ` → ${x.port}` : ''} ${x.detail}`),
        ].join('\n'), !r.ok)
      }
      return fail(-32602, `Unknown tool ${name}`)
    }
    default: return fail(-32601, `Method not found: ${msg.method}`)
  }
}
