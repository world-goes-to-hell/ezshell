import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import localFileOps from './localFileOps.js'

const { renameLocal, mkdirLocal, trashLocal, moveLocal } = localFileOps

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
    fs.writeFileSync(good, 'x')
    fs.writeFileSync(bad, 'x')
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

describe('trashLocal path spelling', () => {
  // Electron's shell.trashItem answers "Failed to parse path" for these spellings (measured on Windows)
  it('hands the trash a normalized path whatever separators the caller used', async () => {
    const trashed = []
    const trashItem = async (p) => { trashed.push(p) }
    fs.mkdirSync(path.join(dir, 'folder'))
    fs.mkdirSync(path.join(dir, 'other'))
    const forward = path.join(dir, 'folder').split(path.sep).join('/')
    const doubled = dir + path.sep + path.sep + 'other'
    const result = await trashLocal([forward, doubled], trashItem)
    expect(result).toEqual({ trashed: 2, failures: [] })
    expect(trashed).toEqual([path.join(dir, 'folder'), path.join(dir, 'other')])
  })

  it('names a missing item instead of passing it to the trash', async () => {
    const trashItem = async () => { throw new Error('should not be called') }
    const gone = path.join(dir, 'gone')
    const result = await trashLocal([gone], trashItem)
    expect(result.trashed).toBe(0)
    expect(result.failures[0].path).toBe(gone)
    expect(result.failures[0].error).toContain('찾을 수 없습니다')
  })

  it('still refuses a root reached through an odd spelling', async () => {
    const trashItem = async () => { throw new Error('should not be called') }
    const root = path.parse(dir).root
    const result = await trashLocal([path.join(dir, '..', '..', '..', '..', '..', '..', '..', '..')], trashItem)
    expect(result.trashed).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(path.resolve(path.join(dir, '..', '..', '..', '..', '..', '..', '..', '..'))).toBe(root)
  })
})

describe('moveLocal', () => {
  it('moves a file into a folder', async () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    const result = await moveLocal(path.join(dir, 'a.txt'), path.join(dir, 'sub'))
    expect(result).toEqual({ success: true })
    expect(fs.readFileSync(path.join(dir, 'sub', 'a.txt'), 'utf8')).toBe('x')
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false)
  })

  it('moves a folder with its contents into a sibling folder', async () => {
    fs.mkdirSync(path.join(dir, 'src', 'inner'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'inner', 'f.txt'), 'y')
    fs.mkdirSync(path.join(dir, 'dest'))
    const result = await moveLocal(path.join(dir, 'src'), path.join(dir, 'dest'))
    expect(result).toEqual({ success: true })
    expect(fs.readFileSync(path.join(dir, 'dest', 'src', 'inner', 'f.txt'), 'utf8')).toBe('y')
  })

  it('moves an entry up to the parent folder', async () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x')
    const result = await moveLocal(path.join(dir, 'sub', 'a.txt'), dir)
    expect(result).toEqual({ success: true })
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true)
  })

  it('refuses to overwrite an entry with the same name in the target', async () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new')
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'old')
    const result = await moveLocal(path.join(dir, 'a.txt'), path.join(dir, 'sub'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('이미')
    expect(fs.readFileSync(path.join(dir, 'sub', 'a.txt'), 'utf8')).toBe('old')
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true)
  })

  it('refuses to move a folder into itself or its own subfolder', async () => {
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
    expect((await moveLocal(path.join(dir, 'a'), path.join(dir, 'a'))).success).toBe(false)
    expect((await moveLocal(path.join(dir, 'a'), path.join(dir, 'a', 'b'))).success).toBe(false)
    expect(fs.existsSync(path.join(dir, 'a', 'b'))).toBe(true)
  })

  it('does not treat a sibling with a longer name as a subfolder', async () => {
    fs.mkdirSync(path.join(dir, 'app'))
    fs.mkdirSync(path.join(dir, 'app-backup'))
    const result = await moveLocal(path.join(dir, 'app'), path.join(dir, 'app-backup'))
    expect(result).toEqual({ success: true })
  })

  it('rejects a target that is not a folder', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y')
    const result = await moveLocal(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))
    expect(result.success).toBe(false)
  })

  it('rejects relative paths', async () => {
    expect((await moveLocal('a.txt', dir)).success).toBe(false)
    expect((await moveLocal(path.join(dir, 'a.txt'), 'sub')).success).toBe(false)
  })
})
