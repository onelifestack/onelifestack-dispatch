import { useMemo, useState } from 'react'
import { LANGUAGES, generateCode } from '../core/codegen'
import type { WorkspaceApi } from './useWorkspace'

const KEY = 'dispatch.codeLang'
const saved = () => { try { return localStorage.getItem(KEY) ?? 'curl' } catch { return 'curl' } }

/** "</> Code": the request as code in a dozen languages, with variables and auth filled in. */
export function CodePanel({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const [lang, setLang] = useState(saved)
  const code = useMemo(() => (open ? generateCode(lang, ws.prepared) : ''), [open, lang, ws.prepared])
  const scripted = ['jwt', 'awsv4', 'digest'].includes(ws.draft.auth.kind)
  return (
    <details className="menu codePanel" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="btn small ghost" aria-label="Code">{'</>'} Code</summary>
      {open && (
        <div className="menuList right codeList" role="dialog" aria-label="Request as code">
          <div className="row-h">
            <select aria-label="Language" value={lang} onChange={(e) => { setLang(e.target.value); try { localStorage.setItem(KEY, e.target.value) } catch { /* private mode */ } }}>
              {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <button type="button" className="btn small primary" onClick={async () => {
              try { await navigator.clipboard.writeText(code); notify('Code copied.') } catch { notify('Couldn’t reach the clipboard; select the code and copy it.') }
            }}>Copy</button>
          </div>
          <pre className="code mono out small" tabIndex={0}>{code}</pre>
          <p className="tiny muted">Variables and auth are filled in{scripted ? '; JWT, AWS and Digest signatures are made at send time and aren’t included' : ''}. Scripts don’t run here. Watch out for secrets before sharing.</p>
        </div>
      )}
    </details>
  )
}
