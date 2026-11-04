/** Variables with named alternatives ("layers"): pick which endpoint {{baseUrl}} points at. */
import type { Environment, KV, VarOption } from './types'
import { uid } from './types'

export const hasLayers = (v: KV) => !!v.options && v.options.length > 1

/** Makes `name` the active alternative (and the variable's value). */
export function selectLayer(v: KV, name: string): KV {
  const o = v.options?.find((x) => x.name === name)
  return o ? { ...v, active: o.name, value: o.value } : v
}

/** Turns a plain variable into one with alternatives, keeping its current value as the first. */
export function startLayers(v: KV, firstName = 'default'): KV {
  if (v.options?.length) return v
  return { ...v, options: [{ id: uid(), name: firstName, value: v.value }], active: firstName }
}

/** Updates the alternatives; keeps `value` in step with the active one. */
export function setOptions(v: KV, options: VarOption[]): KV {
  const active = options.find((o) => o.name === v.active) ?? options[0]
  return { ...v, options, active: active?.name, value: active ? active.value : v.value }
}

/** Data rows for "run once per alternative": one row per option of `key`, labelled with its name. */
export function layerRows(env: Environment | null, key: string): { label: string; row: Record<string, string> }[] {
  const v = env?.variables.find((x) => x.key === key && x.enabled)
  return (v?.options ?? []).map((o) => ({ label: o.name, row: { [key]: o.value } }))
}

/** Variables in the environment that have alternatives. */
export const layeredVars = (env: Environment | null) => (env?.variables ?? []).filter((v) => v.enabled && hasLayers(v))
