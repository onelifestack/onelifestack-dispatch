import type { KV, Method, PreparedRequest, RequestDef } from './types'
import { METHODS, emptyAuth, emptyBody, kv, newRequest } from './types'
import { paramsFromUrl, parseQuery, withScheme } from './url'

/** Splits a shell command line into words: quotes, backslash escapes and line continuations. */
export function shellWords(input: string): string[] {
  const words: string[] = []
  let cur = ''
  let inWord = false
  let i = 0
  const s = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ') // bash and cmd.exe continuations
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { if (inWord) { words.push(cur); cur = ''; inWord = false } i++; continue }
    inWord = true
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      cur += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end)
      i = end < 0 ? s.length : end + 1
    } else if (c === '$' && s[i + 1] === "'") {
      i += 2
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1]
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
          i += 2
        } else cur += s[i++]
      }
      i++
    } else if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i += 2 } else cur += s[i++]
      }
      i++
    } else if (c === '\\' && i + 1 < s.length && /[\s'"\\$`;&|<>()*?!#{}[\]]/.test(s[i + 1])) {
      // A bash escape. Before an ordinary character (C:\Users\me) a backslash stays: it's a Windows path.
      cur += s[i + 1]; i += 2
    } else {
      cur += c; i++
    }
  }
  if (inWord) words.push(cur)
  return words
}

export const looksLikeCurl = (text: string) => /^\s*curl(\.exe)?\s/i.test(text)

const WITH_VALUE = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '--json', '-u', '--user', '--url', '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '-F', '--form',
  '--form-string', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--retry', '-w', '--write-out',
  '-c', '--cookie-jar', '--cacert', '--cert', '--key', '-T', '--upload-file', '--oauth2-bearer',
])

export interface CurlImport { request: RequestDef; warnings: string[] }

/** Turns a curl command into a request. Unknown flags are ignored and reported in `warnings`. */
export function fromCurl(command: string): CurlImport {
  const words = shellWords(command.trim())
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0])) throw new Error('That doesn’t look like a curl command.')
  const warnings: string[] = []
  let method: string | null = null
  let url = ''
  const headers: KV[] = []
  const data: string[] = []
  let json = false
  let get = false
  const form: KV[] = []
  let user: string | null = null
  let bearer: string | null = null

  for (let i = 1; i < words.length; i++) {
    let w = words[i]
    let value: string | undefined
    // --flag=value and -Xvalue forms
    if (w.startsWith('--') && w.includes('=')) { value = w.slice(w.indexOf('=') + 1); w = w.slice(0, w.indexOf('=')) }
    else if (/^-[A-Za-z]./.test(w) && WITH_VALUE.has(w.slice(0, 2))) { value = w.slice(2); w = w.slice(0, 2) }
    if (WITH_VALUE.has(w) && value === undefined) value = words[++i] ?? ''

    switch (w) {
      case '-X': case '--request': method = value!.toUpperCase(); break
      case '--url': url = value!; break
      case '-H': case '--header': {
        const c = value!.indexOf(':')
        if (c > 0) headers.push(kv(value!.slice(0, c).trim(), value!.slice(c + 1).trim()))
        break
      }
      case '-A': case '--user-agent': headers.push(kv('User-Agent', value!)); break
      case '-b': case '--cookie': headers.push(kv('Cookie', value!)); break
      case '-e': case '--referer': headers.push(kv('Referer', value!)); break
      case '-d': case '--data': case '--data-ascii': case '--data-binary': case '--data-raw':
        if (value!.startsWith('@') && w !== '--data-raw') warnings.push(`Body from file ${value!.slice(1)} wasn’t loaded; paste it into the body.`)
        data.push(value!)
        break
      case '--data-urlencode': {
        const eq = value!.indexOf('=')
        data.push(eq >= 0 ? `${value!.slice(0, eq)}=${encodeURIComponent(value!.slice(eq + 1))}` : encodeURIComponent(value!))
        break
      }
      case '--json': json = true; data.push(value!); break
      case '-u': case '--user': user = value!; break
      case '--oauth2-bearer': bearer = value!; break
      case '-G': case '--get': get = true; break
      case '-I': case '--head': method = 'HEAD'; break
      case '-F': case '--form': case '--form-string': {
        const eq = value!.indexOf('=')
        const name = eq >= 0 ? value!.slice(0, eq) : value!
        const v = eq >= 0 ? value!.slice(eq + 1) : ''
        if (w !== '--form-string' && v.startsWith('@')) {
          form.push(kv(name, '', true, { type: 'file', file: null }))
          warnings.push(`File ${v.slice(1).split(';')[0]} for “${name}” wasn’t loaded; choose it in the body tab.`)
        } else form.push(kv(name, w !== '--form-string' && v.startsWith('<') ? '' : v, true, { type: 'text' }))
        break
      }
      case '-T': case '--upload-file': warnings.push('File uploads (-T) aren’t supported yet and were skipped.'); break
      default:
        if (w.startsWith('-')) {
          if (!['-L', '--location', '-k', '--insecure', '-s', '--silent', '-S', '--show-error', '-v', '--verbose', '-i', '--include', '--compressed', '-sS', '-fsSL', '-f', '--fail'].includes(w)) {
            warnings.push(`Ignored ${w}.`)
          }
        } else if (!url) url = w
        else warnings.push(`Ignored extra argument ${w}.`)
    }
  }
  if (!url) throw new Error('No URL found in the curl command.')
  url = withScheme(url)

  const req = newRequest({ name: nameFromUrl(url), headers })
  let body = data.join('&')
  if (get && data.length) {
    url += (url.includes('?') ? '&' : '?') + body
    body = ''
  }
  const m = (method ?? (body ? 'POST' : 'GET')) as Method
  if (!METHODS.includes(m)) warnings.push(`Method ${m} isn’t supported; using GET.`)
  req.method = METHODS.includes(m) ? m : 'GET'
  req.url = url
  req.params = paramsFromUrl(url, [])

  if (body) {
    const ctIndex = headers.findIndex((h) => h.key.toLowerCase() === 'content-type')
    const ct = ctIndex >= 0 ? headers[ctIndex].value.toLowerCase() : ''
    if (json || ct.includes('json') || (!ct && /^\s*[[{]/.test(body))) {
      req.body = { ...emptyBody('json'), text: prettyIfJson(body) }
      if (json && ctIndex < 0) headers.push(kv('Content-Type', 'application/json'))
      if (json && !headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push(kv('Accept', 'application/json'))
    } else if (!ct || ct.includes('x-www-form-urlencoded')) {
      req.body = { ...emptyBody('urlencoded'), fields: parseQuery(body).map(({ key, value }) => kv(key, value)) }
      if (ctIndex >= 0) headers.splice(ctIndex, 1) // the body type adds it back
    } else {
      req.body = { ...emptyBody(ct.includes('xml') ? 'xml' : ct.includes('html') ? 'html' : 'text'), text: body }
    }
  }

  if (form.length) {
    req.body = { ...emptyBody('formdata'), fields: form }
    if (!method) req.method = 'POST'
    const ctIndex = headers.findIndex((h) => h.key.toLowerCase() === 'content-type' && h.value.toLowerCase().startsWith('multipart/'))
    if (ctIndex >= 0) headers.splice(ctIndex, 1) // the boundary is set when sending
  }

  if (user !== null) {
    const c = user.indexOf(':')
    req.auth = { ...emptyAuth('basic'), username: c >= 0 ? user.slice(0, c) : user, password: c >= 0 ? user.slice(c + 1) : '' }
  } else if (bearer !== null) {
    req.auth = { ...emptyAuth('bearer'), token: bearer }
  } else {
    // Lift a literal "Authorization: Bearer x" header into the auth tab, where it's easier to swap for {{token}}.
    const a = headers.findIndex((h) => h.key.toLowerCase() === 'authorization' && /^bearer\s+/i.test(h.value))
    if (a >= 0) { req.auth = { ...emptyAuth('bearer'), token: headers[a].value.replace(/^bearer\s+/i, '') }; headers.splice(a, 1) }
  }
  return { request: req, warnings }
}

function prettyIfJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '')
    return path ? `${u.host}${path}` : u.host
  } catch { return url.slice(0, 60) || 'New request' }
}

/** POSIX single-quoting. */
const q = (s: string) => (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** A curl command for a prepared request, one option per line. */
export function toCurl(p: PreparedRequest): string {
  const parts = ['curl']
  if (p.method === 'HEAD') parts.push('--head')
  else if (p.method !== 'GET' || p.body) parts.push(`-X ${p.method}`)
  parts.push(q(p.url))
  for (const [k, v] of p.headers) parts.push(`-H ${q(`${k}: ${v}`)}`)
  if (p.body) parts.push(`--data-raw ${q(p.body)}`)
  return parts.join(' \\\n  ')
}
