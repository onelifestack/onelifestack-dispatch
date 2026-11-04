/**
 * A minimal Chrome DevTools Protocol client (browser-level WebSocket, flat sessions), enough to drive a login:
 * open a page, navigate, run small scripts in it, read cookies (HttpOnly too). Uses the standard WebSocket, so it
 * runs in the desktop webview and in Node 22+ alike.
 */
export class CdpError extends Error {}

export class Cdp {
  private next = 1
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>()

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id)
        this.waiting.delete(msg.id)
        if (msg.error) w?.reject(new CdpError(msg.error.message)); else w?.resolve(msg.result)
      } else this.listeners.forEach((l) => l(msg.method, msg.params, msg.sessionId))
    }
    ws.onclose = () => { for (const w of this.waiting.values()) w.reject(new CdpError('The browser connection closed.')); this.waiting.clear() }
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const t = setTimeout(() => { try { ws.close() } catch { /* */ } reject(new CdpError('Couldn’t connect to the browser.')) }, timeoutMs)
      ws.onopen = () => { clearTimeout(t); resolve(new Cdp(ws)) }
      ws.onerror = () => { clearTimeout(t); reject(new CdpError('Couldn’t connect to the browser.')) }
    })
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(fn: (method: string, params: any, sessionId?: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  close() { try { this.ws.close() } catch { /* already closed */ } }
}

/** One page (tab) attached with a flat session. */
export class CdpPage {
  constructor(readonly cdp: Cdp, readonly sessionId: string) {}

  static async open(cdp: Cdp): Promise<CdpPage> {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const p = new CdpPage(cdp, sessionId)
    await Promise.all([p.send('Page.enable'), p.send('Runtime.enable'), p.send('Network.enable')])
    return p
  }

  send<T = any>(method: string, params: object = {}) { return this.cdp.send<T>(method, params, this.sessionId) }

  /** Runs an expression in the page and returns its (JSON-able) value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new CdpError(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text)
    return r.result.value as T
  }

  /** Navigates and waits for the load event (or the timeout). */
  async goto(url: string, timeoutMs: number) {
    const loaded = new Promise<void>((resolve) => {
      const off = this.cdp.on((m, _p, sid) => { if (sid === this.sessionId && m === 'Page.loadEventFired') { off(); resolve() } })
      setTimeout(() => { off(); resolve() }, timeoutMs)
    })
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url })
    if (r.errorText) throw new CdpError(`Couldn’t open ${url}: ${r.errorText}`)
    await loaded
  }

  /** All cookies the browser has (including HttpOnly ones). */
  async cookies(): Promise<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }[]> {
    return (await this.send<{ cookies: any[] }>('Network.getAllCookies')).cookies
  }
}
