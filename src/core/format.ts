export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

export type StatusTone = 'good' | 'info' | 'warn' | 'bad'
export function statusTone(status: number): StatusTone {
  if (status >= 200 && status < 300) return 'good'
  if (status >= 300 && status < 400) return 'info'
  if (status >= 400 && status < 500) return 'warn'
  return 'bad'
}

export function contentType(headers: [string, string][]): string {
  return headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1].toLowerCase() ?? ''
}

/** Pretty-prints JSON bodies; returns null when the body isn't JSON. */
export function prettyJson(body: string): string | null {
  const t = body.trim()
  if (!t || !/^[[{"\d-]|^(true|false|null)$/.test(t)) return null
  try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return null }
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}
