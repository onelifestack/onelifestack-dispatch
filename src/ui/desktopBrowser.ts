import { BROWSER_CANDIDATES, browserArgs, type BrowserLauncher } from '../core/browser'

const os = (): 'linux' | 'windows' | 'mac' => (/Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'mac' : 'linux')

/** Starts Chrome/Edge through the desktop app (Rust) with a throwaway profile. */
export const desktopLauncher: BrowserLauncher = {
  async launch({ path, show }) {
    const { invoke } = await import('@tauri-apps/api/core')
    const id = Math.floor(Math.random() * 1e9)
    const wsUrl = await invoke<string>('browser_launch', { id, path, candidates: BROWSER_CANDIDATES[os()], args: browserArgs('{PROFILE}', show, location.origin) })
    return { wsUrl, close: () => invoke('browser_close', { id }) }
  },
}
