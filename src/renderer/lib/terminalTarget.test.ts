import { describe, it, expect } from 'vitest'
import { wordAtColumn, wordsInCells, looksLikeName, cleanName, resolveName, needsHome, splitPath, type TerminalCell } from './terminalTarget'

/** A terminal line as cells; a wide character takes two columns (the second is empty, width 0) */
function cells(text: string): TerminalCell[] {
  const out: TerminalCell[] = []
  for (const ch of text) {
    const wide = /[ᄀ-ￜ]/.test(ch)
    out.push({ text: ch, width: wide ? 2 : 1 })
    if (wide) out.push({ text: '', width: 0 })
  }
  return out
}

describe('wordAtColumn', () => {
  const line = cells('-rw-r--r-- 1 wcp wcp  1204 Nov  2 10:01 compose.yaml')

  it('takes the word under the column', () => {
    expect(wordAtColumn(line, 45)).toBe('compose.yaml')
    expect(wordAtColumn(line, line.length - 1)).toBe('compose.yaml')
    expect(wordAtColumn(line, 0)).toBe('-rw-r--r--')
  })

  it('is empty on a space and outside the line', () => {
    expect(wordAtColumn(line, 10)).toBe('')
    expect(wordAtColumn(line, 999)).toBe('')
    expect(wordAtColumn(line, -1)).toBe('')
  })

  it('counts a wide character as two columns', () => {
    const korean = cells('백업 보고서.txt')
    // "백업" takes columns 0..3, the space column 4, "보고서.txt" starts at 5
    expect(wordAtColumn(korean, 1)).toBe('백업')
    expect(wordAtColumn(korean, 3)).toBe('백업')
    expect(wordAtColumn(korean, 6)).toBe('보고서.txt')
  })
})

describe('wordsInCells', () => {
  it('gives each word with its columns', () => {
    expect(wordsInCells(cells('log  old.txt'))).toEqual([{ text: 'log', start: 0, end: 2 }, { text: 'old.txt', start: 5, end: 11 }])
    expect(wordsInCells(cells('   '))).toEqual([])
  })

  it('gives a wide character two columns', () => {
    expect(wordsInCells(cells('백업 a'))).toEqual([{ text: '백업', start: 0, end: 3 }, { text: 'a', start: 5, end: 5 }])
  })
})

describe('looksLikeName', () => {
  it('leaves out what ls -l prints around the names', () => {
    for (const word of ['-rw-r--r--', 'drwxr-xr-x.', 'lrwxrwxrwx', '4096', '12K', '1.2M', '10:01', '2026-11-02', 'Nov', '2']) expect(looksLikeName(word), word).toBe(false)
  })

  it('keeps names, also short and odd ones', () => {
    for (const word of ['compose.yaml', 'log', 'root', 'a', '.env', 'README', 'v2', '2026-report.txt']) expect(looksLikeName(word), word).toBe(true)
  })
})

describe('cleanName', () => {
  it('drops quotes, brackets and the marks after a name', () => {
    expect(cleanName('\'my file.txt\'')).toBe('my file.txt')
    expect(cleanName('run.sh*')).toBe('run.sh')
    expect(cleanName('logs/')).toBe('logs')
    expect(cleanName('current@')).toBe('current')
    expect(cleanName('app.log:12:')).toBe('app.log:12')
    expect(cleanName('(/etc/nginx/nginx.conf)')).toBe('/etc/nginx/nginx.conf')
    expect(cleanName('/var/log/app.log,')).toBe('/var/log/app.log')
  })

  it('refuses what cannot be a name', () => {
    for (const word of ['', '   ', '.', '..', '->', '***', '-----', 'a\u0007b', 'x'.repeat(600)]) expect(cleanName(word), word).toBeNull()
  })
})

describe('resolveName', () => {
  it('joins a name with the folder the terminal is in', () => {
    expect(resolveName('compose.yaml', '/data/portal', null)).toBe('/data/portal/compose.yaml')
    expect(resolveName('conf/app.yml', '/data/portal', null)).toBe('/data/portal/conf/app.yml')
    expect(resolveName('../other/a.txt', '/data/portal', null)).toBe('/data/other/a.txt')
    expect(resolveName('./run.sh', '/', null)).toBe('/run.sh')
  })

  it('keeps an absolute path and expands the home folder', () => {
    expect(resolveName('/etc/hosts', undefined, null)).toBe('/etc/hosts')
    expect(resolveName('/var//log/./app.log', '/tmp', null)).toBe('/var/log/app.log')
    expect(resolveName('~/app/.env', '/tmp', '/home/wcp')).toBe('/home/wcp/app/.env')
    expect(resolveName('a.txt', '~/app', '/home/wcp')).toBe('/home/wcp/app/a.txt')
    expect(resolveName('a.txt', '~', '/home/wcp')).toBe('/home/wcp/a.txt')
  })

  it('gives nothing when the folder or the home folder is unknown, or the path leaves the root', () => {
    expect(resolveName('a.txt', undefined, null)).toBeNull()
    expect(resolveName('a.txt', '~/app', null)).toBeNull()
    expect(resolveName('~/a.txt', '/tmp', null)).toBeNull()
    expect(resolveName('~other/a.txt', '/tmp', '/home/wcp')).toBeNull()
    expect(resolveName('../../a.txt', '/tmp', null)).toBeNull()
    expect(resolveName('a.txt', 'portal', null)).toBeNull()
  })
})

describe('needsHome', () => {
  it('is true only when a ~ has to be expanded', () => {
    expect(needsHome('a.txt', '/data')).toBe(false)
    expect(needsHome('/etc/hosts', '~')).toBe(false)
    expect(needsHome('a.txt', '~/app')).toBe(true)
    expect(needsHome('~/a.txt', '/data')).toBe(true)
  })
})

describe('splitPath', () => {
  it('splits into the folder and the name', () => {
    expect(splitPath('/data/portal/compose.yaml')).toEqual({ folder: '/data/portal', name: 'compose.yaml' })
    expect(splitPath('/hosts')).toEqual({ folder: '/', name: 'hosts' })
  })
})
