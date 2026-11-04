import type { FileData, KV } from '../core/types'
import { kv } from '../core/types'
import { formatBytes } from '../core/format'

interface Props {
  rows: KV[]
  onChange: (rows: KV[]) => void
  label: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** Form-data: each row can be text or a file. */
  allowFiles?: boolean
  /** Variables: each row can be marked secret (hidden on screen, left out of backups). */
  allowSecrets?: boolean
  /** Path variables: keys come from the URL and can't be edited, added or removed. */
  fixedKeys?: boolean
}

export const MAX_FILE = 25 * 1024 * 1024

/** Reads a picked file into what a request stores. */
export function readFileData(file: File): Promise<FileData> {
  if (file.size > MAX_FILE) return Promise.reject(new Error(`${file.name} is ${formatBytes(file.size)}; files up to ${formatBytes(MAX_FILE)} can be attached.`))
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      resolve({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, base64: url.slice(url.indexOf(',') + 1) })
    }
    r.onerror = () => reject(new Error(`Couldn’t read ${file.name}.`))
    r.readAsDataURL(file)
  })
}

export function FilePick({ file, onPick, label, onError }: { file: FileData | null | undefined; onPick: (f: FileData | null) => void; label: string; onError?: (m: string) => void }) {
  return (
    <span className="filePick">
      <label className="btn small">
        {file ? 'Change file' : 'Choose file'}
        <input type="file" className="sr" aria-label={label} onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          try { onPick(await readFileData(f)) } catch (err) { onError?.(err instanceof Error ? err.message : String(err)) }
        }} />
      </label>
      {file ? <span className="small mono fileName" title={file.name}>{file.name} · {formatBytes(file.size)}</span> : <span className="small muted">No file</span>}
    </span>
  )
}

/** An editable key/value table that always ends with an empty row to type into.
 * Rows are keyed by position so typing into the empty row keeps focus when it becomes a real row. */
export function KVTable({ rows, onChange, label, keyPlaceholder = 'Key', valuePlaceholder = 'Value', allowFiles, allowSecrets, fixedKeys }: Props) {
  const ghost = kv('', '', true, allowFiles ? { type: 'text' } : {})
  const all = fixedKeys ? rows : [...rows, ghost]
  const update = (i: number, patch: Partial<KV>) => {
    if (i === rows.length) { onChange([...rows, { ...ghost, ...patch }]); return }
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))

  return (
    <table className="kv" aria-label={label}>
      <thead>
        <tr>
          <th className="kv-on"><span className="sr">On</span></th><th>{keyPlaceholder}</th>
          {allowFiles && <th className="kv-type">Type</th>}
          <th>{valuePlaceholder}</th>
          {allowSecrets && <th className="kv-type">Secret</th>}
          {!fixedKeys && <th className="kv-x"><span className="sr">Remove</span></th>}
        </tr>
      </thead>
      <tbody>
        {all.map((r, i) => {
          const isGhost = i === rows.length
          const isFile = allowFiles && r.type === 'file'
          return (
            <tr key={i} className={r.enabled || isGhost ? '' : 'off'}>
              <td className="kv-on">
                {!isGhost && <input type="checkbox" checked={r.enabled} aria-label={`Use ${r.key || 'row'}`} onChange={(e) => update(i, { enabled: e.target.checked })} />}
              </td>
              <td>
                <input className="mono" value={r.key} readOnly={fixedKeys} placeholder={isGhost ? `Add ${keyPlaceholder.toLowerCase()}` : keyPlaceholder}
                  aria-label={`${label} ${keyPlaceholder} ${i + 1}`} spellCheck={false} onChange={(e) => update(i, { key: e.target.value })} />
              </td>
              {allowFiles && (
                <td className="kv-type">
                  <select aria-label={`${label} type ${i + 1}`} value={r.type ?? 'text'} onChange={(e) => update(i, { type: e.target.value as 'text' | 'file', file: null })}>
                    <option value="text">Text</option><option value="file">File</option>
                  </select>
                </td>
              )}
              <td>
                {isFile
                  ? <FilePick file={r.file} label={`${label} file ${i + 1}`} onPick={(file) => update(i, { file })} />
                  : <input className="mono" value={r.value} type={r.secret ? 'password' : 'text'} placeholder={valuePlaceholder}
                      aria-label={`${label} ${valuePlaceholder} ${i + 1}`} spellCheck={false} autoComplete="off" onChange={(e) => update(i, { value: e.target.value })} />}
              </td>
              {allowSecrets && (
                <td className="kv-type">
                  {!isGhost && <input type="checkbox" checked={!!r.secret} aria-label={`${r.key || 'row'} is secret`} onChange={(e) => update(i, { secret: e.target.checked })} />}
                </td>
              )}
              {!fixedKeys && <td className="kv-x">{!isGhost && <button type="button" className="icon" aria-label={`Remove ${r.key || 'row'}`} onClick={() => remove(i)}>×</button>}</td>}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
