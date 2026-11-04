/**
 * "Parameterize": turns hard-coded parts of a request into {{variables}} — the base URL, tokens and API keys,
 * IDs in the path, and any value that already matches a variable you have. Pure: suggestions in, a new request
 * and the variables to create out.
 */
import type { Auth, KV, RequestDef } from './types'
import { emptyAuth, kv } from './types'
import { paramsFromUrl, splitUrl } from './url'
import { pathVarsFromUrl } from './prepare'

export type SuggestionKind = 'existing' | 'baseUrl' | 'bearer' | 'apiKeyHeader' | 'basic' | 'pathId'

export interface Suggestion {
  id: string
  kind: SuggestionKind
  /** Shown to the user. */
  title: string
  detail: string
  /** The variable used (existing or new). */
  varName: string
  value: string
  /** True when the variable doesn't exist yet and will be created. */
  create: boolean
  secret: boolean
}

export interface KnownVar { key: string; value: string; from: string }

const API_KEY_HEADER = /^(x-api-key|api-key|apikey|x-auth-token|x-access-token|x-apikey|ocp-apim-subscription-key)$/i
const looksId = (s: string) => /^\d{2,}$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{24}$/i.test(s) || /^[0-9a-f]{32,}$/i.test(s)
const singular = (w: string) => w.replace(/ies$/, 'y').replace(/(ss|us)$/, '$1').replace(/s$/, '')
const camel = (w: string) => w.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase())
const uniqueName = (base: string, taken: Set<string>) => { let n = base; let i = 2; while (taken.has(n)) n = `${base}${i++}`; taken.add(n); return n }

/** The suggestions for a request, given the variables already in scope. */
export function suggest(req: RequestDef, known: KnownVar[]): Suggestion[] {
  const out: Suggestion[] = []
  const taken = new Set(known.map((k) => k.key))
  const byValue = new Map<string, KnownVar>()
  for (const k of known) if (k.value.length >= 4 && !byValue.has(k.value)) byValue.set(k.value, k)
  const used = new Set<string>()
  const add = (s: Omit<Suggestion, 'id'>) => { if (used.has(`${s.kind}:${s.value}`)) return; used.add(`${s.kind}:${s.value}`); out.push({ ...s, id: `${s.kind}:${out.length}` }) }

  // 1. Values that already have a variable (longest first, so a base URL wins over its host).
  const text = [req.url, ...req.headers.map((h) => h.value), req.body.text, ...req.body.fields.map((f) => f.value), req.auth.token, req.auth.value, req.auth.username, req.auth.password].join('\n')
  for (const k of [...byValue.values()].sort((a, b) => b.value.length - a.value.length)) {
    if (text.includes(k.value)) add({ kind: 'existing', title: `Use {{${k.key}}}`, detail: `“${short(k.value)}” is ${k.from}’s ${k.key}`, varName: k.key, value: k.value, create: false, secret: false })
  }

  // 2. The base URL (scheme://host[:port]), unless the URL already starts with a variable.
  const { base } = splitUrl(req.url)
  const origin = base.match(/^(https?:\/\/[^/{}]+)/i)?.[1]
  if (origin && !out.some((s) => s.kind === 'existing' && req.url.startsWith(s.value))) {
    const name = uniqueName('baseUrl', taken)
    add({ kind: 'baseUrl', title: `Base URL → {{${name}}}`, detail: origin, varName: name, value: origin, create: true, secret: false })
  }

  // 3. Credentials written into the request.
  const authHeader = req.headers.find((h) => h.enabled && h.key.toLowerCase() === 'authorization' && /^bearer\s+\S+$/i.test(h.value) && !h.value.includes('{{'))
  const bearer = authHeader ? authHeader.value.replace(/^bearer\s+/i, '') : req.auth.kind === 'bearer' && req.auth.token && !req.auth.token.includes('{{') ? req.auth.token : ''
  if (bearer && !byValue.has(bearer)) {
    const name = uniqueName('token', taken)
    add({ kind: 'bearer', title: `Bearer token → {{${name}}} (secret)`, detail: authHeader ? 'Moves the Authorization header to the Auth tab' : 'Auth tab token', varName: name, value: bearer, create: true, secret: true })
  }
  for (const h of req.headers.filter((x) => x.enabled && API_KEY_HEADER.test(x.key) && x.value && !x.value.includes('{{') && !byValue.has(x.value))) {
    const name = uniqueName('apiKey', taken)
    add({ kind: 'apiKeyHeader', title: `${h.key} → {{${name}}} (secret)`, detail: short(h.value), varName: name, value: h.value, create: true, secret: true })
  }
  if (req.auth.kind === 'apikey' && req.auth.value && !req.auth.value.includes('{{') && !byValue.has(req.auth.value)) {
    const name = uniqueName('apiKey', taken)
    add({ kind: 'apiKeyHeader', title: `API key → {{${name}}} (secret)`, detail: short(req.auth.value), varName: name, value: req.auth.value, create: true, secret: true })
  }
  if (req.auth.kind === 'basic' && req.auth.password && !req.auth.password.includes('{{') && !byValue.has(req.auth.password)) {
    const name = uniqueName('password', taken)
    add({ kind: 'basic', title: `Basic auth password → {{${name}}} (secret)`, detail: `for ${req.auth.username || 'the user'}`, varName: name, value: req.auth.password, create: true, secret: true })
  }

  // 4. IDs in the path become :path variables named after the segment before them (/users/42 → :userId).
  const path = base.replace(/^https?:\/\/[^/]+/i, '').replace(/^\{\{[^}]+\}\}/, '')
  const segs = path.split('/')
  segs.forEach((seg, i) => {
    if (!looksId(seg) || byValue.has(seg)) return
    const prev = segs.slice(0, i).reverse().find((s) => s && !looksId(s) && !s.startsWith(':') && !s.includes('{{'))
    const name = uniqueName(camel(`${prev ? singular(prev) : 'item'}-id`), taken)
    add({ kind: 'pathId', title: `/${seg} → /:${name}`, detail: `path variable, value ${seg}`, varName: name, value: seg, create: false, secret: false })
  })
  return out
}

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 18)}…${s.slice(-12)}` : s)
const replaceAll = (s: string, from: string, to: string) => (from ? s.split(from).join(to) : s)

/** Applies the chosen suggestions. Returns the new request and the variables to create (name, value, secret). */
export function applySuggestions(req: RequestDef, chosen: Suggestion[]): { request: RequestDef; create: KV[] } {
  let r: RequestDef = structuredClone(req)
  const create: KV[] = []
  const swap = (from: string, to: string) => {
    r.url = replaceAll(r.url, from, to)
    r.headers = r.headers.map((h) => ({ ...h, value: replaceAll(h.value, from, to) }))
    r.body = { ...r.body, text: replaceAll(r.body.text, from, to), graphqlVariables: replaceAll(r.body.graphqlVariables, from, to), fields: r.body.fields.map((f) => ({ ...f, value: replaceAll(f.value, from, to) })) }
    const a: Auth = { ...r.auth }
    for (const k of ['token', 'value', 'username', 'password'] as const) a[k] = replaceAll(a[k], from, to)
    r.auth = a
  }
  // Path IDs first (they change the URL's shape), then the rest, longest values first.
  for (const s of chosen.filter((x) => x.kind === 'pathId')) {
    const { base, query, hash } = splitUrl(r.url)
    const nextBase = base.replace(new RegExp(`/${s.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$)`), `/:${s.varName}`)
    r.url = nextBase + (query ? `?${query}` : '') + hash
    r.pathVars = pathVarsFromUrl(r.url, [...r.pathVars, kv(s.varName, s.value)])
  }
  for (const s of chosen.filter((x) => x.kind !== 'pathId').sort((a, b) => b.value.length - a.value.length)) {
    if (s.kind === 'bearer') {
      r.headers = r.headers.filter((h) => !(h.key.toLowerCase() === 'authorization' && /^bearer\s+/i.test(h.value) && h.value.replace(/^bearer\s+/i, '') === s.value))
      r.auth = { ...emptyAuth('bearer'), token: `{{${s.varName}}}` }
    } else swap(s.value, `{{${s.varName}}}`)
    if (s.create) create.push(kv(s.varName, s.value, true, s.secret ? { secret: true } : {}))
  }
  r.params = paramsFromUrl(r.url, r.params)
  return { request: r, create }
}
