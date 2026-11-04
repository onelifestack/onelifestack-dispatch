import { useMemo } from 'react'
import { collectionMarkdown } from '../core/docs'
import type { WorkspaceApi } from './useWorkspace'
import { Markdown } from './Markdown'
import { saveTextFile } from './files'

/** Documentation for a collection, generated from its requests, docs and examples. */
export function DocsView({ ws, notify, collectionId }: { ws: WorkspaceApi; notify: (m: string) => void; collectionId: string }) {
  const col = ws.collections.find((c) => c.id === collectionId)
  const md = useMemo(() => (col ? collectionMarkdown(col, ws.folders, ws.requests) : ''), [col, ws.folders, ws.requests])
  if (!col) return null
  return (
    <section className="editor docsPage" aria-label="Documentation">
      <div className="row-h">
        <p className="eyebrow">Documentation</p>
        <span className="grow" />
        <button type="button" className="btn small" onClick={async () => {
          try { if (await saveTextFile(`${col.name.replace(/[^\w.-]+/g, '-')}.md`, md, 'text/markdown')) notify('Docs saved as Markdown.') } catch (e) { notify(`Couldn’t save: ${String(e)}`) }
        }}>Export Markdown</button>
        <button type="button" className="btn small" onClick={async () => {
          try { await navigator.clipboard.writeText(md); notify('Markdown copied.') } catch { notify('Couldn’t reach the clipboard.') }
        }}>Copy</button>
      </div>
      <p className="muted small">Built from the collection: request docs, parameters, bodies and saved examples. Secret variable values are never included.</p>
      <Markdown text={md} />
    </section>
  )
}
