/** The pipeline hook that runs browser-login requests and stores what they extract. */
import type { HttpResponse } from './types'
import type { CookieJar } from './cookies'
import type { Pipeline } from './runtime'
import { prepareContext } from './runtime'
import { scopeFor } from './prepare'
import { interpolate } from './vars'
import { type BrowserLauncher, runBrowserSteps, storeExtracted } from './browser'

/**
 * Extracted values go into the active environment (secret), or Globals when there's none, so the next requests
 * can use them; cookies go into the cookie jar.
 */
export function browserHook(launcher: BrowserLauncher, jar?: () => CookieJar | null): NonNullable<Pipeline['browser']> {
  return async (req, ctx, out, signal) => {
    const scope = scopeFor(prepareContext(ctx, req))
    const t0 = Date.now()
    const r = await runBrowserSteps(req.browser, (s) => interpolate(s, scope), launcher, signal)
    out.logs.push(...r.logs)
    if (!r.ok) { out.error = r.error }
    if (Object.keys(r.extracted).length) {
      if (ctx.environment) {
        const variables = storeExtracted(ctx.environment.variables, r.extracted)
        ctx.environment = { ...ctx.environment, variables }
        out.changes.environment = variables
      } else {
        ctx.globals = storeExtracted(ctx.globals, r.extracted)
        out.changes.globals = ctx.globals
      }
    }
    const j = jar?.()
    if (j) for (const c of r.cookies) j.set({ host: c.domain, name: c.name, value: c.value, path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly, expiresAt: c.expires > 0 ? c.expires * 1000 : null })
    const body = JSON.stringify({ ok: r.ok, finalUrl: r.finalUrl, extracted: Object.keys(r.extracted), cookies: r.cookies.length, steps: r.steps }, null, 2)
    const response: HttpResponse = { status: r.ok ? 200 : 0, statusText: r.ok ? 'Logged in' : 'Failed', headers: [['content-type', 'application/json']], body, binary: false, size: body.length, timeMs: Date.now() - t0 }
    if (r.ok) out.response = response
    out.browser = r
  }
}
