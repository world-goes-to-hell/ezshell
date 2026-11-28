import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchContent, checkContentQuery } from './contentSearch.js'

let root
const write = (relative, content) => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
const summary = result => Object.fromEntries(result.files.map(file => [file.path, file.matches.map(match => `${match.line}:${match.text}`)]))

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-content-search-'))) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('project content search', () => {
  it('uses git grep in a repository: tracked and new files, not ignored or binary ones', async () => {
    git('init', '-q')
    write('a.txt', 'hello World\nnothing\nsay Hello again\n')
    write('src/b.js', 'const greeting = "hello"\n')
    write('.gitignore', 'ignored.txt\n')
    write('ignored.txt', 'hello from an ignored file\n')
    write('image.bin', Buffer.from([104, 101, 108, 108, 111, 0, 1, 2]))
    git('add', 'a.txt', '.gitignore')
    write('notes, final (1).md', 'hello with spaces in the name\n')
    // Installed and generated folders the name search skips, not ignored by this repository
    write('node_modules/pkg/index.js', 'hello from a package\n')
    write('web/Build/out.js', 'hello from a build\n')
    const result = await searchContent(root, 'hello')
    expect(result.engine).toBe('git')
    expect(summary(result)).toEqual({
      'a.txt': ['1:hello World', '3:say Hello again'],
      'notes, final (1).md': ['1:hello with spaces in the name'],
      'src/b.js': ['1:const greeting = "hello"']
    })
    expect(result.truncated).toBe(false)
  })

  it('reads the files itself outside a repository, leaving out installed folders, binary and large files', async () => {
    write('app.py', 'print("hello")\n')
    write('node_modules/pkg/index.js', 'hello\n')
    write('data.bin', Buffer.from([104, 101, 108, 108, 111, 0]))
    write('big.log', `hello\n${'x'.repeat(1024 * 1024)}`)
    write('deep/er/note.txt', 'one\nHELLO two\n')
    const result = await searchContent(root, 'hello')
    expect(result.engine).toBe('scan')
    expect(summary(result)).toEqual({ 'app.py': ['1:print("hello")'], 'deep/er/note.txt': ['2:HELLO two'] })
  })

  it.each(['git', 'scan'])('tells case when asked to (%s)', async engine => {
    if (engine === 'git') git('init', '-q')
    write('a.txt', 'World\nworld\n')
    expect(summary(await searchContent(root, 'world', { caseSensitive: true }))).toEqual({ 'a.txt': ['2:world'] })
    expect(summary(await searchContent(root, 'world'))).toEqual({ 'a.txt': ['1:World', '2:world'] })
  })

  it.each(['git', 'scan'])('stops at its limits and says there is more (%s)', async engine => {
    if (engine === 'git') git('init', '-q')
    for (let file = 0; file < 6; file++) write(`f${file}.txt`, Array.from({ length: 10 }, (_, line) => `match ${line}`).join('\n'))
    const result = await searchContent(root, 'match', { maxLines: 12, perFile: 5 })
    expect(result.truncated).toBe(true)
    expect(result.files.reduce((sum, file) => sum + file.matches.length, 0)).toBeLessThanOrEqual(12)
    expect(result.files.every(file => file.matches.length <= 5)).toBe(true)
  })

  it.each(['git', 'scan'])('takes the text as it is, also one that looks like an option or a pattern (%s)', async engine => {
    if (engine === 'git') git('init', '-q')
    write('a.txt', 'run --version now\nprice $5.00 (a+b)*\n')
    expect(summary(await searchContent(root, '--version'))).toEqual({ 'a.txt': ['1:run --version now'] })
    expect(summary(await searchContent(root, '(a+b)*'))).toEqual({ 'a.txt': ['2:price $5.00 (a+b)*'] })
  })

  it('cuts a long line around what it found', async () => {
    write('min.js', `${'a'.repeat(2000)}needle${'b'.repeat(2000)}\n`)
    const [match] = (await searchContent(root, 'needle')).files[0].matches
    expect(match.text.length).toBeLessThanOrEqual(302)
    expect(match.text).toContain('needle')
    expect(match.text.startsWith('…')).toBe(true)
  })

  it.each(['git', 'scan'])('matches regex captures and reports the actual highlighted text (%s)', async engine => {
    if (engine === 'git') git('init', '-q')
    write('src/a.txt', 'Task12: work\nTASK3: done\nno task\n\n')
    write('node_modules/a.txt', 'Task4: dependency\n')
    write('.gitignore', 'ignored.txt\n')
    if (engine === 'git') write('ignored.txt', 'Task5: ignored\n')
    const result = await searchContent(root, '^task\\d+(?=:)', { regex: true })
    expect(result.engine).toBe(engine)
    expect(result.files).toEqual([{ path: 'src/a.txt', matches: [
      { line: 1, text: 'Task12: work', ranges: [[0, 6]] },
      { line: 2, text: 'TASK3: done', ranges: [[0, 5]] }
    ] }])
    expect(summary(await searchContent(root, '^Task\\d+', { regex: true, caseSensitive: true }))).toEqual({ 'src/a.txt': ['1:Task12: work'] })
    expect(summary(await searchContent(root, '^$', { regex: true }))).toEqual({ 'src/a.txt': ['4:'] })
    await expect(searchContent(root, '[', { regex: true })).rejects.toThrow('올바른 정규식')
  })

  it('keeps regex highlights aligned when a long line is shortened', async () => {
    write('min.js', `${'a'.repeat(2000)}task567${'b'.repeat(2000)}\n`)
    const [match] = (await searchContent(root, 'task\\d+', { regex: true })).files[0].matches
    expect(match.text.startsWith('…')).toBe(true)
    expect(match.ranges.map(([start, end]) => match.text.slice(start, end))).toEqual(['task567'])
  })

  it('refuses an empty, multi-line or overly long query and stops when cancelled', async () => {
    for (const query of ['', '   ', 'a\nb', 'x'.repeat(201), 42, null]) expect(() => checkContentQuery(query)).toThrow()
    expect(checkContentQuery('  spaced  ')).toBe('  spaced  ')
    write('a.txt', 'hello\n')
    const controller = new AbortController()
    controller.abort()
    await expect(searchContent(root, 'hello', { signal: controller.signal })).rejects.toThrow()
  })
})
