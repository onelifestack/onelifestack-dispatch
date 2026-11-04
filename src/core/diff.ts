/** Line diff (longest common subsequence) for comparing responses. Big inputs fall back to a simple prefix/suffix diff. */
export interface DiffLine { type: 'same' | 'add' | 'del'; text: string }

const MAX_CELLS = 4_000_000

export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split('\n'), B = b.split('\n')
  // Trim the common start and end first; most responses differ in a few places.
  let s = 0
  while (s < A.length && s < B.length && A[s] === B[s]) s++
  let e = 0
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++
  const head: DiffLine[] = A.slice(0, s).map((text) => ({ type: 'same', text }))
  const tail: DiffLine[] = A.slice(A.length - e).map((text) => ({ type: 'same', text }))
  const a2 = A.slice(s, A.length - e), b2 = B.slice(s, B.length - e)
  if (a2.length * b2.length > MAX_CELLS) {
    return [...head, ...a2.map((text) => ({ type: 'del' as const, text })), ...b2.map((text) => ({ type: 'add' as const, text })), ...tail]
  }
  // LCS table (lengths of suffixes).
  const n = a2.length, m = b2.length
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a2[i] === b2[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const mid: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a2[i] === b2[j]) { mid.push({ type: 'same', text: a2[i] }); i++; j++ }
    else if (t[i + 1][j] >= t[i][j + 1]) mid.push({ type: 'del', text: a2[i++] })
    else mid.push({ type: 'add', text: b2[j++] })
  }
  while (i < n) mid.push({ type: 'del', text: a2[i++] })
  while (j < m) mid.push({ type: 'add', text: b2[j++] })
  return [...head, ...mid, ...tail]
}

/** Same lines collapsed except `context` lines around changes, for compact display. */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | { type: 'gap'; count: number })[] {
  const keep = new Array(lines.length).fill(false)
  lines.forEach((l, i) => { if (l.type !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true })
  const out: (DiffLine | { type: 'gap'; count: number })[] = []
  let gap = 0
  lines.forEach((l, i) => {
    if (keep[i]) { if (gap) { out.push({ type: 'gap', count: gap }); gap = 0 } out.push(l) } else gap++
  })
  if (gap) out.push({ type: 'gap', count: gap })
  return out
}
