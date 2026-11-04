import { isDesktop } from '../core/transport'

/** Saves text as a file: the native save dialog on desktop, a download in the browser. Returns false if cancelled. */
export async function saveTextFile(fileName: string, text: string, type = 'application/json'): Promise<boolean> {
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<boolean>('save_text_file', { fileName, contents: text })
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  return true
}

/** Saves text or base64 bytes as a file (desktop: native dialog; browser: download). */
export async function saveAnyFile(fileName: string, data: { text?: string; base64?: string }, type: string): Promise<boolean> {
  if (data.text !== undefined) return saveTextFile(fileName, data.text, type)
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<boolean>('save_base64_file', { fileName, base64: data.base64 ?? '' })
  }
  const a = document.createElement('a')
  a.href = `data:${type};base64,${data.base64 ?? ''}`
  a.download = fileName
  a.click()
  return true
}

