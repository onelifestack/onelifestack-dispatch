import type { BrowserStep, BrowserStepKind } from '../core/browser'
import { newStep } from '../core/browser'
import type { RequestDef } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'

const KINDS: [BrowserStepKind, string, string][] = [
  ['goto', 'Open page', 'URL'],
  ['fill', 'Type into', 'CSS selector'],
  ['click', 'Click', 'CSS selector'],
  ['press', 'Press key in', 'CSS selector'],
  ['waitFor', 'Wait for element', 'CSS selector'],
  ['waitUrl', 'Wait until the address contains', 'part of the URL'],
  ['wait', 'Wait', ''],
  ['extractCookie', 'Save cookie', 'cookie name'],
  ['extractStorage', 'Save from storage', 'key'],
  ['extractText', 'Save text of', 'CSS selector'],
]

/** Browser login: steps that log in through a web page and save tokens/cookies for the following requests. */
export function BrowserPane({ ws }: { ws: WorkspaceApi; notify?: (m: string) => void }) {
  const d = ws.draft
  const b = d.browser
  const set = (patch: Partial<RequestDef['browser']>) => ws.setDraft((x) => ({ ...x, browser: { ...x.browser, ...patch } }))
  const setStep = (i: number, patch: Partial<BrowserStep>) => set({ steps: b.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const move = (i: number, dir: -1 | 1) => { const n = [...b.steps]; const j = i + dir; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; set({ steps: n }) }
  const run = ws.result?.browser
  const supported = ws.transport.unrestricted
  return (
    <section className="request realtime" aria-label="Browser login">
      <p className="muted small">Logs in through a real web page in Chrome or Edge (hidden unless you choose to watch), then saves cookies or tokens into the environment as secret variables, so the next requests can use them, e.g. <code>{'Authorization: Bearer {{token}}'}</code>. Use <code>{'{{variables}}'}</code> for the username and password.</p>
      {!supported && <p className="warnLine small">This runs in the desktop app or with <code>dispatch-run</code>; a web page can’t start a browser.</p>}
      <ol className="steps" aria-label="Steps">
        {b.steps.map((st, i) => {
          const meta = KINDS.find((k) => k[0] === st.kind)!
          const res = run?.steps.find((r) => r.id === st.id)
          return (
            <li key={st.id} className={res ? (res.ok ? 'stepOk' : 'stepBad') : ''}>
              <span className="stepNo">{i + 1}</span>
              <select aria-label={`Step ${i + 1} action`} value={st.kind} onChange={(e) => setStep(i, { kind: e.target.value as BrowserStepKind })}>
                {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              {st.kind !== 'wait' && <input className="mono grow" aria-label={`Step ${i + 1} ${meta[2]}`} placeholder={meta[2]} value={st.target} onChange={(e) => setStep(i, { target: e.target.value })} />}
              {(st.kind === 'fill' || st.kind === 'wait' || st.kind === 'press') && (
                <input className="mono" aria-label={`Step ${i + 1} value`} placeholder={st.kind === 'wait' ? 'milliseconds' : st.kind === 'press' ? 'Enter' : 'text, e.g. {{password}}'} value={st.value} onChange={(e) => setStep(i, { value: e.target.value })} />
              )}
              {st.kind === 'extractStorage' && (
                <select aria-label={`Step ${i + 1} storage`} value={st.option || 'local'} onChange={(e) => setStep(i, { option: e.target.value })}><option value="local">localStorage</option><option value="session">sessionStorage</option></select>
              )}
              {st.kind.startsWith('extract') && <input className="mono" aria-label={`Step ${i + 1} save as`} placeholder="save as variable" value={st.saveAs} onChange={(e) => setStep(i, { saveAs: e.target.value })} />}
              <span className="stepTools">
                <button type="button" className="icon" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="icon" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="icon" aria-label={`Remove step ${i + 1}`} onClick={() => set({ steps: b.steps.filter((_, j) => j !== i) })}>×</button>
              </span>
              {res && <span className={`stepNote small ${res.ok ? 'goodText' : 'badText'}`}>{res.ok ? '✓' : '✗'} {res.note} <span className="muted">{res.ms} ms</span></span>}
            </li>
          )
        })}
      </ol>
      <div className="actions">
        <button type="button" className="btn small" onClick={() => set({ steps: [...b.steps, newStep('click')] })}>+ Add step</button>
        <span className="grow" />
        <label className="toggle small"><input type="checkbox" checked={b.show} onChange={(e) => set({ show: e.target.checked })} /> Show the browser</label>
        <label className="toggle small"><input type="checkbox" checked={b.keepCookies} onChange={(e) => set({ keepCookies: e.target.checked })} /> Keep its cookies for later requests</label>
        <button type="button" className="btn primary" disabled={ws.sending || !supported} onClick={() => void ws.send()}>{ws.sending ? 'Logging in…' : 'Run login'}</button>
      </div>
      <details className="small"><summary>Browser settings</summary>
        <label className="field"><span>Chrome / Edge path (empty = find it)</span><input className="mono" value={b.browserPath} onChange={(e) => set({ browserPath: e.target.value })} /></label>
        <label className="field"><span>Timeout per step (seconds)</span><input type="number" min={1} max={300} value={Math.round(b.timeoutMs / 1000)} onChange={(e) => set({ timeoutMs: Math.max(1, Number(e.target.value) || 30) * 1000 })} /></label>
      </details>
      {ws.result && (
        <div className={ws.result.error ? 'errorBox' : 'okBox'} role="status">
          {ws.result.error ?? `Logged in. Saved ${Object.keys(run?.extracted ?? {}).map((k) => `{{${k}}}`).join(', ') || 'nothing'}${ws.environment ? ` in ${ws.environment.name}` : ' in Globals'}${run?.cookies.length ? `; ${run.cookies.length} cookies kept` : ''}.`}
        </div>
      )}
      {ws.result && !ws.result.error && Object.keys(run?.extracted ?? {}).length === 0 && <p className="muted small">Tip: add a “Save cookie” or “Save from storage” step to keep the token.</p>}
    </section>
  )
}
