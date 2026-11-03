import type { KV } from './types'
import { uid } from './types'

/** Later scopes win: pass [collection, environment] so the environment overrides the collection. */
export function scopeOf(...layers: (KV[] | undefined)[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const layer of layers) for (const v of layer ?? []) if (v.enabled && v.key.trim()) m.set(v.key.trim(), v.value)
  return m
}

const DYNAMIC: Record<string, () => string> = {
  $guid: () => uid(),
  $uuid: () => uid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
}

const PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g

/**
 * Replaces {{name}} with its value. Values may themselves contain {{other}} (up to a few levels deep).
 * Names with no value are left as written and collected in `unresolved`.
 */
export function interpolate(text: string, scope: Map<string, string>, unresolved?: Set<string>): string {
  let out = text
  for (let depth = 0; depth < 5 && PATTERN.test(out); depth++) {
    PATTERN.lastIndex = 0
    let changed = false
    out = out.replace(PATTERN, (whole, name: string) => {
      if (scope.has(name)) { changed = true; return scope.get(name)! }
      const dyn = DYNAMIC[name]
      if (dyn) { changed = true; return dyn() }
      return whole
    })
    if (!changed) break
  }
  PATTERN.lastIndex = 0
  if (unresolved) for (const m of out.matchAll(PATTERN)) unresolved.add(m[1])
  return out
}

/** Every {{name}} used in the text, in order, without duplicates. */
export function namesIn(text: string): string[] {
  return [...new Set([...text.matchAll(PATTERN)].map((m) => m[1]))]
}
