import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import localFileOps from './localFileOps.js'

const { renameLocal, mkdirLocal, trashLocal } = localFileOps

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-file-ops-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('renameLocal', () => {
  it('renames a file', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    const result = await renameLocal(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))
    expect(result).toEqual({ success: true })
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false)
  })

  it('refuses to overwrite an existing entry', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b')
    const result = await renameLocal(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('이미')
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b')
  })

  it('allows a case-only rename of the same entry', async () => {
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'x')
    const result = await renameLocal(path.join(dir, 'readme.txt'), path.join(dir, 'README.txt'))
    expect(result).toEqual({ success: true })
    expect(fs.readdirSync(dir)).toEqual(['README.txt'])
  })

  it('rejects moving into another directory', async () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    const result = await renameLocal(path.join(dir, 'a.txt'), path.join(dir, 'sub', 'a.txt'))
    expect(result.success).toBe(false)
  })

  it('rejects relative paths', async () => {
    const result = await renameLocal('a.txt', 'b.txt')
    expect(result.success).toBe(false)
  })

  it('reports a missing source', async () => {
    const result = await renameLocal(path.join(dir, 'nope'), path.join(dir, 'x'))
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('mkdirLocal', () => {
  it('creates a folder', async () => {
    const result = await mkdirLocal(path.join(dir, 'new'))
    expect(result).toEqual({ success: true })
    expect(fs.statSync(path.join(dir, 'new')).isDirectory()).toBe(true)
  })

  it('fails when the name already exists', async () => {
    fs.mkdirSync(path.join(dir, 'new'))
    const result = await mkdirLocal(path.join(dir, 'new'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('이미')
  })

  it('does not create missing parents', async () => {
    const result = await mkdirLocal(path.join(dir, 'a', 'b'))
    expect(result.success).toBe(false)
  })
})

describe('trashLocal', () => {
  it('trashes every path and reports per-item failures', async () => {
    const trashed = []
    const trashItem = async (p) => {
      if (p.endsWith('bad')) throw new Error('locked')
      trashed.push(p)
    }
    const good = path.join(dir, 'good')
    const bad = path.join(dir, 'bad')
    const result = await trashLocal([good, bad], trashItem)
    expect(trashed).toEqual([good])
    expect(result.trashed).toBe(1)
    expect(result.failures).toEqual([{ path: bad, error: 'locked' }])
  })

  it('refuses relative paths and drive roots', async () => {
    const trashItem = async () => { throw new Error('should not be called') }
    const result = await trashLocal(['rel', path.parse(dir).root], trashItem)
    expect(result.trashed).toBe(0)
    expect(result.failures).toHaveLength(2)
  })
})
