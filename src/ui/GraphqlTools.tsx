import { useMemo, useState } from 'react'
import { type GraphQLSchema, checkQuery, fetchSchema, rootFields, starterQuery, typeFields } from '../core/graphql'
import type { WorkspaceApi } from './useWorkspace'

/** Schemas fetched this session, by URL, so switching tabs doesn't refetch. */
const cache = new Map<string, GraphQLSchema>()

/** GraphQL extras under the query editor: fetch schema, problems, and an explorer that inserts starter operations. */
export function GraphqlTools({ ws, notify }: { ws: WorkspaceApi; notify: (m: string) => void }) {
  const url = ws.prepared.url
  const [schema, setSchema] = useState<GraphQLSchema | null>(() => cache.get(url) ?? null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const problems = useMemo(() => checkQuery(ws.draft.body.text, schema), [ws.draft.body.text, schema])
  const roots = useMemo(() => (schema ? rootFields(schema) : []), [schema])

  const load = async () => {
    setLoading(true)
    try {
      const s = await fetchSchema(ws.prepared, ws.transport, { timeoutMs: ws.settings.timeoutMs, followRedirects: true, insecureTls: ws.settings.insecureTls })
      cache.set(url, s); setSchema(s)
      notify(`Schema loaded: ${Object.keys(s.getTypeMap()).filter((n) => !n.startsWith('__')).length} types.`)
    } catch (e) { notify(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  const insert = (kind: 'query' | 'mutation' | 'subscription', name: string) => {
    if (!schema) return
    const s = starterQuery(schema, kind, name)
    ws.setDraft((d) => ({ ...d, method: 'POST', body: { ...d.body, text: s.query, graphqlVariables: s.variables } }))
  }

  return (
    <div className="gqlTools">
      <div className="row-h">
        <button type="button" className="btn small" disabled={loading || !url} onClick={() => void load()}>{loading ? 'Fetching schema…' : schema ? 'Refresh schema' : 'Fetch schema'}</button>
        <span className="small muted grow">{schema ? 'Checked against the schema.' : 'Syntax is checked; fetch the schema to check fields and get the explorer.'}</span>
        {problems.length === 0 && ws.draft.body.text.trim() && <span className="small goodText">✓ Looks valid</span>}
      </div>
      {problems.length > 0 && (
        <ul className="gqlProblems" aria-label="GraphQL problems">
          {problems.slice(0, 6).map((p, i) => <li key={i} className="small badText">{p.line ? `Line ${p.line}: ` : ''}{p.message}</li>)}
        </ul>
      )}
      {schema && (
        <details className="gqlExplorer">
          <summary className="small">Schema explorer</summary>
          {roots.map((r) => (
            <div key={r.kind}>
              <p className="eyebrow">{r.kind}</p>
              <ul className="gqlFields">
                {r.fields.map((f) => (
                  <li key={f.name}>
                    <button type="button" className="linkBtn mono small" title="Insert a starter operation" onClick={() => insert(r.kind, f.name)}>{f.name}</button>
                    <span className="mono tiny muted">{f.args && `(${f.args})`}: </span>
                    <button type="button" className="linkBtn mono tiny" onClick={() => setOpen(open === f.type ? null : f.type)}>{f.type}</button>
                    {f.description && <span className="tiny muted block">{f.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {open && (() => {
            const name = open.replace(/[[\]!]/g, '')
            const t = typeFields(schema, name)
            return (
              <div className="gqlType">
                <p className="eyebrow">type {name}</p>
                {t.fields.map((f) => <div key={f.name} className="mono tiny"><b>{f.name}</b>{f.args && `(${f.args})`}: {f.type}</div>)}
                {t.values.length > 0 && <div className="mono tiny">{t.values.join(' | ')}</div>}
              </div>
            )
          })()}
        </details>
      )}
    </div>
  )
}
