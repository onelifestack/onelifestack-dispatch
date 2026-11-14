import { describe, expect, it } from 'vitest'
import { FORMAT, exportWorkspace, importData } from '../src/core/backup'
import { newCollection } from '../src/core/types'

describe('backup format', () => {
  const col = newCollection('Shop')
  const json = JSON.parse(exportWorkspace({ collections: [col], folders: [], requests: [], environments: [] }))

  it('writes the OGCrafts format name', () => {
    expect(json.format).toBe(FORMAT)
    expect(FORMAT).toBe('ogcrafts-dispatch')
  })

  it('still imports a backup written under the old OneLifeStack name', () => {
    const res = importData({ ...json, format: 'onelifestack-dispatch' })
    expect(JSON.stringify(res)).toContain('Shop')
  })
})
