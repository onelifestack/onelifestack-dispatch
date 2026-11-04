/**
 * A small MCP (Model Context Protocol) client for testing MCP servers: JSON-RPC 2.0 over Streamable HTTP (POST,
 * answered with JSON or an event stream) or stdio (desktop: a process Dispatch starts). Initialize, list tools /
 * resources / prompts, call a tool, read a resource, get a prompt.
 */
import type { PreparedRequest } from './types'
import type { SendOptions, Transport } from './transport'
import { SendError } from './transport'
import { SseParser } from './sse'

export const PROTOCOL_VERSION = '2025-06-18'

export interface RpcMessage { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: any; error?: { code: number; message: string; data?: unknown } }
export interface McpLogEntry { dir: 'out' | 'in' | 'info' | 'error'; at: number; message: unknown }

/** Something that can carry one JSON-RPC message and hand back the answer (and any messages that came with it). */
export interface McpWire {
  request(msg: RpcMessage): Promise<RpcMessage[]>
  notify(msg: RpcMessage): Promise<void>
  close(): Promise<void>
}

export interface McpTool { name: string; title?: string; description?: string; inputSchema?: any }
export interface McpResource { uri: string; name?: string; description?: string; mimeType?: string }
export interface McpPrompt { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }

export class McpClient {
  private next = 1
  serverInfo: { name?: string; version?: string } = {}
  capabilities: Record<string, unknown> = {}
  instructions = ''
  constructor(private readonly wire: McpWire, private readonly log: (e: McpLogEntry) => void = () => {}) {}

  private async call(method: string, params?: unknown): Promise<any> {
    const msg: RpcMessage = { jsonrpc: '2.0', id: this.next++, method, ...(params !== undefined ? { params } : {}) }
    this.log({ dir: 'out', at: Date.now(), message: msg })
    const replies = await this.wire.request(msg)
    for (const r of replies) this.log({ dir: 'in', at: Date.now(), message: r })
    const answer = replies.find((r) => r.id === msg.id && (r.result !== undefined || r.error))
    if (!answer) throw new SendError(`No answer to ${method}.`)
    if (answer.error) throw new SendError(`${method} failed: ${answer.error.message} (${answer.error.code})`)
    return answer.result
  }

  async initialize(clientVersion = '0.4.2') {
    const r = await this.call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Dispatch', version: clientVersion } })
    this.serverInfo = r?.serverInfo ?? {}
    this.capabilities = r?.capabilities ?? {}
    this.instructions = r?.instructions ?? ''
    const note: RpcMessage = { jsonrpc: '2.0', method: 'notifications/initialized' }
    this.log({ dir: 'out', at: Date.now(), message: note })
    await this.wire.notify(note)
    return r
  }
  /** Lists everything the server offers, following pagination; missing capabilities give empty lists. */
  private async all<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const r = await this.call(method, cursor ? { cursor } : {})
      out.push(...(r?.[key] ?? []))
      cursor = r?.nextCursor
      if (!cursor) break
    }
    return out
  }
  listTools = () => (this.capabilities.tools ? this.all<McpTool>('tools/list', 'tools') : Promise.resolve([]))
  listResources = () => (this.capabilities.resources ? this.all<McpResource>('resources/list', 'resources') : Promise.resolve([]))
  listPrompts = () => (this.capabilities.prompts ? this.all<McpPrompt>('prompts/list', 'prompts') : Promise.resolve([]))
  callTool = (name: string, args: unknown) => this.call('tools/call', { name, arguments: args ?? {} })
  readResource = (uri: string) => this.call('resources/read', { uri })
  getPrompt = (name: string, args: Record<string, string>) => this.call('prompts/get', { name, arguments: args })
  close = () => this.wire.close()
}

/**
 * Streamable HTTP: each message is a POST; the server answers with JSON, or with an event stream that carries the
 * answer (and maybe other messages). The session id from initialize is sent on later requests.
 */
export class HttpWire implements McpWire {
  private session: string | null = null
  private protocol: string | null = null
  constructor(private readonly base: PreparedRequest, private readonly transport: Transport, private readonly opts: SendOptions) {}

  private async post(msg: RpcMessage): Promise<RpcMessage[]> {
    const headers: [string, string][] = [
      ...this.base.headers.filter(([k]) => !/^(content-type|accept|mcp-session-id)$/i.test(k)),
      ['Content-Type', 'application/json'], ['Accept', 'application/json, text/event-stream'],
    ]
    if (this.session) headers.push(['Mcp-Session-Id', this.session])
    if (this.protocol) headers.push(['MCP-Protocol-Version', this.protocol])
    const res = await this.transport.send({ ...this.base, method: 'POST', headers, body: JSON.stringify(msg), multipart: null, bodyFile: null }, this.opts)
    const sid = res.headers.find(([k]) => k.toLowerCase() === 'mcp-session-id')?.[1]
    if (sid) this.session = sid
    if (msg.method === 'initialize') this.protocol = PROTOCOL_VERSION
    if (res.status === 202 || (!res.body.trim() && res.status < 300)) return []
    if (res.status >= 400) throw new SendError(`The server answered ${res.status} ${res.statusText}${res.body ? `: ${res.body.slice(0, 200)}` : ''}`)
    const ct = res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
    if (ct.includes('text/event-stream')) {
      return new SseParser().push(`${res.body}\n\n`).flatMap((e) => { try { const v = JSON.parse(e.data); return Array.isArray(v) ? v : [v] } catch { return [] } })
    }
    try { const v = JSON.parse(res.body); return Array.isArray(v) ? v : [v] } catch { throw new SendError('The server’s answer isn’t JSON.') }
  }
  request = (msg: RpcMessage) => this.post(msg)
  notify = async (msg: RpcMessage) => { await this.post(msg) }
  close = async () => {
    if (!this.session) return
    try { await this.transport.send({ ...this.base, method: 'DELETE', headers: [...this.base.headers, ['Mcp-Session-Id', this.session]], body: null, multipart: null, bodyFile: null }, this.opts) } catch { /* fine */ }
  }
}

/** stdio: newline-delimited JSON over a process's stdin/stdout. `write` sends a line; `onLine` delivers lines. */
export class LineWire implements McpWire {
  private waiting = new Map<number | string, { resolve: (m: RpcMessage[]) => void; extra: RpcMessage[]; timer: ReturnType<typeof setTimeout> }>()
  private stray: RpcMessage[] = []
  constructor(private readonly write: (line: string) => Promise<void>, private readonly stop: () => Promise<void>, private readonly timeoutMs = 30_000) {}

  /** Feed each stdout line here. */
  onLine(line: string) {
    let msg: RpcMessage
    try { msg = JSON.parse(line) } catch { return } // servers sometimes print logs to stdout
    if (msg.id !== undefined && (msg.result !== undefined || msg.error) && this.waiting.has(msg.id)) {
      const w = this.waiting.get(msg.id)!
      this.waiting.delete(msg.id); clearTimeout(w.timer)
      w.resolve([...w.extra, ...this.stray.splice(0), msg])
    } else this.stray.push(msg)
  }
  request(msg: RpcMessage): Promise<RpcMessage[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(msg.id!); reject(new SendError(`No answer to ${msg.method} after ${this.timeoutMs / 1000} s.`)) }, this.timeoutMs)
      this.waiting.set(msg.id!, { resolve, extra: [], timer })
      this.write(JSON.stringify(msg)).catch((e) => { clearTimeout(timer); this.waiting.delete(msg.id!); reject(e) })
    })
  }
  notify = (msg: RpcMessage) => this.write(JSON.stringify(msg))
  close = () => this.stop()
}

/** A JSON value matching a tool's input schema, to start editing from. */
export function argumentsTemplate(schema: any): string {
  const sample = (s: any, depth = 0): unknown => {
    if (!s || depth > 5) return null
    if (s.default !== undefined) return s.default
    if (s.examples?.length) return s.examples[0]
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
    const type = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type
    if (type === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v, depth + 1)]))
    if (type === 'array') return []
    if (type === 'integer' || type === 'number') return 0
    if (type === 'boolean') return false
    if (type === 'string') return ''
    return null
  }
  return JSON.stringify(sample(schema ?? { type: 'object' }) ?? {}, null, 2)
}
