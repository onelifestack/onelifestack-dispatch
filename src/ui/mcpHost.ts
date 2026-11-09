import { useEffect, useRef, useState } from 'react'
import { handleMcp } from '../core/mcpHandler'
import { isDesktop } from '../core/transport'
import type { WorkspaceApi } from './useWorkspace'
import { version } from '../../package.json'

/** A fresh 256-bit token, hex. */
export function newMcpToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export const mcpMethods = (s: string) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)

export type McpHostStatus = { state: 'off' } | { state: 'on'; port: number } | { state: 'error'; message: string }

/**
 * Desktop: serves the open workspace to AI assistants at http://127.0.0.1:<port>/mcp while Settings has it on.
 * Every call uses the app as it is right now (active workspace and environment, cookies, signed-in tokens), and
 * variables a script sets are saved just as when you press Send.
 */
export function useMcpHost(ws: WorkspaceApi): McpHostStatus {
  const wsRef = useRef(ws); wsRef.current = ws
  const { mcpHostEnabled: enabled, mcpHostPort: port, mcpHostToken: token } = ws.settings
  const [status, setStatus] = useState<McpHostStatus>({ state: 'off' })

  useEffect(() => {
    if (!ws.ready || !isDesktop() || !enabled || !token) { setStatus({ state: 'off' }); return }
    let stopped = false
    let unlisten: (() => void) | null = null
    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<{ id: number; body: string }>('mcp-host-request', async (ev) => {
        const { id, body } = ev.payload
        let answer: string | null
        try {
          answer = await answerOne(body, wsRef.current)
        } catch (e) {
          answer = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } })
        }
        await invoke('mcp_host_reply', { id, body: answer })
      })
      if (stopped) { unlisten(); return }
      try {
        await invoke('mcp_host_start', { port, token })
        if (!stopped) setStatus({ state: 'on', port })
      } catch (e) {
        unlisten(); unlisten = null
        if (!stopped) setStatus({ state: 'error', message: String(e) })
      }
    })()
    return () => {
      stopped = true
      unlisten?.()
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('mcp_host_stop'))
    }
  }, [ws.ready, enabled, port, token])

  return status
}

/** One HTTP body: a JSON-RPC message or a batch. Returns the reply body, or null when nothing needs an answer. */
async function answerOne(body: string, ws: WorkspaceApi): Promise<string | null> {
  let msg: any
  try { msg = JSON.parse(body) } catch { return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
  const one = async (m: any) => {
    const started = Date.now()
    const r = await handleMcp(m, options(ws))
    if (m?.method === 'tools/call') {
      const failed = !!r?.error || !!r?.result?.isError
      ws.log([{ level: failed ? 'warn' : 'info', at: Date.now(), source: 'mcp', text: `AI assistant: ${m.params?.name}${m.params?.arguments?.name ? ` “${m.params.arguments.name}”` : ''}${m.params?.arguments?.folder ? ` “${m.params.arguments.folder}”` : ''} → ${failed ? 'failed' : 'ok'} (${Date.now() - started} ms)` }])
    }
    return r
  }
  if (Array.isArray(msg)) {
    const replies = (await Promise.all(msg.map(one))).filter(Boolean)
    return replies.length ? JSON.stringify(replies) : null
  }
  const r = await one(msg)
  return r ? JSON.stringify(r) : null
}

function options(ws: WorkspaceApi) {
  return {
    ws: { source: 'dispatch' as const, collections: ws.collections, folders: ws.folders, requests: ws.requests, environments: ws.environments, flows: ws.flows, warnings: [] },
    environment: ws.environment, globals: ws.globals, settings: ws.settings,
    transport: ws.transport, pipeline: ws.pipeline.current,
    allowMethods: mcpMethods(ws.settings.mcpHostMethods),
    version, allCollections: true,
    hooks: {
      afterSend: async (x: Parameters<WorkspaceApi['applyChanges']>[0], ctx: Parameters<WorkspaceApi['applyChanges']>[1]) => {
        await ws.applyChanges(x, ctx)
        if (x.authUpdate) await ws.applyAuthUpdate(x.authUpdate)
      },
      afterRun: async (s: { finalEnvironment?: unknown; finalGlobals?: unknown }) => {
        if (s.finalEnvironment && ws.environment) await ws.updateEnvironment({ ...ws.environment, variables: s.finalEnvironment as never })
        if (s.finalGlobals && JSON.stringify(s.finalGlobals) !== JSON.stringify(ws.globals)) await ws.setGlobals(s.finalGlobals as never)
      },
      runFlow: (f: Parameters<WorkspaceApi['runFlowNow']>[0]) => ws.runFlowNow(f, () => {}),
    },
  }
}
