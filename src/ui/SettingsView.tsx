import { useEffect, useReducer, useState } from 'react'
import type { ClientCert } from '../core/types'
import { uid } from '../core/types'
import { CookieTransport } from '../core/transport'
import type { StoredCookie } from '../core/cookies'
import type { WorkspaceApi } from './useWorkspace'

const readText = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Couldn’t read that file.')); r.readAsText(file)
})

function PemPick({ label, onText, notify }: { label: string; onText: (t: string) => void; notify: (m: string) => void }) {
  return (
    <label className="btn small">{label}
      <input type="file" className="sr" accept=".pem,.crt,.cer,.key,text/plain" aria-label={label} onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ''
        if (!f) return
        const t = await readText(f)
        if (!/-----BEGIN [A-Z ]+-----/.test(t)) { notify(`${f.name} isn’t a PEM file (it should start with -----BEGIN …).`); return }
        onText(t)
      }} />
    </label>
  )
}

/** App settings: general, network (proxy, CA certificates, client certificates). */
export function SettingsView({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const st = ws.settings
  const desktop = ws.transport.unrestricted
  const setCert = (id: string, patch: Partial<ClientCert>) => ws.setSettings({ clientCerts: st.clientCerts.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  return (
    <section className="editor" aria-label="Settings">
      <p className="eyebrow">Settings</p>
      <h1 className="titleInput">Settings</h1>
      <h2>General</h2>
      <div className="auth">
        <label className="field"><span>Theme</span>
          <select value={st.theme} onChange={(e) => ws.setSettings({ theme: e.target.value as 'system' | 'light' | 'dark' })}>
            <option value="system">Same as the system</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
        <label className="field"><span>Timeout (seconds)</span>
          <input type="number" min={1} max={600} value={Math.round(st.timeoutMs / 1000)} onChange={(e) => ws.setSettings({ timeoutMs: Math.min(600, Math.max(1, Number(e.target.value) || 30)) * 1000 })} />
        </label>
        <label className="toggle"><input type="checkbox" checked={st.followRedirects} onChange={(e) => ws.setSettings({ followRedirects: e.target.checked })} /> Follow redirects</label>
        {desktop && <>
          <label className="toggle"><input type="checkbox" checked={st.cookieJar} onChange={(e) => ws.setSettings({ cookieJar: e.target.checked })} /> Keep cookies between requests</label>
          <label className="toggle"><input type="checkbox" checked={st.insecureTls} onChange={(e) => ws.setSettings({ insecureTls: e.target.checked })} /> Accept any TLS certificate (self-signed). Safer: add your CA below instead.</label>
        </>}
      </div>
      {!desktop && <p className="warnLine small">Proxy and certificate settings are for the desktop app; in the browser, the browser’s own settings apply.</p>}
      {desktop && <>
        <h2>Proxy</h2>
        <div className="auth">
          <label className="field"><span>Proxy URL (http://, https:// or socks5://; empty for none)</span>
            <input className="mono" value={st.proxyUrl} placeholder="http://proxy.local:3128" onChange={(e) => ws.setSettings({ proxyUrl: e.target.value })} />
          </label>
          <label className="field"><span>Don’t use the proxy for (comma separated)</span>
            <input className="mono" value={st.proxyBypass} onChange={(e) => ws.setSettings({ proxyBypass: e.target.value })} />
          </label>
        </div>
        <h2>CA certificates</h2>
        <p className="muted small">Trusted in addition to the usual ones, e.g. your homelab’s own CA. Paste or load PEM.</p>
        {st.caCerts.map((pem, i) => (
          <div key={i} className="certRow">
            <textarea className="code mono small" rows={3} aria-label={`CA certificate ${i + 1}`} value={pem} onChange={(e) => ws.setSettings({ caCerts: st.caCerts.map((x, j) => (j === i ? e.target.value : x)) })} />
            <button type="button" className="icon" aria-label={`Remove CA certificate ${i + 1}`} onClick={() => ws.setSettings({ caCerts: st.caCerts.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <div className="actions">
          <PemPick label="Load CA certificate…" notify={notify} onText={(t) => ws.setSettings({ caCerts: [...st.caCerts, t] })} />
          <button type="button" className="btn small ghost" onClick={() => ws.setSettings({ caCerts: [...st.caCerts, ''] })}>Paste one</button>
        </div>
        <h2>Client certificates (mutual TLS)</h2>
        <p className="muted small">Sent to the matching host only. Use <code>*.example.com</code> for all subdomains, and <code>:port</code> to limit to one port. Keys are stored encrypted.</p>
        {st.clientCerts.map((c) => (
          <div key={c.id} className="certCard">
            <div className="row-h">
              <label className="toggle"><input type="checkbox" checked={c.enabled} onChange={(e) => setCert(c.id, { enabled: e.target.checked })} /> On</label>
              <input className="mono grow" aria-label="Certificate host" value={c.host} placeholder="api.example.com" onChange={(e) => setCert(c.id, { host: e.target.value })} />
              <button type="button" className="btn small danger" onClick={() => ws.setSettings({ clientCerts: st.clientCerts.filter((x) => x.id !== c.id) })}>Remove</button>
            </div>
            <div className="certPair">
              <div><span className="small muted">Certificate</span> {c.cert ? <span className="small goodText">loaded</span> : <span className="small warnText">missing</span>} <PemPick label="Load certificate…" notify={notify} onText={(t) => setCert(c.id, { cert: t })} /></div>
              <div><span className="small muted">Private key</span> {c.key ? <span className="small goodText">loaded</span> : <span className="small warnText">missing</span>} <PemPick label="Load key…" notify={notify} onText={(t) => {
                if (/ENCRYPTED/.test(t)) { notify('That key is password-protected; export it without a password (PEM) first.'); return }
                setCert(c.id, { key: t })
              }} /></div>
            </div>
          </div>
        ))}
        <div className="actions"><button type="button" className="btn small" onClick={() => ws.setSettings({ clientCerts: [...st.clientCerts, { id: uid(), host: '', cert: '', key: '', enabled: true }] })}>+ Add certificate</button></div>
      </>}
    </section>
  )
}

/** The desktop cookie jar: see, edit and delete cookies. */
export function CookiesView({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const [, tick] = useReducer((x: number) => x + 1, 0)
  const [q, setQ] = useState('')
  const jar = ws.transport instanceof CookieTransport ? ws.transport.jar : null
  useEffect(() => {
    if (!jar) return
    const prev = jar.onChange
    jar.onChange = () => { prev?.(); tick() }
    return () => { jar.onChange = prev }
  }, [jar])
  if (!jar) return <section className="editor" aria-label="Cookies"><p className="eyebrow">Cookies</p><p className="muted">In the browser, cookies belong to the browser. The desktop app keeps its own cookie jar you can manage here.</p></section>
  const list = jar.entries().filter((c) => !q || `${c.host} ${c.name} ${c.value}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name))
  const add = () => jar.set({ host: 'example.com', name: 'name', value: 'value', path: '/', expiresAt: null })
  return (
    <section className="editor wide" aria-label="Cookies">
      <p className="eyebrow">Cookies</p>
      <h1 className="titleInput">Cookie jar</h1>
      <p className="muted small">Cookies the servers you call have set. They’re sent back on later requests to the same site, kept encrypted on this device.</p>
      <div className="actions">
        <input type="search" placeholder="Filter" aria-label="Filter cookies" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn small" onClick={add}>+ Add cookie</button>
        <button type="button" className="btn small danger" disabled={!jar.entries().length} onClick={() => { jar.clear(); notify('All cookies cleared.') }}>Clear all</button>
      </div>
      <table className="resultTable" aria-label="Cookies">
        <thead><tr><th>Domain</th><th>Name</th><th>Value</th><th>Path</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {list.map((c: StoredCookie) => {
            const upd = (patch: Partial<StoredCookie>) => { jar.remove(c.host, c.name, c.path); jar.set({ ...c, ...patch }) }
            return (
              <tr key={`${c.host}|${c.name}|${c.path}`}>
                <td><input className="mono small" aria-label={`Domain of ${c.name}`} defaultValue={c.host} onBlur={(e) => e.target.value !== c.host && upd({ host: e.target.value.trim().toLowerCase() })} /></td>
                <td><input className="mono small" aria-label={`Name of ${c.name}`} defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && upd({ name: e.target.value.trim() })} /></td>
                <td><input className="mono small" aria-label={`Value of ${c.name}`} defaultValue={c.value} onBlur={(e) => e.target.value !== c.value && upd({ value: e.target.value })} /></td>
                <td className="mono small">{c.path}</td>
                <td className="small">{c.expiresAt ? new Date(c.expiresAt).toLocaleString() : 'session'}</td>
                <td><button type="button" className="icon" aria-label={`Delete cookie ${c.name}`} onClick={() => jar.remove(c.host, c.name, c.path)}>×</button></td>
              </tr>
            )
          })}
          {!list.length && <tr><td colSpan={6} className="muted small">No cookies yet.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}
