import { Fragment, type ReactNode } from 'react'

/**
 * A small Markdown renderer that builds React elements (never raw HTML), so docs from an imported collection can't
 * inject scripts. Supports headings, paragraphs, **bold**, *italic*, `code`, [links](https://…), lists, > quotes,
 * fenced code blocks, tables and horizontal rules.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{blocks(text)}</div>
}

function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = key
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{inline(t.slice(2, -2), k * 100)}</strong>)
    else if (m[3]) out.push(<em key={k++}>{inline(t.slice(1, -1), k * 100)}</em>)
    else if (m[4]) {
      const lm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!
      const href = safeHref(lm[2])
      out.push(href ? <a key={k++} href={href} target="_blank" rel="noreferrer noopener">{inline(lm[1], k * 100)}</a> : lm[1])
    } else if (m[5]) out.push(<a key={k++} href={t} target="_blank" rel="noreferrer noopener">{t}</a>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

const safeHref = (h: string) => (/^(https?:|mailto:|#)/i.test(h) ? h : null)

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      out.push(<pre key={k++}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = Math.min(4, h[1].length + 1) // a doc's "#" sits under the page title
      const content = inline(h[2])
      out.push(level === 2 ? <h2 key={k++}>{content}</h2> : level === 3 ? <h3 key={k++}>{content}</h3> : <h4 key={k++}>{content}</h4>)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push(<hr key={k++} />); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(<table key={k++}><thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, n) => <td key={n}>{inline(c)}</td>)}</tr>)}</tbody></table>)
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
      const lis = items.map((it, j) => <li key={j}>{inline(it)}</li>)
      out.push(ordered ? <ol key={k++}>{lis}</ol> : <ul key={k++}>{lis}</ul>)
      continue
    }
    if (line.startsWith('>')) {
      const q: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push(<blockquote key={k++}>{blocks(q.join('\n'))}</blockquote>)
      continue
    }
    // Always take the current line, so a line no other rule wanted can't stall the loop.
    const para: string[] = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) para.push(lines[i++])
    out.push(<p key={k++}>{para.map((p, j) => <Fragment key={j}>{j > 0 && ' '}{inline(p, j * 1000)}</Fragment>)}</p>)
  }
  return out
}
