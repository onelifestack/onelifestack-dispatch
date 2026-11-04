interface Props {
  label: string
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  mono?: boolean
  readOnly?: boolean
}

/** A plain textarea for code: Tab indents two spaces, Shift+Tab leaves focus as usual. */
export function CodeArea({ label, value, onChange, rows = 10, placeholder, mono = true, readOnly }: Props) {
  return (
    <textarea className={`code ${mono ? 'mono' : ''}`} value={value} aria-label={label} spellCheck={false} rows={rows} placeholder={placeholder} readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Tab' || e.shiftKey || readOnly || !mono) return
        e.preventDefault()
        const t = e.currentTarget; const s = t.selectionStart
        onChange(t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd))
        requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2 })
      }} />
  )
}
