/**
 * The CodeMirror setup, loaded on demand (it's a sizeable chunk). Languages, {{variable}} highlighting and
 * completion, pm API completion for scripts, GraphQL schema completion, and a theme built on the app's colour tokens.
 */
import { EditorState, Compartment, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as ph, Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { xml } from '@codemirror/lang-xml'
import { html } from '@codemirror/lang-html'
import { tags as t } from '@lezer/highlight'
import type { GraphQLSchema } from 'graphql'

export type Lang = 'json' | 'javascript' | 'xml' | 'html' | 'graphql' | 'text' | 'markdown'

export interface EditorOptions {
  doc: string
  lang: Lang
  readOnly?: boolean
  placeholder?: string
  label: string
  minLines?: number
  onChange?: (v: string) => void
  /** Names offered after "{{". */
  variables?: () => { name: string; detail?: string }[]
  /** GraphQL schema for completion and checks. */
  schema?: GraphQLSchema | null
}

const style = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--cm-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cm-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--cm-number)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--cm-property)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--cm-function)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.tagName, t.typeName, t.className], color: 'var(--cm-type)' },
  { tag: t.invalid, color: 'var(--danger)' },
])

const theme = EditorView.theme({
  '&': { fontSize: '13px', border: '1px solid var(--outline)', borderRadius: '8px', background: 'var(--surface)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--primary)', boxShadow: '0 0 0 2px var(--primary-soft)' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--ink)', padding: '6px 0' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-gutters': { background: 'var(--sunken)', color: 'var(--muted)', border: 'none', borderRadius: '8px 0 0 8px' },
  '.cm-activeLine': { background: 'color-mix(in srgb, var(--primary-soft) 45%, transparent)' },
  '.cm-activeLineGutter': { background: 'var(--primary-soft)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { background: 'var(--primary-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-tooltip': { background: 'var(--surface)', border: '1px solid var(--outline)', borderRadius: '8px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--primary)', color: 'var(--on-primary)' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-var': { color: 'var(--link)', background: 'var(--primary-soft)', borderRadius: '3px' },
  '.cm-foldPlaceholder': { background: 'var(--sunken)', border: '1px solid var(--outline)', color: 'var(--muted)' },
  '.cm-panels': { background: 'var(--surface)', color: 'var(--ink)' },
})

/** Highlights {{variables}}. */
const varMatcher = new MatchDecorator({ regexp: /\{\{[^{}]*\}\}/g, decoration: Decoration.mark({ class: 'cm-var' }) })
const varHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = varMatcher.createDeco(view) }
  update(u: ViewUpdate) { this.decorations = varMatcher.updateDeco(u, this.decorations) }
}, { decorations: (v) => v.decorations })

/** Completion after "{{". */
function variableSource(vars: () => { name: string; detail?: string }[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\{\{\s*[\w$.-]*$/)
    if (!m) return null
    const start = m.from + m.text.indexOf('{{') + 2 + (m.text.slice(m.text.indexOf('{{') + 2).match(/^\s*/)?.[0].length ?? 0)
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2)
    return {
      from: start,
      options: vars().map((v) => ({ label: v.name, detail: v.detail, type: v.name.startsWith('$') ? 'function' : 'variable', apply: after === '}}' ? v.name : `${v.name}}}` })),
      validFor: /^[\w$.-]*$/,
    }
  }
}

/** The pm API, for script completion. */
const PM: Record<string, Completion[]> = {
  pm: ['environment', 'collectionVariables', 'globals', 'variables', 'iterationData', 'request', 'response', 'test', 'expect', 'sendRequest', 'info', 'execution', 'visualizer', 'require']
    .map((label) => ({ label, type: ['test', 'expect', 'sendRequest', 'require'].includes(label) ? 'function' : 'property' })),
  scope: ['get', 'set', 'unset', 'has', 'clear', 'toObject', 'replaceIn'].map((label) => ({ label, type: 'method' })),
  'pm.response': ['code', 'status', 'headers', 'responseTime', 'responseSize', 'json', 'text', 'to'].map((label) => ({ label, type: ['json', 'text'].includes(label) ? 'method' : 'property' })),
  'pm.response.to': ['have', 'be', 'not'].map((label) => ({ label, type: 'property' })),
  'pm.response.to.have': ['status', 'header', 'body', 'jsonBody'].map((label) => ({ label, type: 'method' })),
  'pm.response.to.be': ['ok', 'success', 'clientError', 'serverError', 'notFound', 'json'].map((label) => ({ label, type: 'property' })),
  'pm.request': ['url', 'method', 'headers', 'body', 'name', 'addHeader', 'removeHeader'].map((label) => ({ label, type: 'property' })),
  'pm.request.headers': ['add', 'upsert', 'remove', 'get', 'has', 'toObject'].map((label) => ({ label, type: 'method' })),
  'pm.execution': ['skipRequest', 'setNextRequest', 'location'].map((label) => ({ label, type: 'method' })),
  'pm.info': ['requestName', 'requestId', 'iteration', 'iterationCount', 'eventName'].map((label) => ({ label, type: 'property' })),
  'pm.visualizer': [{ label: 'set', type: 'method', detail: '(template, data)' }],
}
const SCOPES = ['pm.environment', 'pm.collectionVariables', 'pm.globals', 'pm.variables', 'pm.iterationData']

export function pmSource(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/(pm(?:\.[\w]+)*)\.(\w*)$/)
  if (m) {
    const [, obj, partial] = m.text.match(/(pm(?:\.[\w]+)*)\.(\w*)$/)!
    const options = SCOPES.includes(obj) ? PM.scope : PM[obj]
    if (options) return { from: m.to - partial.length, options, validFor: /^\w*$/ }
  }
  const w = ctx.matchBefore(/\b(pm|console)?\w*$/)
  if (w && w.text && ctx.explicit === false && /^p/.test(w.text)) return { from: w.from, options: [{ label: 'pm', type: 'variable' }, { label: 'console', type: 'variable' }] }
  return null
}

async function langExt(o: EditorOptions): Promise<Extension> {
  switch (o.lang) {
    case 'json': return json()
    case 'javascript': return [javascript(), autocompletion({ override: [pmSource, ...(o.variables ? [variableSource(o.variables)] : [])] })]
    case 'xml': return xml()
    case 'html': return html()
    case 'graphql': {
      const { graphql } = await import('cm6-graphql')
      return graphql(o.schema ?? undefined)
    }
    default: return []
  }
}

export interface Editor { view: EditorView; setSchema: (s: GraphQLSchema | null) => void; destroy: () => void }

export async function createEditor(parent: HTMLElement, o: EditorOptions): Promise<Editor> {
  const lang = new Compartment()
  const extensions: Extension[] = [
    theme, syntaxHighlighting(style), drawSelection(), highlightSelectionMatches(), bracketMatching(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': o.label }),
    lang.of(await langExt(o)),
    varHighlight,
    keymap.of([...searchKeymap, ...foldKeymap]),
  ]
  if (o.lang !== 'text' && o.lang !== 'markdown') extensions.push(lineNumbers(), foldGutter(), highlightActiveLineGutter())
  if (o.readOnly) extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
  else {
    extensions.push(history(), indentOnInput(), closeBrackets(), highlightActiveLine(),
      Prec.highest(keymap.of(completionKeymap)),
      keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]))
    if (o.lang !== 'javascript' && o.variables) extensions.push(autocompletion({ override: [variableSource(o.variables)] }))
    if (o.placeholder) extensions.push(ph(o.placeholder))
    extensions.push(EditorView.updateListener.of((u) => { if (u.docChanged) o.onChange?.(u.state.doc.toString()) }))
  }
  if (o.minLines) extensions.push(EditorView.theme({ '.cm-content, .cm-gutter': { minHeight: `${o.minLines * 1.5}em` } }))
  const view = new EditorView({ parent, state: EditorState.create({ doc: o.doc, extensions }) })
  return {
    view,
    setSchema: async (s) => { if (o.lang === 'graphql') view.dispatch({ effects: lang.reconfigure(await langExt({ ...o, schema: s })) }) },
    destroy: () => view.destroy(),
  }
}

/** Replaces the document without losing the cursor when the value changed from outside (e.g. "Tidy"). */
export function syncDoc(view: EditorView, value: string) {
  const cur = view.state.doc.toString()
  if (cur === value) return
  const sel = view.state.selection.main
  view.dispatch({ changes: { from: 0, to: cur.length, insert: value }, selection: { anchor: Math.min(sel.anchor, value.length) } })
}
