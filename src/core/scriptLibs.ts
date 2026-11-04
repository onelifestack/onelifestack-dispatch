/**
 * Libraries scripts can require(), like Postman's sandbox: lodash, moment, crypto-js, uuid, ajv (JSON Schema),
 * handlebars (visualizer). A script's code is scanned before it runs and only the libraries it mentions are loaded,
 * so a plain script stays fast; require() itself then works synchronously, as scripts expect.
 */
export type Libs = Record<string, unknown>

const LOADERS: Record<string, () => Promise<unknown>> = {
  lodash: () => import('lodash').then((m) => m.default ?? m),
  moment: () => import('moment').then((m) => m.default ?? m),
  'crypto-js': () => import('crypto-js').then((m) => m.default ?? m),
  uuid: () => import('uuid'),
  ajv: () => import('ajv').then((m) => m.default ?? m),
  handlebars: () => import('handlebars').then((m) => m.default ?? m),
}

export const AVAILABLE = Object.keys(LOADERS)

/** Which libraries the code needs: require('x') calls, plus ajv for jsonSchema checks and handlebars for the visualizer. */
export function neededLibs(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(/require\(\s*['"`]([\w@/.-]+)['"`]\s*\)/g)) if (LOADERS[m[1]]) out.add(m[1])
  if (/\bjsonSchema\s*\(/.test(code)) out.add('ajv')
  if (/\bvisualizer\s*\.\s*set\s*\(/.test(code)) out.add('handlebars')
  if (/\b_\s*\./.test(code)) out.add('lodash') // Postman exposes lodash as a global "_"
  return [...out]
}

export async function loadLibs(names: string[]): Promise<Libs> {
  const libs: Libs = {}
  await Promise.all(names.map(async (n) => { libs[n] = await LOADERS[n]() }))
  return libs
}
