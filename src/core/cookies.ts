export interface Cookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: string
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

/** Parses one Set-Cookie header value. */
export function parseSetCookie(header: string): Cookie {
  const [pair, ...attrs] = header.split(';')
  const eq = pair.indexOf('=')
  const c: Cookie = { name: (eq >= 0 ? pair.slice(0, eq) : pair).trim(), value: eq >= 0 ? pair.slice(eq + 1).trim() : '' }
  for (const a of attrs) {
    const i = a.indexOf('=')
    const k = (i >= 0 ? a.slice(0, i) : a).trim().toLowerCase()
    const v = i >= 0 ? a.slice(i + 1).trim() : ''
    if (k === 'domain') c.domain = v.replace(/^\./, '')
    else if (k === 'path') c.path = v
    else if (k === 'expires') c.expires = v
    else if (k === 'max-age') c.maxAge = Number(v)
    else if (k === 'httponly') c.httpOnly = true
    else if (k === 'secure') c.secure = true
    else if (k === 'samesite') c.sameSite = v
  }
  return c
}

export interface StoredCookie extends Cookie { host: string; expiresAt: number | null }
type Stored = StoredCookie

/**
 * A simple cookie jar (RFC 6265 basics: domain/path match, expiry, secure). The desktop app keeps cookies in Rust;
 * this one serves the runner, load tests and the CLI so a login in one request carries to the next.
 */
export class CookieJar {
  private cookies: Stored[] = []

  store(url: string, headers: [string, string][], now = Date.now()) {
    let u: URL
    try { u = new URL(url) } catch { return }
    for (const [k, v] of headers) {
      if (k.toLowerCase() !== 'set-cookie') continue
      const c = parseSetCookie(v)
      if (!c.name) continue
      const host = (c.domain ?? u.hostname).toLowerCase()
      if (c.domain && !(u.hostname === host || u.hostname.endsWith(`.${host}`))) continue // not allowed to set for another site
      const path = c.path ?? (u.pathname.replace(/\/[^/]*$/, '') || '/')
      const expiresAt = c.maxAge != null ? now + c.maxAge * 1000 : c.expires ? Date.parse(c.expires) : null
      this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.host === host && (x.path ?? '/') === path))
      if (expiresAt !== null && expiresAt <= now) { this.changed(); continue } // deletion
      this.cookies.push({ ...c, host, path, expiresAt })
      this.changed()
    }
  }

  /** The Cookie header for a URL, or null. */
  header(url: string, now = Date.now()): string | null {
    let u: URL
    try { u = new URL(url) } catch { return null }
    this.cookies = this.cookies.filter((c) => c.expiresAt === null || c.expiresAt > now)
    const host = u.hostname.toLowerCase()
    const match = this.cookies.filter((c) => (host === c.host || host.endsWith(`.${c.host}`))
      && (u.pathname === c.path || u.pathname.startsWith(c.path!.endsWith('/') ? c.path! : `${c.path}/`) || c.path === '/')
      && (!c.secure || u.protocol === 'https:'))
    return match.length ? match.map((c) => `${c.name}=${c.value}`).join('; ') : null
  }

  list(): Cookie[] { return this.cookies.map(({ host, expiresAt: _e, ...c }) => ({ ...c, domain: c.domain ?? host })) }
  clear() { this.cookies = []; this.changed() }

  /** Every stored cookie with its host and expiry, for the cookie manager and for saving. */
  entries(): StoredCookie[] { return this.cookies.map((c) => ({ ...c })) }
  /** Adds or replaces a cookie (same host, name and path). */
  set(c: StoredCookie) {
    this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.host === c.host && (x.path ?? '/') === (c.path ?? '/')))
    this.cookies.push({ ...c, path: c.path || '/' })
    this.changed()
  }
  remove(host: string, name: string, path = '/') {
    this.cookies = this.cookies.filter((x) => !(x.name === name && x.host === host && (x.path ?? '/') === path))
    this.changed()
  }
  load(list: StoredCookie[]) { this.cookies = list.filter((c) => c && c.name && c.host) }
  /** Called after every change (the app saves the jar). */
  onChange?: () => void
  private changed() { this.onChange?.() }
}
