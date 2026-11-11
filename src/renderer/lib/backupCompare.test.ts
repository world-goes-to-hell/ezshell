import { describe, it, expect } from 'vitest'
import { mergeBackups, neighborOf, entryKey } from './backupCompare'
import type { RemoteFileBackup, RemoteServerBackup } from '../types'

const app: RemoteFileBackup[] = [
  { name: 'compose.yaml.20261111-142337.bak', createdAt: 3000, size: 10 },
  { name: 'compose.yaml.20261111-142316.bak', createdAt: 1000, size: 9 }
]
const server: RemoteServerBackup[] = [
  { name: 'compose.yaml.bak_20261020_1516', size: 8, time: 2000, timeFrom: 'name' },
  { name: 'compose.yaml.orig', size: 7, time: 500, timeFrom: 'modified' }
]

describe('mergeBackups', () => {
  it('puts both kinds in one list, newest first', () => {
    const merged = mergeBackups(app, server)
    expect(merged.map(e => `${e.source}:${e.name}`)).toEqual([
      'app:compose.yaml.20261111-142337.bak',
      'server:compose.yaml.bak_20261020_1516',
      'app:compose.yaml.20261111-142316.bak',
      'server:compose.yaml.orig'
    ])
    expect(merged[1]).toMatchObject({ time: 2000, size: 8, timeFrom: 'name' })
    expect(merged[0].timeFrom).toBeUndefined()
  })

  it('keeps an app backup and a server file with the same name apart', () => {
    const merged = mergeBackups([{ name: 'x', createdAt: 1, size: 1 }], [{ name: 'x', size: 1, time: 1, timeFrom: 'name' }])
    expect(new Set(merged.map(entryKey)).size).toBe(2)
  })

  it('works with either list missing', () => {
    expect(mergeBackups(null, server)).toHaveLength(2)
    expect(mergeBackups(app, null)).toHaveLength(2)
    expect(mergeBackups(null, null)).toEqual([])
  })
})

describe('neighborOf', () => {
  const merged = mergeBackups(app, server)
  const keys = merged.map(entryKey)

  it('steps to an older or newer backup', () => {
    expect(neighborOf(merged, keys[1], 'older')).toBe(keys[2])
    expect(neighborOf(merged, keys[1], 'newer')).toBe(keys[0])
  })

  it('stops at the ends and on an unknown key', () => {
    expect(neighborOf(merged, keys[0], 'newer')).toBeNull()
    expect(neighborOf(merged, keys[3], 'older')).toBeNull()
    expect(neighborOf(merged, 'app:missing', 'older')).toBeNull()
  })
})
