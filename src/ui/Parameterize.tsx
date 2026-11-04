import { useMemo, useState } from 'react'
import { type KnownVar, type Suggestion, applySuggestions, suggest } from '../core/parameterize'
import type { KV } from '../core/types'
import type { WorkspaceApi } from './useWorkspace'

/** Suggests turning hard-coded parts of the open request into variables, and applies the chosen ones. */
export function ParameterizePanel({ ws, notify, onClose }: { ws: WorkspaceApi; notify: (m: string) => void; onClose: () => void }) {
  const known = useMemo<KnownVar[]>(() => {
    const out: KnownVar[] = []
    const add = (rows: KV[] | undefined, from: string) => rows?.forEach((v) => { if (v.enabled && v.key.trim() && v.value) out.push({ key: v.key.trim(), value: v.value, from }) })
    add(ws.environment?.variables, ws.environment?.name ?? 'the environment'); add(ws.collection?.variables, ws.collection?.name ?? 'the collection'); add(ws.globals, 'Globals')
    return out
  }, [ws.environment, ws.collection, ws.globals])
  const suggestions = useMemo(() => suggest(ws.draft, known), [ws.draft, known])
  const [off, setOff] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<string>(() => (ws.environment ? `env:${ws.environment.id}` : ws.collection ? 'collection' : 'new-env'))
  const chosen = suggestions.filter((s) => !off.has(s.id))
  const creating = chosen.filter((s) => s.create)

  const apply = async () => {
    const { request, create } = applySuggestions(ws.draft, chosen)
    if (create.length) {
      const merge = (rows: KV[]) => [...rows, ...create.filter((c) => !rows.some((r) => r.key === c.key))]
      if (target.startsWith('env:')) {
        const e = ws.environments.find((x) => `env:${x.id}` === target)
        if (e) await ws.updateEnvironment({ ...e, variables: merge(e.variables) })
      } else if (target === 'collection' && ws.collection) await ws.updateCollection({ ...ws.collection, variables: merge(ws.collection.variables) })
      else if (target === 'globals') await ws.setGlobals(merge(ws.globals))
      else {
        const e = await ws.addEnvironment('Default')
        await ws.updateEnvironment({ ...e, variables: create })
        ws.setSettings({ activeEnvId: e.id })
      }
    }
    ws.setDraft(() => request)
    notify(`Parameterized: ${chosen.length} change${chosen.length === 1 ? '' : 's'}${create.length ? `, ${create.length} new variable${create.length === 1 ? '' : 's'}` : ''}.`)
    onClose()
  }

  return (
    <div className="paramPanel" role="dialog" aria-label="Parameterize">
      <div className="row-h"><strong>Turn hard-coded values into variables</strong><button type="button" className="icon" aria-label="Close" onClick={onClose}>×</button></div>
      {!suggestions.length ? <p className="muted small">Nothing to change: no hard-coded base URL, credentials or IDs, and no values that match your variables.</p> : <>
        <ul className="paramList">
          {suggestions.map((s: Suggestion) => (
            <li key={s.id}>
              <label className="toggle">
                <input type="checkbox" checked={!off.has(s.id)} onChange={(e) => setOff((o) => { const n = new Set(o); if (e.target.checked) n.delete(s.id); else n.add(s.id); return n })} />
                <span><b>{s.title}</b> <span className="muted small">{s.detail}</span></span>
              </label>
            </li>
          ))}
        </ul>
        {creating.length > 0 && (
          <label className="field inline"><span>Create {creating.map((s) => s.varName).join(', ')} in</span>
            <select aria-label="Where to create variables" value={target} onChange={(e) => setTarget(e.target.value)}>
              {ws.environments.map((e) => <option key={e.id} value={`env:${e.id}`}>{e.name} (environment)</option>)}
              {ws.collection && <option value="collection">{ws.collection.name} (collection)</option>}
              <option value="globals">Globals</option>
              <option value="new-env">A new environment “Default”</option>
            </select>
          </label>
        )}
        {creating.some((s) => s.secret) && <p className="small muted">Tokens and keys are created as secret variables (hidden, encrypted, left out of exports).</p>}
        <div className="actions"><button type="button" className="btn primary" disabled={!chosen.length} onClick={() => void apply()}>Apply {chosen.length}</button></div>
      </>}
    </div>
  )
}
