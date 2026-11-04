import type { Auth, Collection, Folder, KV, RequestDef } from './types'
import { bySort } from './types'

const AUTH: Record<string, string> = { none: 'none', basic: 'Basic', bearer: 'Bearer token', apikey: 'API key', digest: 'Digest', oauth2: 'OAuth 2.0', jwt: 'JWT', awsv4: 'AWS Signature v4', inherit: 'inherited' }
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const table = (rows: KV[], valueLabel = 'Example') => {
  const on = rows.filter((r) => r.key.trim())
  if (!on.length) return ''
  return `| Name | ${valueLabel} | Notes |\n| --- | --- | --- |\n${on.map((r) => `| \`${cell(r.key)}\` | ${r.secret ? '(secret)' : cell(r.value) || ' '} | ${[r.enabled ? '' : 'optional', r.description ?? ''].filter(Boolean).map(cell).join('; ') || ' '} |`).join('\n')}\n`
}
const fence = (lang: string, s: string) => `\`\`\`${lang}\n${s.replace(/```/g, '`​``')}\n\`\`\`\n`
const authLine = (a: Auth) => {
  if (a.kind === 'apikey') return `API key \`${a.key}\` in the ${a.in === 'query' ? 'query string' : 'header'}`
  if (a.kind === 'oauth2') return `OAuth 2.0 (${a.grant.replace(/_/g, ' ')}${a.tokenUrl ? `, token URL ${a.tokenUrl}` : ''})`
  return AUTH[a.kind] ?? a.kind
}

function requestDoc(r: RequestDef, depth: number): string {
  const h = '#'.repeat(Math.min(4, depth))
  const parts = [`${h} ${r.method} ${r.name}\n`, `\`${r.method} ${r.url}\`\n`]
  if (r.docs.trim()) parts.push(`${r.docs.trim()}\n`)
  if (r.auth.kind !== 'inherit') parts.push(`**Auth:** ${authLine(r.auth)}\n`)
  if (r.pathVars.length) parts.push(`**Path variables**\n\n${table(r.pathVars)}`)
  if (r.params.length) parts.push(`**Query parameters**\n\n${table(r.params)}`)
  if (r.headers.length) parts.push(`**Headers**\n\n${table(r.headers)}`)
  const b = r.body
  if (['json', 'text', 'xml', 'html'].includes(b.kind) && b.text.trim()) parts.push(`**Body** (${b.kind})\n\n${fence(b.kind === 'text' ? '' : b.kind, b.text)}`)
  else if (b.kind === 'graphql') parts.push(`**GraphQL**\n\n${fence('graphql', b.text)}${b.graphqlVariables.trim() ? fence('json', b.graphqlVariables) : ''}`)
  else if (b.kind === 'urlencoded' || b.kind === 'formdata') parts.push(`**Form fields** (${b.kind === 'formdata' ? 'multipart' : 'urlencoded'})\n\n${table(b.fields.map((f) => (f.type === 'file' ? { ...f, value: '(file)' } : f)))}`)
  else if (b.kind === 'binary') parts.push('**Body:** a binary file\n')
  for (const e of r.examples) parts.push(`**Example: ${e.name}** — ${e.status}\n\n${fence(e.headers.find(([k, v]) => k.toLowerCase() === 'content-type' && v.includes('json')) ? 'json' : '', e.body.length > 4000 ? `${e.body.slice(0, 4000)}\n…` : e.body)}`)
  return parts.join('\n')
}

/** The whole collection as Markdown, in collection order. Secret variable values are never written. */
export function collectionMarkdown(c: Collection, folders: Folder[], requests: RequestDef[]): string {
  const out = [`# ${c.name}\n`]
  if (c.docs.trim()) out.push(`${c.docs.trim()}\n`)
  if (c.auth.kind !== 'none' && c.auth.kind !== 'inherit') out.push(`**Auth for every request (unless it says otherwise):** ${authLine(c.auth)}\n`)
  if (c.variables.length) out.push(`## Variables\n\n${table(c.variables, 'Value')}`)
  const walk = (parent: string | null, depth: number) => {
    const reqs = requests.filter((r) => r.collectionId === c.id && (r.folderId ?? null) === parent).map((r) => ({ sort: r.sort, name: r.name, doc: () => out.push(requestDoc(r, depth)) }))
    const subs = folders.filter((f) => f.collectionId === c.id && f.parentId === parent).map((f) => ({
      sort: f.sort, name: f.name,
      doc: () => {
        out.push(`${'#'.repeat(Math.min(4, depth))} ${f.name}\n`)
        if (f.docs.trim()) out.push(`${f.docs.trim()}\n`)
        if (f.auth.kind !== 'inherit') out.push(`**Auth for this folder:** ${authLine(f.auth)}\n`)
        walk(f.id, depth + 1)
      },
    }))
    ;[...reqs, ...subs].sort(bySort).forEach((x) => x.doc())
  }
  walk(null, 2)
  return out.join('\n')
}
