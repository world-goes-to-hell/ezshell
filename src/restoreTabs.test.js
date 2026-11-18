import { describe, it, expect } from 'vitest'
import { saveRestoreTabs, takeRestoreTabs, MAX_AGE_MS } from './restoreTabs.js'

// An in-memory file system with the calls the module uses
const memoryFs = () => {
  const files = new Map()
  return {
    files,
    writeFileSync: (p, text) => files.set(p, text),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p) },
    unlinkSync: (p) => { files.delete(p) }
  }
}
const PATH = '/data/restore-tabs.json'
const record = { version: 1, tabs: [{ kind: 'ssh', savedSessionId: 's1', currentPath: '/var/log' }] }

describe('restore tabs file', () => {
  it('keeps the record encrypted and gives it back once', () => {
    const io = memoryFs()
    expect(saveRestoreTabs(PATH, record, 'master-pass', { now: 1000, io })).toEqual({ success: true })
    const written = io.files.get(PATH)
    // Nothing of the record is readable in the file
    expect(written).not.toContain('/var/log')
    expect(written).not.toContain('s1')
    expect(takeRestoreTabs(PATH, 'master-pass', 2000, io)).toEqual({ savedAt: 1000, record })
    expect(io.files.has(PATH)).toBe(false)
    expect(takeRestoreTabs(PATH, 'master-pass', 3000, io)).toBeNull()
  })

  it('does not save while locked or a record too large', () => {
    const io = memoryFs()
    expect(saveRestoreTabs(PATH, record, null, { now: 1000, io }).success).toBe(false)
    expect(saveRestoreTabs(PATH, { blob: 'x'.repeat(300 * 1024) }, 'p', { now: 1000, io }).success).toBe(false)
    expect(io.files.size).toBe(0)
  })

  it('drops an old file, a file from the future and one of another password, removing it', () => {
    const io = memoryFs()
    saveRestoreTabs(PATH, record, 'master-pass', { now: 1000, io })
    expect(takeRestoreTabs(PATH, 'master-pass', 1000 + MAX_AGE_MS + 1, io)).toBeNull()
    expect(io.files.has(PATH)).toBe(false)

    saveRestoreTabs(PATH, record, 'master-pass', { now: 10 * 60 * 1000, io })
    expect(takeRestoreTabs(PATH, 'master-pass', 1000, io)).toBeNull()

    saveRestoreTabs(PATH, record, 'master-pass', { now: 1000, io })
    expect(takeRestoreTabs(PATH, 'other-pass', 2000, io)).toBeNull()
    expect(io.files.has(PATH)).toBe(false)
  })

  it('keeps the previous work after a normal exit until the next unlock, even after a day', () => {
    const io = memoryFs()
    saveRestoreTabs(PATH, record, 'master-pass', { now: 1000, io, source: 'close' })
    expect(takeRestoreTabs(PATH, 'master-pass', 1000 + MAX_AGE_MS + 1, io)).toEqual({ savedAt: 1000, record, source: 'close' })
    expect(takeRestoreTabs(PATH, 'master-pass', 1000 + MAX_AGE_MS + 2, io)).toBeNull()
  })

  it('ignores a file that is not one of ours', () => {
    const io = memoryFs()
    io.files.set(PATH, '{"format":"something-else","savedAt":1000,"data":{}}')
    expect(takeRestoreTabs(PATH, 'p', 2000, io)).toBeNull()
    io.files.set(PATH, 'not json')
    expect(takeRestoreTabs(PATH, 'p', 2000, io)).toBeNull()
    expect(takeRestoreTabs(PATH, null, 2000, io)).toBeNull()
  })
})
