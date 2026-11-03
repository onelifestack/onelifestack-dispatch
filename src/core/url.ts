import type { KV } from './types'
import { kv } from './types'

/** Splits "a?b#c" into the part before the query, the query (no "?"), and the hash (with "#"). */
export function splitUrl(url: string): { base: string; query: string; hash: string } {
  const h = url.indexOf('#')
  const hash = h >= 0 ? url.slice(h) : ''
  const rest = h >= 0 ? url.slice(0, h) : url
  const q = rest.indexOf('?')
  return q >= 0 ? { base: rest.slice(0, q), query: rest.slice(q + 1), hash } : { base: rest, query: '', hash }
}

/** Decodes a query component but leaves {{variables}} and broken escapes as typed. */
function decode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s }
}

/** Encodes a query component but keeps {{variables}} readable so they can be filled in later. */
export function encodeComponent(s: string): string {
  return s.split(/(\{\{[^{}]*\}\})/).map((part, i) => (i % 2 ? part : encodeURIComponent(part))).join('')
}

export function parseQuery(query: string): { key: string; value: string }[] {
  if (!query) return []
  return query.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=')
    return eq >= 0 ? { key: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) } : { key: decode(pair), value: '' }
  })
}

/**
 * The params table after the user edited the URL: the URL's query becomes the enabled rows (reusing
 * existing row ids where the key matches so focus isn't lost), and disabled rows are kept.
 */
export function paramsFromUrl(url: string, existing: KV[]): KV[] {
  const pool = existing.filter((p) => p.enabled)
  const enabled = parseQuery(splitUrl(url).query).map(({ key, value }) => {
    const i = pool.findIndex((p) => p.key === key)
    const reuse = i >= 0 ? pool.splice(i, 1)[0] : null
    return reuse ? { ...reuse, value } : kv(key, value)
  })
  return [...enabled, ...existing.filter((p) => !p.enabled)]
}

/** The URL after the user edited the params table. */
export function urlWithParams(url: string, params: KV[]): string {
  const { base, hash } = splitUrl(url)
  const q = params.filter((p) => p.enabled && (p.key || p.value))
    .map((p) => (p.value === '' && !p.key.includes('=') ? encodeComponent(p.key) : `${encodeComponent(p.key)}=${encodeComponent(p.value)}`))
    .join('&')
  return base + (q ? `?${q}` : '') + hash
}

/** Adds http:// when no scheme was typed, like a browser does. */
export function withScheme(url: string): string {
  const t = url.trim()
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  return (/^(localhost|127\.|\[::1\])/i.test(t) ? 'http://' : 'https://') + t
}

export function appendQuery(url: string, key: string, value: string): string {
  const { base, query, hash } = splitUrl(url)
  const pair = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  return `${base}?${query ? `${query}&` : ''}${pair}${hash}`
}
