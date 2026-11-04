/**
 * A small JSONPath subset for filtering responses: $ (root), .key, ['key'], [n], [-n], [*], .*, ..key (recursive),
 * [a,b] (several keys or indexes) and [start:end]. Returns every match.
 */
export function queryJson(data: unknown, path: string): unknown[] {
  const tokens = tokenize(path.trim())
  let current: unknown[] = [data]
  for (const t of tokens) {
    const next: unknown[] = []
    for (const v of current) {
      if (t.kind === 'recurse') { collect(v, t.key, next); continue }
      if (v === null || typeof v !== 'object') continue
      if (t.kind === 'wild') { next.push(...(Array.isArray(v) ? v : Object.values(v as object))); continue }
      if (t.kind === 'slice') {
        if (!Array.isArray(v)) continue
        const n = v.length
        const s = t.start == null ? 0 : t.start < 0 ? n + t.start : t.start
        const e = t.end == null ? n : t.end < 0 ? n + t.end : t.end
        next.push(...v.slice(s, e))
        continue
      }
      for (const k of t.keys) {
        if (Array.isArray(v) && typeof k === 'number') { const i = k < 0 ? v.length + k : k; if (i >= 0 && i < v.length) next.push(v[i]) }
        else if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, k)) next.push((v as Record<string, unknown>)[String(k)])
      }
    }
    current = next
  }
  return current
}

type Token =
  | { kind: 'keys'; keys: (string | number)[] }
  | { kind: 'wild' }
  | { kind: 'recurse'; key: string | null }
  | { kind: 'slice'; start: number | null; end: number | null }

function collect(v: unknown, key: string | null, out: unknown[]) {
  if (v === null || typeof v !== 'object') return
  for (const [k, child] of Object.entries(v as object)) {
    if (key === null || k === key) out.push(child)
    collect(child, key, out)
  }
}

function tokenize(path: string): Token[] {
  const tokens: Token[] = []
  let i = path.startsWith('$') ? 1 : 0
  const ident = () => { const m = path.slice(i).match(/^[^.[\]\s]+/); if (!m) throw new Error(`Expected a name at position ${i + 1}.`); i += m[0].length; return m[0] }
  while (i < path.length) {
    if (path.startsWith('..', i)) {
      i += 2
      if (path[i] === '*') { i++; tokens.push({ kind: 'recurse', key: null }) }
      else tokens.push({ kind: 'recurse', key: ident() })
    } else if (path[i] === '.') {
      i++
      if (path[i] === '*') { i++; tokens.push({ kind: 'wild' }) } else tokens.push({ kind: 'keys', keys: [ident()] })
    } else if (path[i] === '[') {
      const end = path.indexOf(']', i)
      if (end < 0) throw new Error('Missing ].')
      const inner = path.slice(i + 1, end).trim()
      i = end + 1
      if (inner === '*') { tokens.push({ kind: 'wild' }); continue }
      const slice = inner.match(/^(-?\d*):(-?\d*)$/)
      if (slice) { tokens.push({ kind: 'slice', start: slice[1] ? Number(slice[1]) : null, end: slice[2] ? Number(slice[2]) : null }); continue }
      const keys = inner.split(',').map((p) => {
        const s = p.trim()
        if (/^-?\d+$/.test(s)) return Number(s)
        const q = s.match(/^(['"])(.*)\1$/)
        if (q) return q[2]
        throw new Error(`Couldn’t read [${inner}].`)
      })
      tokens.push({ kind: 'keys', keys })
    } else if (i === 0 || (i === 1 && path[0] === '$')) {
      tokens.push({ kind: 'keys', keys: [ident()] }) // "data.items" without a leading $.
    } else throw new Error(`Unexpected “${path[i]}” at position ${i + 1}.`)
  }
  return tokens
}
