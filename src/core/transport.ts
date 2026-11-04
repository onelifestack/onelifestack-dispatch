import type { HttpResponse, PreparedRequest } from './types'

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** The request body as fetch wants it. */
export function fetchBody(p: PreparedRequest): BodyInit | undefined {
  if (p.multipart) {
    const fd = new FormData()
    for (const part of p.multipart) {
      if (part.file) fd.append(part.name, new Blob([base64ToBytes(part.file.base64)], { type: part.file.type }), part.file.name || 'file')
      else fd.append(part.name, part.value ?? '')
    }
    return fd
  }
  if (p.bodyFile) return new Blob([base64ToBytes(p.bodyFile.base64)], { type: p.bodyFile.type })
  return p.body ?? undefined
}

export interface SendOptions { timeoutMs: number; followRedirects: boolean; insecureTls: boolean; signal?: AbortSignal }

export interface Transport {
  /** Shown in the status bar so it's clear how requests are sent. */
  readonly label: string
  /** Whether it can reach any server (desktop) or only ones that allow this page (browser CORS). */
  readonly unrestricted: boolean
  send(p: PreparedRequest, opts: SendOptions): Promise<HttpResponse>
}

/** Raised with a friendly message the UI shows as-is. */
export class SendError extends Error {}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const textDecoder = new TextDecoder('utf-8', { fatal: true })

/** Decodes bytes as UTF-8 text, or reports that they're binary. */
export function decodeBody(bytes: Uint8Array): { body: string; binary: boolean } {
  try {
    const body = textDecoder.decode(bytes)
    // Control characters other than tab/newline/CR mean it's almost certainly binary.
    if (/[\x00-\x08\x0E-\x1F]/.test(body.slice(0, 2048))) return { body: '', binary: true }
    return { body, binary: false }
  } catch {
    return { body: '', binary: true }
  }
}

/** Sends with the browser's fetch. Servers must allow this page's origin (CORS), and some headers are off-limits. */
export class FetchTransport implements Transport {
  readonly label = 'Browser'
  readonly unrestricted = false
  constructor(private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  async send(p: PreparedRequest, opts: SendOptions): Promise<HttpResponse> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), opts.timeoutMs)
    const onAbort = () => ctrl.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort)
    const started = performance.now()
    try {
      const res = await this.fetchImpl(p.url, {
        method: p.method,
        headers: p.headers,
        body: fetchBody(p),
        redirect: opts.followRedirects ? 'follow' : 'manual',
        signal: ctrl.signal,
      })
      const ttfb = performance.now()
      const bytes = new Uint8Array(await res.arrayBuffer())
      const end = performance.now()
      const decoded = decodeBody(bytes)
      return {
        status: res.status, statusText: res.statusText, headers: [...res.headers.entries()],
        ...decoded, base64: decoded.binary ? bytesToBase64(bytes) : undefined, size: bytes.byteLength,
        timeMs: Math.round(end - started), timings: { ttfbMs: Math.round(ttfb - started), downloadMs: Math.round(end - ttfb) },
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        const why = ctrl.signal.reason
        throw new SendError(why instanceof DOMException && why.name === 'TimeoutError'
          ? `No response after ${Math.round(opts.timeoutMs / 1000)} seconds.` : 'Request cancelled.')
      }
      throw new SendError(
        'The browser couldn’t complete this request. Either the server is unreachable, or it doesn’t allow ' +
        'requests from this page (CORS). The desktop app has no such limit.')
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

interface NativeResponse {
  status: number; status_text: string; headers: [string, string][]; body_base64: string; time_ms: number; ttfb_ms: number
}

/** Sends from the Rust side of the desktop app: no CORS, any header, optional self-signed TLS. */
export class DesktopTransport implements Transport {
  readonly label = 'Desktop'
  readonly unrestricted = true
  private next = 1

  async send(p: PreparedRequest, opts: SendOptions): Promise<HttpResponse> {
    const { invoke } = await import('@tauri-apps/api/core')
    const id = this.next++
    const onAbort = () => { void invoke('cancel_request', { id }) }
    opts.signal?.addEventListener('abort', onAbort)
    try {
      const r = await invoke<NativeResponse>('send_request', {
        req: {
          id, method: p.method, url: p.url, headers: p.headers, body: p.body,
          body_base64: p.bodyFile?.base64 ?? null,
          multipart: p.multipart?.map((m) => ({ name: m.name, value: m.value ?? null, file_name: m.file?.name ?? null, content_type: m.file?.type ?? null, data_base64: m.file?.base64 ?? null })) ?? null,
          timeout_ms: opts.timeoutMs, follow_redirects: opts.followRedirects, insecure_tls: opts.insecureTls,
        },
      })
      const bytes = base64ToBytes(r.body_base64)
      const decoded = decodeBody(bytes)
      return {
        status: r.status, statusText: r.status_text, headers: r.headers, ...decoded, base64: decoded.binary ? r.body_base64 : undefined,
        size: bytes.byteLength, timeMs: r.time_ms, timings: { ttfbMs: r.ttfb_ms, downloadMs: Math.max(0, r.time_ms - r.ttfb_ms) },
      }
    } catch (e) {
      throw new SendError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'The request failed.')
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export const defaultTransport = (): Transport => (isDesktop() ? new DesktopTransport() : new FetchTransport())
