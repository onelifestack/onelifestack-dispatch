/** Starts Chrome/Edge for browser login steps in Node (the CLI and tests), with a throwaway profile. */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BROWSER_CANDIDATES, browserArgs, type BrowserLauncher } from '../core/browser'

function onPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const p = join(dir, cmd)
    if (existsSync(p)) return p
  }
  return null
}

export function findBrowser(): string | null {
  if (process.env.DISPATCH_BROWSER && existsSync(process.env.DISPATCH_BROWSER)) return process.env.DISPATCH_BROWSER
  const list = BROWSER_CANDIDATES[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux']
  for (const c of list) { const p = c.includes('/') || c.includes('\\') ? (existsSync(c) ? c : null) : onPath(c); if (p) return p }
  return null
}

export const nodeLauncher: BrowserLauncher = {
  launch: ({ path, show }) => new Promise((resolve, reject) => {
    const exe = path || findBrowser()
    if (!exe) { reject(new Error('No Chrome or Edge found. Install one, or set its path (DISPATCH_BROWSER, or the step’s browser path).')); return }
    const profile = mkdtempSync(join(tmpdir(), 'dispatch-browser-'))
    // DISPATCH_BROWSER_ARGS adds arguments (e.g. --no-sandbox for an unpackaged Chromium in a test container).
    const extra = (process.env.DISPATCH_BROWSER_ARGS ?? '').split(' ').filter(Boolean)
    const p = spawn(exe, [...extra, ...browserArgs(profile, show)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const cleanup = async () => { p.kill(); await new Promise((r) => setTimeout(r, 200)); try { rmSync(profile, { recursive: true, force: true }) } catch { /* in use */ } }
    let buf = ''
    const t = setTimeout(() => { void cleanup(); reject(new Error('The browser didn’t start in time.')) }, 15_000)
    p.stderr.on('data', (d: Buffer) => {
      buf += d.toString()
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(t); resolve({ wsUrl: m[1], close: cleanup }) }
    })
    p.on('error', (e) => { clearTimeout(t); void cleanup(); reject(new Error(`Couldn’t start the browser: ${e.message}`)) })
    p.on('exit', (code) => { if (!buf.includes('DevTools listening')) { clearTimeout(t); reject(new Error(`The browser exited (${code}): ${buf.split('\n').slice(-3).join(' ')}`)) } })
  }),
}
