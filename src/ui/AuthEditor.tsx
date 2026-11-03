import type { Auth, AuthKind } from '../core/types'

const LABELS: Record<AuthKind, string> = {
  inherit: 'Inherit from collection', none: 'No auth', basic: 'Basic auth', bearer: 'Bearer token', apikey: 'API key',
}

interface Props { auth: Auth; onChange: (a: Auth) => void; allowInherit: boolean; inheritedHint?: string }

export function AuthEditor({ auth, onChange, allowInherit, inheritedHint }: Props) {
  const kinds = (Object.keys(LABELS) as AuthKind[]).filter((k) => allowInherit || k !== 'inherit')
  const set = (patch: Partial<Auth>) => onChange({ ...auth, ...patch })
  return (
    <div className="auth">
      <label className="field">
        <span>Type</span>
        <select aria-label="Auth type" value={auth.kind} onChange={(e) => set({ kind: e.target.value as AuthKind })}>
          {kinds.map((k) => <option key={k} value={k}>{LABELS[k]}</option>)}
        </select>
      </label>
      {auth.kind === 'inherit' && <p className="muted small">{inheritedHint}</p>}
      {auth.kind === 'none' && <p className="muted small">No Authorization header is added.</p>}
      {auth.kind === 'basic' && <>
        <label className="field"><span>Username</span><input className="mono" value={auth.username} onChange={(e) => set({ username: e.target.value })} spellCheck={false} /></label>
        <label className="field"><span>Password</span><input className="mono" type="password" value={auth.password} onChange={(e) => set({ password: e.target.value })} /></label>
      </>}
      {auth.kind === 'bearer' && (
        <label className="field"><span>Token</span><input className="mono" type="password" value={auth.token} placeholder="{{token}}" onChange={(e) => set({ token: e.target.value })} spellCheck={false} /></label>
      )}
      {auth.kind === 'apikey' && <>
        <label className="field"><span>Key</span><input className="mono" value={auth.key} placeholder="X-API-Key" onChange={(e) => set({ key: e.target.value })} spellCheck={false} /></label>
        <label className="field"><span>Value</span><input className="mono" type="password" value={auth.value} onChange={(e) => set({ value: e.target.value })} spellCheck={false} /></label>
        <label className="field"><span>Send in</span>
          <select aria-label="Send API key in" value={auth.in} onChange={(e) => set({ in: e.target.value as Auth['in'] })}>
            <option value="header">Header</option><option value="query">Query params</option>
          </select>
        </label>
      </>}
      {auth.kind !== 'none' && auth.kind !== 'inherit' && <p className="muted small">Tip: use <code>{'{{variables}}'}</code> so secrets live in an environment, not in the request.</p>}
    </div>
  )
}

export const authLabel = (k: AuthKind) => LABELS[k]
