import { useEffect, useReducer, useRef, useState } from 'react'
import { HttpWire, LineWire, McpAuthError, McpClient, type McpLogEntry, type McpPrompt, type McpResource, type McpTool, type McpWireAuth, argumentsTemplate } from '../core/mcp'
import { MCP_SUGGESTIONS, type McpSignIn, expiring, findSignIn, refreshSignIn, signIn } from '../core/mcpAuth'
import * as db from '../core/db'
import { shellWords } from '../core/curl'
import { interpolate } from '../core/vars'
import { scopeFor } from '../core/prepare'
import { prepareContext, sendOptions } from '../core/runtime'
import type { RequestDef } from '../core/types'
import { KVTable } from './KVTable'
import { CodeArea } from './CodeArea'
import type { WorkspaceApi } from './useWorkspace'

interface Conn { client: McpClient; tools: McpTool[]; resources: McpResource[]; prompts: McpPrompt[]; log: McpLogEntry[]; listeners: Set<() => void>; label: string }
const conns = new Map<string, Conn>()
/** Commands the user agreed to run this session. */
const approved = new Set<string>()

/** MCP sign-ins (all environments), loaded once and kept in step with the vault. */
let signIns: McpSignIn[] | null = null
const loadSignIns = async () => (signIns ??= await db.getMcpSignIns())
async function saveSignIn(s: McpSignIn | null, remove?: { envId: string | null; serverUrl: string }) {
  const list = (await loadSignIns()).filter((x) => !(x.envId === (s ?? remove)!.envId && x.serverUrl === (s ?? remove)!.serverUrl))
  signIns = s ? [...list, s] : list
  await db.putMcpSignIns(signIns)
}
const ago = (ms: number) => { const m = Math.round(ms / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d` }

/** MCP requests: connect to an MCP server (HTTP, or a local process on desktop), list and call its tools. */
export function McpPane({ ws, notify, confirm, ask }: { ws: WorkspaceApi; notify: (m: string) => void; confirm: (m: string) => Promise<boolean>; ask: (title: string, initial?: string) => Promise<string | null> }) {
  const d = ws.draft
  const m = d.mcp
  const set = (patch: Partial<RequestDef['mcp']>) => ws.setDraft((x) => ({ ...x, mcp: { ...x.mcp, ...patch } }))
  const [, tick] = useReducer((x: number) => x + 1, 0)
  const conn = conns.get(d.id)
  useEffect(() => { if (!conn) return; conn.listeners.add(tick); return () => { conn.listeners.delete(tick) } }, [conn])
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'tools' | 'resources' | 'prompts' | 'log'>('tools')
  const [result, setResult] = useState<any>(null)
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({})
  const fill = (t: string) => interpolate(t, scopeFor(prepareContext(ws.runContext(d), d)))
  const desktop = ws.transport.unrestricted
  const envId = ws.environment?.id ?? null
  const [mine, setMine] = useState<McpSignIn | undefined>(undefined)
  /** The server's 401, when it wants a sign-in. */
  const [needSignIn, setNeedSignIn] = useState<{ www: string | null } | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const serverUrl = m.transport === 'http' && /^https?:\/\//i.test(ws.prepared.url) ? ws.prepared.url : ''
  useEffect(() => { let live = true; void loadSignIns().then((l) => { if (live) setMine(serverUrl ? findSignIn(l, envId, serverUrl) : undefined) }); return () => { live = false } }, [serverUrl, envId])
  const sendOpts = () => sendOptions(d, ws.settings)
  /** Bumped by Sign out, so a refresh still in flight can't save the sign-in again (#15). */
  const authGen = useRef(0)

  /** The token for this server and environment, refreshed first when it has run out. */
  const wireAuth = (): McpWireAuth | undefined => {
    if (!serverUrl) return undefined
    let current = signIns ? findSignIn(signIns, envId, serverUrl) : undefined
    if (!current) return undefined
    const gen = authGen.current
    const renew = async () => {
      if (gen !== authGen.current) return false
      const n = await refreshSignIn(current!, ws.transport, sendOpts())
      if (!n || gen !== authGen.current) return false
      current = n; await saveSignIn(n); setMine(n); return true
    }
    return {
      header: async () => { if (current && expiring(current) && current.refreshToken) await renew(); return current ? `Bearer ${current.accessToken}` : null },
      renew,
    }
  }

  const doSignIn = async () => {
    if (!serverUrl) return
    if (!desktop) { notify('Signing in to an MCP server needs the desktop app. In the web app, paste a token in the request’s Auth tab.'); return }
    setSigningIn(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const s = await signIn({
        serverUrl, envId, wwwAuthenticate: needSignIn?.www ?? null, transport: ws.transport, opts: sendOpts(), previous: mine,
        openAndWait: async (url, redirect) => {
          const r = new URL(redirect)
          const waiting = invoke<string>('oauth_listen', { port: Number(r.port), path: r.pathname, timeoutSecs: 300 })
          await invoke('open_url', { url })
          return waiting
        },
        askClient: async ({ issuer, redirectUri }) => {
          const id = await ask(`This server doesn’t let apps register themselves. Register an OAuth app with ${new URL(issuer).host} using the redirect URL ${redirectUri}, then enter its client ID`)
          if (!id) return null
          const secret = await ask('Client secret (leave empty if the app has none)')
          return { clientId: id, clientSecret: secret ?? '' }
        },
      })
      if (!s) return
      await saveSignIn(s); setMine(s); setNeedSignIn(null)
      notify(`Signed in${ws.environment ? ` for ${ws.environment.name}` : ''}. Connecting…`)
      await connect()
    } catch (e) { notify(e instanceof Error ? e.message : String(e)) } finally { setSigningIn(false) }
  }
  const signOut = async () => {
    if (!mine) return
    // Stop refreshes first, then close the connection (closing sends a request), then forget the sign-in.
    authGen.current++
    await disconnect()
    await saveSignIn(null, { envId: mine.envId, serverUrl: mine.serverUrl }); setMine(undefined)
    notify('Signed out. The token is forgotten on this device.')
  }

  const connect = async () => {
    setBusy(true); setResult(null)
    try {
      await conns.get(d.id)?.client.close().catch(() => {})
      conns.delete(d.id)
      const c: Conn = { client: null as never, tools: [], resources: [], prompts: [], log: [], listeners: new Set(), label: '' }
      const log = (e: McpLogEntry) => { c.log = [...c.log, e].slice(-500); c.listeners.forEach((l) => l()) }
      if (m.transport === 'http') {
        if (!/^https?:\/\//i.test(ws.prepared.url)) { notify('Enter the MCP server’s URL, e.g. http://localhost:3000/mcp.'); return }
        await loadSignIns()
        c.client = new McpClient(new HttpWire(ws.prepared, ws.transport, sendOptions(d, ws.settings), wireAuth()), log)
        c.label = ws.prepared.url
      } else {
        if (!desktop) { notify('Running a local MCP server (stdio) needs the desktop app.'); return }
        const words = shellWords(fill(m.command))
        if (!words.length) { notify('Enter the command that starts the MCP server.'); return }
        const shown = words.join(' ')
        if (!approved.has(shown) && !(await confirm(`Run this command on your computer?\n\n${shown}\n\nOnly run commands you trust, especially from imported collections.`))) return
        approved.add(shown)
        const { invoke } = await import('@tauri-apps/api/core')
        const { listen } = await import('@tauri-apps/api/event')
        const pid = Math.floor(Math.random() * 1e9)
        let wire!: LineWire
        const un = await listen<{ id: number; kind: string; text: string }>('mcp-stdio', (ev) => {
          if (ev.payload.id !== pid) return
          if (ev.payload.kind === 'line') wire.onLine(ev.payload.text)
          else if (ev.payload.kind === 'stderr') log({ dir: 'info', at: Date.now(), message: `stderr: ${ev.payload.text}` })
          else { log({ dir: 'error', at: Date.now(), message: `The server exited (code ${ev.payload.text}).` }); un() }
        })
        wire = new LineWire((line) => invoke('mcp_stdio_send', { id: pid, line }), async () => { un(); await invoke('mcp_stdio_stop', { id: pid }) })
        await invoke('mcp_stdio_start', { id: pid, command: words[0], args: words.slice(1), env: m.env.filter((e) => e.enabled && e.key.trim()).map((e) => [e.key.trim(), fill(e.value)]), cwd: fill(m.cwd) || null })
        c.client = new McpClient(wire, log)
        c.label = shown
      }
      conns.set(d.id, c)
      tick()
      await c.client.initialize()
      ;[c.tools, c.resources, c.prompts] = await Promise.all([c.client.listTools(), c.client.listResources(), c.client.listPrompts()])
      if (!m.tool && c.tools[0]) set({ tool: c.tools[0].name, arguments: argumentsTemplate(c.tools[0].inputSchema) })
      tick()
      setNeedSignIn(null)
      notify(`Connected to ${c.client.serverInfo.name ?? 'the server'}: ${c.tools.length} tools, ${c.resources.length} resources, ${c.prompts.length} prompts.`)
    } catch (e) {
      if (e instanceof McpAuthError) { conns.delete(d.id); tick(); setNeedSignIn({ www: e.wwwAuthenticate }) }
      notify(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }
  const disconnect = async () => { await conn?.client.close().catch(() => {}); conns.delete(d.id); tick() }
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true)
    try { setResult(await what()) } catch (e) { setResult({ error: e instanceof Error ? e.message : String(e) }) } finally { setBusy(false) }
  }
  const tool = conn?.tools.find((t) => t.name === m.tool)

  return (
    <section className="request realtime" aria-label="MCP">
      <div className="mcpConn">
        <label className="field inline"><span>Transport</span>
          <select aria-label="MCP transport" value={m.transport} onChange={(e) => set({ transport: e.target.value as 'http' | 'stdio' })}>
            <option value="http">HTTP (Streamable HTTP)</option><option value="stdio">Local command (stdio){desktop ? '' : ', desktop only'}</option>
          </select>
        </label>
        {m.transport === 'http'
          ? <input className="url mono grow" aria-label="URL" value={d.url} placeholder="http://localhost:3000/mcp" spellCheck={false} onChange={(e) => ws.setDraft((x) => ({ ...x, url: e.target.value }))} />
          : <input className="url mono grow" aria-label="MCP command" value={m.command} placeholder="npx -y @modelcontextprotocol/server-everything" spellCheck={false} onChange={(e) => set({ command: e.target.value })} />}
        {conn ? <button type="button" className="btn" onClick={() => void disconnect()}>Disconnect</button>
          : <button type="button" className="btn primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</button>}
      </div>
      {m.transport === 'http' && <>
        <div className="mcpAuthRow small">
          <label className="field inline"><span className="sr">Suggested servers</span>
            <select aria-label="Suggested servers" value="" onChange={(e) => { const s = MCP_SUGGESTIONS.find((x) => x.url === e.target.value); if (s) { ws.setDraft((x) => ({ ...x, url: s.url, name: x.name && x.name !== 'New request' && x.name !== 'Untitled' ? x.name : s.name })); setNeedSignIn(null) } }}>
              <option value="">Well-known servers…</option>
              <optgroup label="Sign in with your account">{MCP_SUGGESTIONS.filter((s) => s.signIn === 'auto').map((s) => <option key={s.url} value={s.url}>{s.name}</option>)}</optgroup>
              <optgroup label="Sign in with an app you register">{MCP_SUGGESTIONS.filter((s) => s.signIn === 'client').map((s) => <option key={s.url} value={s.url}>{s.name}</option>)}</optgroup>
              <optgroup label="Open, no sign-in">{MCP_SUGGESTIONS.filter((s) => s.signIn === 'none').map((s) => <option key={s.url} value={s.url}>{s.name}</option>)}</optgroup>
            </select>
          </label>
          {mine ? <>
            <span className="goodText">Signed in{ws.environment ? ` for ${ws.environment.name}` : ''}</span>
            <span className="muted">{mine.expiresAt ? (mine.expiresAt > Date.now() ? `token valid for ${ago(mine.expiresAt - Date.now())}` : `token ran out${mine.refreshToken ? '; renews on use' : ''}`) : `since ${ago(Date.now() - mine.signedInAt)} ago`}</span>
            <button type="button" className="btn small" onClick={() => void signOut()}>Sign out</button>
          </> : <span className="muted">Headers and auth come from the request (switch the protocol to HTTP to edit them).</span>}
        </div>
        {needSignIn && !mine && (
          <div className="infoLine small" role="status">
            This server needs you to sign in{ws.environment ? ` (kept for the ${ws.environment.name} environment)` : ''}.{' '}
            {desktop ? <button type="button" className="btn small primary" disabled={signingIn} onClick={() => void doSignIn()}>{signingIn ? 'Waiting for the browser…' : 'Sign in'}</button>
              : <>Signing in needs the desktop app; here, paste a token in the request’s Auth tab.</>}
          </div>
        )}
      </>}
      {m.transport === 'stdio' && (
        <details className="small"><summary>Environment variables and working folder</summary>
          <KVTable label="MCP environment" keyPlaceholder="Name" rows={m.env} onChange={(env) => set({ env })} />
          <label className="field"><span>Working folder</span><input className="mono" value={m.cwd} onChange={(e) => set({ cwd: e.target.value })} /></label>
        </details>
      )}
      {conn && <>
        <p className="small"><b>{conn.client.serverInfo.name ?? 'Server'}</b> {conn.client.serverInfo.version} <span className="muted">· {conn.label}</span></p>
        {conn.client.instructions && <p className="muted small">{conn.client.instructions}</p>}
        <div className="tabs" role="tablist" aria-label="MCP">
          {(['tools', 'resources', 'prompts', 'log'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'log' ? 'Messages' : t[0].toUpperCase() + t.slice(1)}{t !== 'log' && <span className="badge">{conn[t].length}</span>}
            </button>
          ))}
        </div>
        <div className="rtGrid">
          <div>
            {tab === 'tools' && <ul className="mcpList" aria-label="Tools">{conn.tools.map((t) => (
              <li key={t.name}><button type="button" className={`rowMain ${m.tool === t.name ? 'on' : ''}`} onClick={() => { set({ tool: t.name, arguments: argumentsTemplate(t.inputSchema) }); setResult(null) }}>
                <span className="mono">{t.name}</span><span className="tiny muted block">{t.description}</span></button></li>))}</ul>}
            {tab === 'resources' && <ul className="mcpList" aria-label="Resources">{conn.resources.map((r) => (
              <li key={r.uri}><button type="button" className="rowMain" onClick={() => void run(() => conn.client.readResource(r.uri))}>
                <span className="mono">{r.name ?? r.uri}</span><span className="tiny muted block">{r.uri}{r.mimeType ? ` · ${r.mimeType}` : ''}</span></button></li>))}</ul>}
            {tab === 'prompts' && <ul className="mcpList" aria-label="Prompts">{conn.prompts.map((p) => (
              <li key={p.name}>
                <span className="mono">{p.name}</span><span className="tiny muted block">{p.description}</span>
                {(p.arguments ?? []).map((a) => <input key={a.name} className="mono small" placeholder={`${a.name}${a.required ? ' *' : ''}`} aria-label={`${p.name} ${a.name}`} value={promptArgs[`${p.name}.${a.name}`] ?? ''} onChange={(e) => setPromptArgs({ ...promptArgs, [`${p.name}.${a.name}`]: e.target.value })} />)}
                <button type="button" className="btn small" onClick={() => void run(() => conn.client.getPrompt(p.name, Object.fromEntries((p.arguments ?? []).map((a) => [a.name, fill(promptArgs[`${p.name}.${a.name}`] ?? '')]))))}>Get</button>
              </li>))}</ul>}
            {tab === 'log' && <ol className="msgLog" aria-label="MCP messages">{conn.log.map((e, i) => (
              <li key={i} className={`msg ${e.dir}`}><span className="msgMeta">{e.dir === 'out' ? '↑' : e.dir === 'in' ? '↓' : '·'} {new Date(e.at).toLocaleTimeString()}</span>
                <pre className="mono small">{typeof e.message === 'string' ? e.message : JSON.stringify(e.message, null, 2)}</pre></li>))}</ol>}
          </div>
          <div>
            {tab === 'tools' && tool && <>
              <p className="small"><b className="mono">{tool.name}</b> {tool.description}</p>
              <CodeArea label="Tool arguments" lang="json" variables={ws.variableNames} rows={8} value={m.arguments} onChange={(v) => set({ arguments: v })} />
              <div className="actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void run(async () => {
                let args: unknown
                try { args = JSON.parse(fill(m.arguments) || '{}') } catch { throw new Error('The arguments aren’t valid JSON.') }
                return conn.client.callTool(tool.name, args)
              })}>{busy ? 'Calling…' : 'Call tool'}</button></div>
            </>}
            {result && <McpResult value={result} />}
          </div>
        </div>
      </>}
    </section>
  )
}

/** Shows a tool/resource/prompt result: text, images and embedded resources, plus the raw JSON. */
function McpResult({ value }: { value: any }) {
  if (value?.error) return <p className="errorBox" role="alert">{value.error}</p>
  const items: any[] = value?.content ?? value?.contents ?? value?.messages?.map((x: any) => x.content) ?? []
  return (
    <div className="mcpResult" aria-label="Result">
      {value?.isError && <p className="errorBox">The tool reported an error.</p>}
      {items.map((c, i) => c?.type === 'image' ? <img key={i} alt="" className="imgPreview" src={`data:${c.mimeType};base64,${c.data}`} />
        : <pre key={i} className="code mono out small">{c?.text ?? (c?.blob ? `(binary ${c.mimeType ?? ''})` : JSON.stringify(c, null, 2))}</pre>)}
      {value?.structuredContent && <pre className="code mono out small">{JSON.stringify(value.structuredContent, null, 2)}</pre>}
      <details className="small"><summary>Raw result</summary><pre className="code mono out small">{JSON.stringify(value, null, 2)}</pre></details>
    </div>
  )
}
