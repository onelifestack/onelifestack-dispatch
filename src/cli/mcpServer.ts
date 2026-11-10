/**
 * `dispatch-run mcp <file|folder>`: serves a collection to AI assistants over MCP (stdio, newline-delimited
 * JSON-RPC). The tools live in core/mcpHandler (shared with the desktop app's local MCP endpoint). Stdout carries
 * protocol messages only; anything else goes to stderr.
 */
import { createInterface } from 'node:readline'
import { type McpServeOptions, handleMcp } from '../core/mcpHandler'
import { kv } from '../core/types'

export { type McpServeOptions, handleMcp, mcpTools } from '../core/mcpHandler'

/** Runs the stdio server until stdin closes. */
export function serveMcp(o: McpServeOptions): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    const write = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`)
    rl.on('line', (line) => {
      if (!line.trim()) return
      let msg: any
      try { msg = JSON.parse(line) } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
      void handleMcp(msg, o).then((r) => { if (r) write(r) }, (e) => write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }))
    })
    rl.on('close', () => resolve())
  })
}

export const varsArg = (pairs: string[]) => pairs.map((p) => { const i = p.indexOf('='); return kv(p.slice(0, i), p.slice(i + 1)) })
