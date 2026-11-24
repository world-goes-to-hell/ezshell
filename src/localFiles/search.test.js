import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDirectorySearch } from './search.js'

let root
let search
let now
let watchers
const find = query => search.search(root, query, new AbortController().signal)
const paths = async query => (await find(query)).entries.map(entry => entry.path)
const write = name => fs.writeFileSync(path.join(root, name), '')
const mkdir = name => fs.mkdirSync(path.join(root, name), { recursive: true })
const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-file-search-')))
// A real recursive fs.watch, recorded so tests can see it closed
const recordingWatch = (folder, listener) => {
  const watcher = fs.watch(folder, { recursive: true, persistent: false }, listener)
  const record = { closed: false }
  watchers.push(record)
  const close = watcher.close.bind(watcher)
  watcher.close = () => { record.closed = true; close() }
  return watcher
}
// A watcher that never reports anything
const silentWatch = () => {
  const record = { closed: false }
  watchers.push(record)
  return { on() {}, close() { record.closed = true } }
}
async function eventually(check, timeout = 8000) {
  const end = Date.now() + timeout
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() > end) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

beforeEach(() => {
  root = tempDir()
  now = 0
  watchers = []
})

afterEach(() => {
  search.clear()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('workspace directory search index', () => {
  beforeEach(() => { search = createDirectorySearch({ now: () => now, watch: silentWatch }) })

  it('shares a prepared index across queries and rebuilds on refresh', async () => {
    mkdir('src')
    write('src/My File.txt')
    search.prepare(root)
    expect(await find('SRC\\MY txt')).toEqual({
      entries: [{ name: 'My File.txt', path: 'src/My File.txt', kind: 'file' }], truncated: false
    })

    write('src/Fresh.txt')
    expect(await paths('fresh')).toEqual([])
    search.prepare(root, true)
    expect(await paths('fresh')).toEqual(['src/Fresh.txt'])
  })

  it('keeps a watched index past the old 10-second expiry', async () => {
    write('Old.txt')
    expect(await paths('old')).toHaveLength(1)
    fs.unlinkSync(path.join(root, 'Old.txt'))
    now = 60_000
    // The silent watcher reported nothing, so the list was not scanned again
    expect(await paths('old')).toEqual(['Old.txt'])
  })

  it('scans nested folders in parallel, skipping .git', async () => {
    for (let i = 0; i < 40; i++) {
      mkdir(`d${i}/inner`)
      write(`d${i}/inner/item-${i}.txt`)
    }
    mkdir('.git/objects')
    write('.git/objects/item-git.txt')
    const found = await paths('item-')
    expect(found).toHaveLength(40)
    expect(found).toContain('d7/inner/item-7.txt')
    expect(found.some(entry => entry.includes('.git'))).toBe(false)
  })

  it('lists installed and generated folders but reads them only when asked to include them', async () => {
    mkdir('node_modules/pkg')
    write('node_modules/pkg/index.js')
    mkdir('packages/app/Build')
    write('packages/app/Build/index.js')
    mkdir('src')
    write('src/index.js')
    const result = await find('index')
    expect(result.entries.map(entry => entry.path)).toEqual(['src/index.js'])
    expect(result.skipped).toEqual({ count: 2, names: expect.arrayContaining(['node_modules', 'Build']) })
    expect(result.includedAll).toBeUndefined()
    // The folder itself can still be found
    expect(await paths('node_modules')).toEqual(['node_modules'])

    const all = await search.search(root, 'index', new AbortController().signal, false, true)
    expect(all.entries.map(entry => entry.path)).toEqual(['node_modules/pkg/index.js', 'packages/app/Build/index.js', 'src/index.js'])
    expect(all.includedAll).toBe(true)
    expect(all.skipped).toBeUndefined()
  })

  it('caps results at 200 and reports truncation', async () => {
    for (let i = 0; i < 250; i++) write(`many-${i}.txt`)
    const result = await find('many')
    expect(result.entries).toHaveLength(200)
    expect(result.truncated).toBe(true)
  })

  it('discards a scan in flight when the workspace search is cleared', async () => {
    const pending = find('old')
    search.clear()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(watchers.every(watcher => watcher.closed)).toBe(true)
    write('New.txt')
    expect((await find('new')).entries).toHaveLength(1)
  })

  it('keeps the last three workspace folders and closes the watcher of the one pushed out', async () => {
    const others = [tempDir(), tempDir(), tempDir()]
    try {
      for (const folder of [root, ...others]) {
        fs.writeFileSync(path.join(folder, 'here.txt'), '')
        await search.search(folder, 'here', new AbortController().signal)
      }
      expect(watchers.map(watcher => watcher.closed)).toEqual([true, false, false, false])
      search.clear()
      expect(watchers.every(watcher => watcher.closed)).toBe(true)
    } finally {
      for (const folder of others) fs.rmSync(folder, { recursive: true, force: true })
    }
  })

  it('does not follow a linked folder', async () => {
    const outside = tempDir()
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), '')
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction')
      const result = await find('linked')
      expect(result.entries).toEqual([{ name: 'linked', path: 'linked', kind: 'link' }])
      expect(await paths('secret')).toEqual([])
    } finally {
      fs.unlinkSync(path.join(root, 'linked'))
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('workspace directory search kept current by fs.watch', () => {
  beforeEach(() => { search = createDirectorySearch({ now: () => now, watch: recordingWatch }) })

  it('adds, removes and renames files and folders as they change', async () => {
    mkdir('src/old-dir/deep')
    write('src/old-dir/deep/buried.txt')
    write('src/Keep.txt')
    expect(await paths('keep')).toEqual(['src/Keep.txt'])

    write('src/Added.txt')
    await eventually(async () => expect(await paths('added')).toEqual(['src/Added.txt']))

    fs.renameSync(path.join(root, 'src/Added.txt'), path.join(root, 'src/Renamed.txt'))
    await eventually(async () => {
      expect(await paths('added')).toEqual([])
      expect(await paths('renamed')).toEqual(['src/Renamed.txt'])
    })

    fs.unlinkSync(path.join(root, 'src/Keep.txt'))
    await eventually(async () => expect(await paths('keep')).toEqual([]))

    fs.rmSync(path.join(root, 'src/old-dir'), { recursive: true })
    await eventually(async () => expect(await paths('old-dir')).toEqual([]))
    expect(await paths('buried')).toEqual([])

    mkdir('src/new-dir/inner')
    write('src/new-dir/inner/fresh.txt')
    await eventually(async () => expect(await paths('fresh')).toEqual(['src/new-dir/inner/fresh.txt']))
    now = 60_000
    expect(await paths('renamed')).toEqual(['src/Renamed.txt'])
  })

  it('ignores changes inside a skipped folder but sees the folder itself come and go', async () => {
    write('Keep.txt')
    expect(await paths('keep')).toEqual(['Keep.txt'])
    mkdir('node_modules/pkg')
    await eventually(async () => expect(await paths('node_modules')).toEqual(['node_modules']))
    write('node_modules/pkg/inside.js')
    write('Later.txt')
    await eventually(async () => expect(await paths('later')).toEqual(['Later.txt']))
    expect(await paths('inside')).toEqual([])
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true })
    await eventually(async () => expect(await paths('node_modules')).toEqual([]))
  })

  it('drops a folder replaced by a link and does not read through it', async () => {
    const outside = tempDir()
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), '')
      mkdir('inner')
      write('inner/visible.txt')
      expect(await paths('visible')).toEqual(['inner/visible.txt'])

      fs.rmSync(path.join(root, 'inner'), { recursive: true })
      fs.symlinkSync(outside, path.join(root, 'inner'), 'junction')
      await eventually(async () => expect(await paths('visible')).toEqual([]))
      // Later changes behind the link must not bring it in either
      fs.writeFileSync(path.join(outside, 'secret-2.txt'), '')
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(await paths('secret')).toEqual([])
      expect((await find('inner')).entries).toEqual([{ name: 'inner', path: 'inner', kind: 'link' }])
    } finally {
      fs.unlinkSync(path.join(root, 'inner'))
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('closes the watcher when cleared (app lock)', async () => {
    write('Here.txt')
    expect(await paths('here')).toEqual(['Here.txt'])
    expect(watchers).toHaveLength(1)
    expect(watchers[0].closed).toBe(false)
    search.clear()
    expect(watchers[0].closed).toBe(true)
  })
})
