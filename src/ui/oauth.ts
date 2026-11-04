import type { Auth } from '../core/types'
import { fillAuth, finishAuthCode, getClientToken, startAuthCode } from '../core/auth'
import { interpolate } from '../core/vars'
import { isDesktop } from '../core/transport'
import type { WorkspaceApi } from './useWorkspace'

/**
 * "Get new token" for OAuth 2. Client credentials and password: one request. Authorization code: opens the login
 * page; on desktop with a 127.0.0.1/localhost redirect, a one-shot local listener catches the redirect, otherwise
 * the user pastes the address they landed on.
 */
export async function getOAuthToken(ws: WorkspaceApi, auth: Auth, ask: (title: string, initial?: string) => Promise<string | null>): Promise<Auth | null> {
  const scope = new Map<string, string>()
  for (const layer of [ws.globals, ws.collection?.variables, ws.environment?.variables]) for (const v of layer ?? []) if (v.enabled && v.key.trim()) scope.set(v.key.trim(), v.value)
  const a = fillAuth(auth, (s) => interpolate(s, scope))
  const opts = { timeoutMs: ws.settings.timeoutMs, followRedirects: true, insecureTls: ws.settings.insecureTls }
  let tok
  if (a.grant !== 'authorization_code') tok = await getClientToken(a, ws.transport, opts)
  else {
    const start = await startAuthCode(a)
    let landed: string | null = null
    const loopback = a.redirectUri.match(/^http:\/\/(127\.0\.0\.1|localhost):(\d+)(\/[^?#]*)?/)
    if (isDesktop() && loopback) {
      const { invoke } = await import('@tauri-apps/api/core')
      const waiting = invoke<string>('oauth_listen', { port: Number(loopback[2]), path: loopback[3] || '/', timeoutSecs: 300 })
      await invoke('open_url', { url: start.url })
      landed = await waiting
    } else {
      if (isDesktop()) { const { invoke } = await import('@tauri-apps/api/core'); await invoke('open_url', { url: start.url }) } else window.open(start.url, '_blank', 'noopener')
      landed = await ask('Log in in the window that opened, then paste the full address you end up on (it contains ?code=…)')
    }
    if (!landed) return null
    tok = await finishAuthCode(a, start, landed, ws.transport, opts)
  }
  return { ...auth, accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: tok.expiresAt }
}
