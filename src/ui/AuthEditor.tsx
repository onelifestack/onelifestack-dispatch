import type { Auth, AuthKind, OAuth2Grant } from '../core/types'

const LABELS: Record<AuthKind, string> = {
  inherit: 'Inherit from parent', none: 'No auth', basic: 'Basic auth', bearer: 'Bearer token', apikey: 'API key',
  digest: 'Digest auth', oauth2: 'OAuth 2.0', jwt: 'JWT bearer', awsv4: 'AWS Signature v4',
}

interface Props {
  auth: Auth
  onChange: (a: Auth) => void
  allowInherit: boolean
  inheritedHint?: string
  /** OAuth 2: fetches a token with the current settings. */
  onGetToken?: () => void
  gettingToken?: boolean
}

function Field({ label, value, onChange, secret, placeholder, mono = true }: { label: string; value: string; onChange: (v: string) => void; secret?: boolean; placeholder?: string; mono?: boolean }) {
  return (
    <label className="field"><span>{label}</span>
      <input className={mono ? 'mono' : ''} type={secret ? 'password' : 'text'} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export function AuthEditor({ auth, onChange, allowInherit, inheritedHint, onGetToken, gettingToken }: Props) {
  const kinds = (Object.keys(LABELS) as AuthKind[]).filter((k) => allowInherit || k !== 'inherit')
  const set = (patch: Partial<Auth>) => onChange({ ...auth, ...patch })
  const f = (label: string, key: keyof Auth, extra: { secret?: boolean; placeholder?: string } = {}) =>
    <Field label={label} value={String(auth[key] ?? '')} onChange={(v) => set({ [key]: v } as Partial<Auth>)} {...extra} />

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
      {(auth.kind === 'basic' || auth.kind === 'digest') && <>
        {f('Username', 'username')}
        {f('Password', 'password', { secret: true })}
        {auth.kind === 'digest' && <p className="muted small">The first request gets the server’s challenge; Dispatch answers it and sends again (MD5 and SHA-256, qop auth).</p>}
      </>}
      {auth.kind === 'bearer' && f('Token', 'token', { secret: true, placeholder: '{{token}}' })}
      {auth.kind === 'apikey' && <>
        {f('Key', 'key', { placeholder: 'X-API-Key' })}
        {f('Value', 'value', { secret: true })}
        <label className="field"><span>Send in</span>
          <select aria-label="Send API key in" value={auth.in} onChange={(e) => set({ in: e.target.value as Auth['in'] })}>
            <option value="header">Header</option><option value="query">Query params</option>
          </select>
        </label>
      </>}
      {auth.kind === 'jwt' && <>
        <label className="field"><span>Algorithm</span>
          <select aria-label="JWT algorithm" value={auth.algorithm} onChange={(e) => set({ algorithm: e.target.value as Auth['algorithm'] })}>
            <option>HS256</option><option>HS384</option><option>HS512</option>
          </select>
        </label>
        {f('Secret', 'secret', { secret: true })}
        <label className="field"><span>Payload (JSON)</span>
          <textarea className="code mono" rows={5} value={auth.payload} spellCheck={false} onChange={(e) => set({ payload: e.target.value })} />
        </label>
        {f('Header prefix', 'headerPrefix', { placeholder: 'Bearer' })}
        <p className="muted small">Signed fresh for every request; <code>iat</code> is added when the payload doesn’t set it.</p>
      </>}
      {auth.kind === 'awsv4' && <>
        {f('Access key', 'accessKey')}
        {f('Secret key', 'secretKey', { secret: true })}
        {f('Session token (optional)', 'sessionToken', { secret: true })}
        {f('Region', 'region', { placeholder: 'us-east-1' })}
        {f('Service', 'service', { placeholder: 'execute-api' })}
      </>}
      {auth.kind === 'oauth2' && <>
        <label className="field"><span>Grant type</span>
          <select aria-label="Grant type" value={auth.grant} onChange={(e) => set({ grant: e.target.value as OAuth2Grant })}>
            <option value="client_credentials">Client credentials</option>
            <option value="password">Password</option>
            <option value="authorization_code">Authorization code</option>
          </select>
        </label>
        {auth.grant === 'authorization_code' && f('Authorization URL', 'authUrl', { placeholder: 'https://auth.example.com/authorize' })}
        {f('Token URL', 'tokenUrl', { placeholder: 'https://auth.example.com/token' })}
        {f('Client ID', 'clientId')}
        {f('Client secret', 'clientSecret', { secret: true })}
        {auth.grant === 'password' && <>{f('Username', 'username')}{f('Password', 'password', { secret: true })}</>}
        {f('Scope', 'scope', { placeholder: 'read write' })}
        {auth.grant === 'authorization_code' && <>
          {f('Redirect URI', 'redirectUri')}
          <label className="toggle"><input type="checkbox" checked={auth.usePkce} onChange={(e) => set({ usePkce: e.target.checked })} /> Use PKCE (S256)</label>
        </>}
        <label className="field"><span>Send client credentials</span>
          <select aria-label="Client authentication" value={auth.clientAuth} onChange={(e) => set({ clientAuth: e.target.value as Auth['clientAuth'] })}>
            <option value="header">As Basic auth header</option><option value="body">In the request body</option>
          </select>
        </label>
        <div className="tokenBox">
          <div className="grow">
            <span className="small muted">Current token</span>
            <div className="mono small tokenText">{auth.accessToken ? `${auth.accessToken.slice(0, 24)}…` : 'none yet'}</div>
            {auth.accessToken && auth.expiresAt > 0 && (
              <span className={`small ${auth.expiresAt < Date.now() ? 'warnText' : 'muted'}`}>
                {auth.expiresAt < Date.now() ? 'Expired' : `Expires ${new Date(auth.expiresAt).toLocaleTimeString()}`}{auth.refreshToken ? ' · refreshes automatically' : ''}
              </span>
            )}
          </div>
          {onGetToken && <button type="button" className="btn" disabled={gettingToken} onClick={onGetToken}>{gettingToken ? 'Getting token…' : 'Get new token'}</button>}
          {auth.accessToken && <button type="button" className="btn ghost" onClick={() => set({ accessToken: '', refreshToken: '', expiresAt: 0 })}>Clear</button>}
        </div>
      </>}
      {!['none', 'inherit'].includes(auth.kind) && <p className="muted small">Tip: use <code>{'{{variables}}'}</code> so secrets live in an environment, not in the request.</p>}
    </div>
  )
}

export const authLabel = (k: AuthKind) => LABELS[k]
