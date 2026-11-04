/**
 * Browser login: drives an installed Chrome/Edge (over the DevTools protocol) through a few steps — open a page,
 * fill the username and password, click, wait — and pulls out what the API needs: cookies (HttpOnly too),
 * localStorage/sessionStorage values, or text. Results become (secret) variables and go into the cookie jar.
 */
import type { KV, LogLine } from './types'
import { uid } from './types'
import { Cdp, CdpError, CdpPage } from './cdp'

export type BrowserStepKind = 'goto' | 'fill' | 'click' | 'waitFor' | 'waitUrl' | 'wait' | 'extractCookie' | 'extractStorage' | 'extractText' | 'press'

export interface BrowserStep {
  id: string
  kind: BrowserStepKind
  /** goto: URL · fill/click/waitFor/extractText/press: CSS selector · waitUrl: part of the URL · extractCookie: cookie name · extractStorage: key */
  target: string
  /** fill: the text · wait: milliseconds · press: key (e.g. Enter) */
  value: string
  /** extract*: the variable to save into */
  saveAs: string
  /** extractStorage: "local" or "session"; extractCookie: optional domain filter */
  option: string
}

export interface BrowserConfig {
  steps: BrowserStep[]
  /** Show the browser window instead of running hidden (to watch or debug). */
  show: boolean
  /** Path to Chrome/Edge; empty = find it. */
  browserPath: string
  timeoutMs: number
  /** Also put all of the site's cookies into the cookie jar (for the following requests). */
  keepCookies: boolean
}

export const newStep = (kind: BrowserStepKind, target = '', value = '', saveAs = '', option = ''): BrowserStep => ({ id: uid(), kind, target, value, saveAs, option })
export const defaultBrowserConfig = (): BrowserConfig => ({
  steps: [
    newStep('goto', '{{baseUrl}}/login'),
    newStep('fill', 'input[name=username]', '{{username}}'),
    newStep('fill', 'input[type=password]', '{{password}}'),
    newStep('click', 'button[type=submit]'),
    newStep('waitUrl', '/'),
    newStep('extractCookie', 'session', '', 'sessionCookie'),
  ],
  show: false, browserPath: '', timeoutMs: 30_000, keepCookies: true,
})

/** Starts a browser and gives back its DevTools WebSocket address. The app and the CLI each provide one. */
export interface BrowserLauncher {
  launch(o: { path: string; show: boolean }): Promise<{ wsUrl: string; close: () => Promise<void> }>
}

export interface StepResult { id: string; kind: BrowserStepKind; ok: boolean; ms: number; note: string }
export interface BrowserRunResult {
  ok: boolean
  error: string | null
  steps: StepResult[]
  /** Values pulled out, by variable name. */
  extracted: Record<string, string>
  /** Cookies to add to the cookie jar: [url, Set-Cookie-like header]. */
  cookies: { domain: string; name: string; value: string; path: string; secure: boolean; httpOnly: boolean; expires: number }[]
  logs: LogLine[]
  finalUrl: string
}

const js = (v: unknown) => JSON.stringify(v)

/** Runs the steps. `fill` replaces {{variables}} in step fields first. Never throws. */
export async function runBrowserSteps(cfg: BrowserConfig, fill: (s: string) => string, launcher: BrowserLauncher, signal?: AbortSignal): Promise<BrowserRunResult> {
  const out: BrowserRunResult = { ok: false, error: null, steps: [], extracted: {}, cookies: [], logs: [], finalUrl: '' }
  const log = (level: LogLine['level'], text: string) => out.logs.push({ level, text, at: Date.now(), source: 'browser' })
  let session: { wsUrl: string; close: () => Promise<void> } | null = null
  let cdp: Cdp | null = null
  try {
    session = await launcher.launch({ path: cfg.browserPath, show: cfg.show })
    cdp = await Cdp.connect(session.wsUrl)
    const page = await CdpPage.open(cdp)
    const deadline = (ms = cfg.timeoutMs) => Date.now() + ms
    const until = async (what: string, test: () => Promise<boolean>) => {
      const end = deadline()
      while (Date.now() < end) {
        if (signal?.aborted) throw new CdpError('Stopped.')
        if (await test().catch(() => false)) return
        await new Promise((r) => setTimeout(r, 150))
      }
      throw new CdpError(`Timed out waiting for ${what}.`)
    }
    const exists = (sel: string) => page.evaluate<boolean>(`!!document.querySelector(${js(sel)})`)
    for (const st of cfg.steps) {
      if (signal?.aborted) throw new CdpError('Stopped.')
      const t0 = Date.now()
      const target = fill(st.target)
      let note = ''
      try {
        switch (st.kind) {
          case 'goto':
            await page.goto(target, cfg.timeoutMs); note = target; break
          case 'fill': {
            await until(target, () => exists(target))
            const val = fill(st.value)
            // Set the value the way a typing user would, so frameworks (React, Vue…) notice.
            await page.evaluate(`(() => { const el = document.querySelector(${js(target)}); el.focus();
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${js(val)});
              el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`)
            note = `${target} ← ${/pass|secret|token/i.test(st.target + st.value) ? '••••' : val}`
            break
          }
          case 'click':
            await until(target, () => exists(target))
            await page.evaluate(`document.querySelector(${js(target)}).click()`); note = target; break
          case 'press':
            await until(target, () => exists(target))
            await page.evaluate(`(() => { const el = document.querySelector(${js(target)}); el.focus();
              for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: ${js(st.value || 'Enter')}, bubbles: true }));
              if (${js(st.value || 'Enter')} === 'Enter' && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); })()`)
            note = `${st.value || 'Enter'} in ${target}`; break
          case 'waitFor':
            await until(target, () => exists(target)); note = target; break
          case 'waitUrl':
            await until(`the address to contain “${target}”`, async () => (await page.evaluate<string>('location.href')).includes(target)); note = target; break
          case 'wait':
            await new Promise((r) => setTimeout(r, Math.min(60_000, Number(fill(st.value)) || 1000))); note = `${st.value} ms`; break
          case 'extractCookie': {
            let found: { value: string } | undefined
            await until(`cookie “${target}”`, async () => { found = (await page.cookies()).find((c) => c.name === target && (!st.option || c.domain.endsWith(st.option))); return !!found })
            out.extracted[st.saveAs || target] = found!.value; note = `${target} → {{${st.saveAs || target}}}`; break
          }
          case 'extractStorage': {
            const area = st.option === 'session' ? 'sessionStorage' : 'localStorage'
            let v: string | null = null
            await until(`${area} “${target}”`, async () => { v = await page.evaluate<string | null>(`${area}.getItem(${js(target)})`); return v !== null })
            // Tokens are often stored as JSON ({"access_token": …}); take the obvious field when there is one.
            let value = v as unknown as string
            try { const o = JSON.parse(value); if (o && typeof o === 'object') value = o.access_token ?? o.accessToken ?? o.token ?? o.id_token ?? value } catch { /* plain string */ }
            out.extracted[st.saveAs || target] = value; note = `${area}.${target} → {{${st.saveAs || target}}}`; break
          }
          case 'extractText': {
            await until(target, () => exists(target))
            out.extracted[st.saveAs || 'text'] = (await page.evaluate<string>(`document.querySelector(${js(target)}).textContent.trim()`)) ?? ''
            note = `${target} → {{${st.saveAs || 'text'}}}`; break
          }
        }
        out.steps.push({ id: st.id, kind: st.kind, ok: true, ms: Date.now() - t0, note })
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        out.steps.push({ id: st.id, kind: st.kind, ok: false, ms: Date.now() - t0, note: why })
        throw new CdpError(`Step ${out.steps.length} (${st.kind}) failed: ${why}`)
      }
    }
    out.finalUrl = await page.evaluate<string>('location.href').catch(() => '')
    if (cfg.keepCookies) out.cookies = (await page.cookies()).map((c) => ({ domain: c.domain.replace(/^\./, ''), name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expires }))
    out.ok = true
    log('info', `Browser login done: ${Object.keys(out.extracted).join(', ') || 'no values extracted'}${cfg.keepCookies ? `, ${out.cookies.length} cookies kept` : ''}.`)
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
    log('error', out.error)
  } finally {
    cdp?.close()
    await session?.close().catch(() => {})
  }
  return out
}

/** Writes extracted values into variable rows (secret, since they're credentials). */
export function storeExtracted(rows: KV[], extracted: Record<string, string>): KV[] {
  const next = [...rows]
  for (const [k, v] of Object.entries(extracted)) {
    const i = next.findIndex((r) => r.key === k)
    if (i >= 0) next[i] = { ...next[i], value: v, enabled: true }
    else next.push({ id: uid(), key: k, value: v, enabled: true, secret: true })
  }
  return next
}

/** Where Chrome/Edge usually live, per OS. */
export const BROWSER_CANDIDATES: Record<'linux' | 'windows' | 'mac', string[]> = {
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'],
  windows: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  mac: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
}

/** Arguments for a clean, separate browser (its own profile; no first-run screens). */
export const browserArgs = (profileDir: string, show: boolean) => [
  // The desktop app connects from its webview, which sends an Origin header; Chrome/Edge (111+) reject that unless allowed.
  '--remote-debugging-port=0', '--remote-allow-origins=http://tauri.localhost,tauri://localhost,http://localhost', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', '--password-store=basic', ...(show ? [] : ['--headless=new']), 'about:blank',
]
