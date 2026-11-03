import type { KV } from '../core/types'
import { kv } from '../core/types'

interface Props {
  rows: KV[]
  onChange: (rows: KV[]) => void
  label: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** Show values as password fields (secrets). */
  secretValues?: boolean
}

/** An editable key/value table that always ends with an empty row to type into.
 * Rows are keyed by position so typing into the empty row keeps focus when it becomes a real row. */
export function KVTable({ rows, onChange, label, keyPlaceholder = 'Key', valuePlaceholder = 'Value', secretValues }: Props) {
  const ghost = kv('', '', true)
  const all = [...rows, ghost]
  const update = (i: number, patch: Partial<KV>) => {
    if (i === rows.length) { onChange([...rows, { ...ghost, ...patch }]); return }
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))

  return (
    <table className="kv" aria-label={label}>
      <thead>
        <tr><th className="kv-on"><span className="sr">On</span></th><th>{keyPlaceholder}</th><th>{valuePlaceholder}</th><th className="kv-x"><span className="sr">Remove</span></th></tr>
      </thead>
      <tbody>
        {all.map((r, i) => {
          const isGhost = i === rows.length
          return (
            <tr key={i} className={r.enabled || isGhost ? '' : 'off'}>
              <td className="kv-on">
                {!isGhost && <input type="checkbox" checked={r.enabled} aria-label={`Use ${r.key || 'row'}`} onChange={(e) => update(i, { enabled: e.target.checked })} />}
              </td>
              <td><input className="mono" value={r.key} placeholder={isGhost ? `Add ${keyPlaceholder.toLowerCase()}` : keyPlaceholder} aria-label={`${label} ${keyPlaceholder} ${i + 1}`} spellCheck={false} onChange={(e) => update(i, { key: e.target.value })} /></td>
              <td><input className="mono" value={r.value} type={secretValues && !isGhost ? 'password' : 'text'} placeholder={valuePlaceholder} aria-label={`${label} ${valuePlaceholder} ${i + 1}`} spellCheck={false} onChange={(e) => update(i, { value: e.target.value })} /></td>
              <td className="kv-x">{!isGhost && <button type="button" className="icon" aria-label={`Remove ${r.key || 'row'}`} onClick={() => remove(i)}>×</button>}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
