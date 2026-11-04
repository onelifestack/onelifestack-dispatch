import { useEffect, useRef, useState } from 'react'
import type { GraphQLSchema } from 'graphql'
import type { Editor, Lang } from './editor/codemirror'

interface Props {
  label: string
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  mono?: boolean
  readOnly?: boolean
  lang?: Lang
  /** Names offered after "{{". */
  variables?: () => { name: string; detail?: string }[]
  schema?: GraphQLSchema | null
}

/** CodeMirror is used in real browsers; the test DOM (jsdom) gets a plain textarea. */
const rich = typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)

/**
 * A code editor: a plain textarea first, upgraded to CodeMirror once it has loaded (it's loaded on demand).
 * Same props either way, so callers don't care which one they got.
 */
export function CodeArea({ label, value, onChange, rows = 10, placeholder, mono = true, readOnly, lang = 'text', variables, schema }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<Editor | null>(null)
  const [ready, setReady] = useState(false)
  // Keep the latest callbacks without rebuilding the editor.
  const latest = useRef({ onChange, variables })
  latest.current = { onChange, variables }
  // Values this editor produced itself. React hands them back a little later; those must not be "synced" back
  // into the editor, or fast typing loses characters. Only values from elsewhere (Tidy, snippets) are synced.
  const emitted = useRef<string[]>([])

  useEffect(() => {
    if (!rich || !host.current) return
    let gone = false
    void import('./editor/codemirror').then(async ({ createEditor }) => {
      if (gone || !host.current) return
      ed.current = await createEditor(host.current, {
        doc: value, lang, readOnly, placeholder, label, minLines: Math.min(rows, 14),
        onChange: (v) => { emitted.current = [...emitted.current.slice(-49), v]; latest.current.onChange(v) },
        variables: () => latest.current.variables?.() ?? [], schema,
      })
      if (gone) { ed.current.destroy(); ed.current = null; return }
      setReady(true)
    })
    return () => { gone = true; ed.current?.destroy(); ed.current = null; setReady(false) }
  }, [lang, readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  // Outside changes (Tidy, snippets, templates) flow into the editor.
  useEffect(() => {
    if (!ed.current || emitted.current.includes(value)) return
    void import('./editor/codemirror').then(({ syncDoc }) => ed.current && syncDoc(ed.current.view, value))
  }, [value])
  useEffect(() => { ed.current?.setSchema(schema ?? null) }, [schema, ready])

  if (rich) {
    return (
      <div className={`cmHost ${ready ? 'ready' : ''}`}>
        {!ready && <textarea className={`code ${mono ? 'mono' : ''}`} value={value} aria-label={label} rows={rows} readOnly={readOnly} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />}
        <div ref={host} />
      </div>
    )
  }
  return (
    <textarea className={`code ${mono ? 'mono' : ''}`} value={value} aria-label={label} spellCheck={false} rows={rows} placeholder={placeholder} readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Tab' || e.shiftKey || readOnly || !mono) return
        e.preventDefault()
        const t = e.currentTarget; const s = t.selectionStart
        onChange(t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd))
        requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2 })
      }} />
  )
}
