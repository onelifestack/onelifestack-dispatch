/** Parses CSV (RFC 4180: quotes, "" escapes, newlines in quotes, CRLF, BOM). */
export function parseCsvRows(text: string): string[][] {
  const s = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else quoted = false } else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.length > 1 || r[0] !== '')
}

/** CSV with a header row → one object per data row. */
export function parseCsv(text: string): Record<string, string>[] {
  const [head, ...rows] = parseCsvRows(text)
  if (!head) return []
  const keys = head.map((h) => h.trim())
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])))
}

/** A data file for the runner: CSV with a header row, or a JSON array of objects. */
export function parseDataFile(text: string, fileName = ''): Record<string, string>[] {
  const t = text.trim()
  if (fileName.toLowerCase().endsWith('.json') || t.startsWith('[')) {
    let data: unknown
    try { data = JSON.parse(t) } catch { throw new Error('The data file isn’t valid JSON.') }
    if (!Array.isArray(data) || data.some((x) => x === null || typeof x !== 'object' || Array.isArray(x))) throw new Error('A JSON data file must be an array of objects, one per iteration.')
    return (data as Record<string, unknown>[]).map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])))
  }
  const rows = parseCsv(text)
  if (!rows.length) throw new Error('The CSV needs a header row and at least one data row.')
  return rows
}
