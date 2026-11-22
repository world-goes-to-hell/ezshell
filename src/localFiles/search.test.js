import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDirectorySearch } from './search.js'

let root
let search
let now
const find = query => search.search(root, query, new AbortController().signal)
const write = name => fs.writeFileSync(path.join(root, name), '')

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-file-search-')))
  now = 0
  search = createDirectorySearch({ now: () => now })
})

afterEach(() => {
  search.clear()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('workspace directory search index', () => {
  it('shares a prepared index across queries and rebuilds on refresh', async () => {
    fs.mkdirSync(path.join(root, 'src'))
    write('src/My File.txt')
    search.prepare(root)
    expect(await find('SRC\\MY txt')).toEqual({
      entries: [{ name: 'My File.txt', path: 'src/My File.txt', kind: 'file' }], truncated: false
    })

    write('src/Fresh.txt')
    expect((await find('fresh')).entries).toEqual([])
    search.prepare(root, true)
    expect((await find('fresh')).entries.map(entry => entry.path)).toEqual(['src/Fresh.txt'])
  })

  it('rebuilds an expired index', async () => {
    write('Old.txt')
    expect((await find('old')).entries).toHaveLength(1)
    fs.unlinkSync(path.join(root, 'Old.txt'))
    now = 10_000
    expect((await find('old')).entries).toEqual([])
  })

  it('discards a scan in flight when the workspace search is cleared', async () => {
    const pending = find('old')
    search.clear()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    write('New.txt')
    expect((await find('new')).entries).toHaveLength(1)
  })
})
