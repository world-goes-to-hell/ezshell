import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import setupModule from './clientSetup.js'

const { buildServerEntry, applyServerEntry, SetupError, TOKEN_ENV_VAR } = setupModule

const NAME = 'my-ssh-client'
const BOM = String.fromCharCode(0xfeff)
const TOKEN = 'a'.repeat(64)
const entry = buildServerEntry({ url: 'http://127.0.0.1:47521/mcp', token: TOKEN, useEnvToken: true })

function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-setup-'))
  const filePath = path.join(dir, '.mcp.json')
  if (content !== undefined) fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8').replace(BOM, ''))

describe('buildServerEntry', () => {
  it('refers to the token through an environment variable for project files', () => {
    expect(TOKEN_ENV_VAR).toBe('EZSHELL_MCP_TOKEN')
    expect(entry).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:47521/mcp',
      headers: { Authorization: 'Bearer ${EZSHELL_MCP_TOKEN}' }
    })
  })

  it('writes the token itself for the user-scope file', () => {
    expect(buildServerEntry({ url: 'http://127.0.0.1:50000/mcp', token: TOKEN, useEnvToken: false }).headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
  })
})

describe('applyServerEntry', () => {
  it('creates a missing file when allowed, without a backup', () => {
    const filePath = tempFile()
    const result = applyServerEntry({ filePath, name: NAME, entry, createIfMissing: true })
    expect(result).toMatchObject({ result: 'added', backupPath: null })
    expect(readJson(filePath)).toEqual({ mcpServers: { [NAME]: entry } })
    expect(fs.readFileSync(filePath, 'utf8').endsWith('\n')).toBe(true)
    expect(fs.existsSync(`${filePath}.ezshell-backup`)).toBe(false)
  })

  it('refuses a missing file when creating is not allowed', () => {
    const filePath = tempFile()
    expect(() => applyServerEntry({ filePath, name: NAME, entry, createIfMissing: false })).toThrow(SetupError)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('keeps every other key and server and backs the original up', () => {
    const original = JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'x' } }, projects: { a: {} } }, null, 2)
    const filePath = tempFile(original)
    const result = applyServerEntry({ filePath, name: NAME, entry })
    expect(result).toMatchObject({ result: 'added', backupPath: `${filePath}.ezshell-backup` })
    expect(readJson(filePath)).toEqual({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'x' }, [NAME]: entry }, projects: { a: {} } })
    expect(fs.readFileSync(result.backupPath, 'utf8')).toBe(original)
    expect(fs.existsSync(`${filePath}.ezshell-tmp`)).toBe(false)
  })

  it('keeps the indentation of the original file', () => {
    const filePath = tempFile('{\n    "mcpServers": {}\n}\n')
    applyServerEntry({ filePath, name: NAME, entry })
    expect(fs.readFileSync(filePath, 'utf8').startsWith('{\n    "mcpServers": {\n        "my-ssh-client"')).toBe(true)
  })

  it('leaves the file alone when the same entry is already there', () => {
    const original = JSON.stringify({ mcpServers: { [NAME]: entry } })
    const filePath = tempFile(original)
    expect(applyServerEntry({ filePath, name: NAME, entry }).result).toBe('unchanged')
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
    expect(fs.existsSync(`${filePath}.ezshell-backup`)).toBe(false)
  })

  it('reports a different entry of the same name without its headers, and replaces it only on overwrite', () => {
    const old = { type: 'http', url: 'http://127.0.0.1:1111/mcp', headers: { Authorization: 'Bearer secret' } }
    const original = JSON.stringify({ mcpServers: { [NAME]: old } })
    const filePath = tempFile(original)
    const conflict = applyServerEntry({ filePath, name: NAME, entry })
    expect(conflict).toEqual({ result: 'conflict', existingUrl: 'http://127.0.0.1:1111/mcp', backupPath: null, shadowedProjects: [] })
    expect(JSON.stringify(conflict)).not.toContain('secret')
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
    expect(applyServerEntry({ filePath, name: NAME, entry, overwrite: true }).result).toBe('replaced')
    expect(readJson(filePath).mcpServers[NAME]).toEqual(entry)
  })

  it.each([
    ['broken JSON', '{ "mcpServers": '],
    ['an array root', '[]'],
    ['a non-object mcpServers', '{ "mcpServers": "x" }'],
    ['an array mcpServers', '{ "mcpServers": [] }']
  ])('refuses %s and does not touch the file', (label, original) => {
    const filePath = tempFile(original)
    expect(() => applyServerEntry({ filePath, name: NAME, entry, overwrite: true })).toThrow(SetupError)
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
    expect(fs.existsSync(`${filePath}.ezshell-backup`)).toBe(false)
  })

  it('reads a file that starts with a byte order mark', () => {
    const filePath = tempFile('\uFEFF{ "mcpServers": {} }')
    expect(applyServerEntry({ filePath, name: NAME, entry }).result).toBe('added')
    expect(readJson(filePath).mcpServers[NAME]).toEqual(entry)
  })

  it('treats an empty project file as an empty object', () => {
    const filePath = tempFile('  \n')
    expect(applyServerEntry({ filePath, name: NAME, entry, createIfMissing: true }).result).toBe('added')
  })

  it('refuses an empty file it may not create (a half-written ~/.claude.json)', () => {
    const filePath = tempFile('')
    expect(() => applyServerEntry({ filePath, name: NAME, entry, createIfMissing: false })).toThrow(SetupError)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('')
  })

  it('refuses a file that is not UTF-8 instead of rewriting damaged text', () => {
    const filePath = tempFile()
    // "가" in CP949 inside a string value
    const original = Buffer.concat([Buffer.from('{ "mcpServers": { "x": { "args": ["'), Buffer.from([0xb0, 0xa1]), Buffer.from('"] } } }')])
    fs.writeFileSync(filePath, original)
    expect(() => applyServerEntry({ filePath, name: NAME, entry })).toThrow(/UTF-8/)
    expect(fs.readFileSync(filePath).equals(original)).toBe(true)
  })

  it('keeps CRLF line endings and a byte order mark, and backs up the exact bytes', () => {
    const original = `${BOM}{\r\n  "mcpServers": {}\r\n}\r\n`
    const filePath = tempFile(original)
    const { backupPath } = applyServerEntry({ filePath, name: NAME, entry })
    const written = fs.readFileSync(filePath, 'utf8')
    expect(written.startsWith(`${BOM}{\r\n  "mcpServers": {\r\n`)).toBe(true)
    expect(written.replace(/\r\n/g, '').includes('\n')).toBe(false)
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original)
  })

  it('gives up when another program changes the file while it is being written', () => {
    const filePath = tempFile('{ "mcpServers": {} }')
    const theirs = '{ "mcpServers": {}, "numStartups": 9 }'
    const racing = {
      ...fs,
      writeFileSync: (target, ...rest) => {
        fs.writeFileSync(target, ...rest)
        if (String(target).endsWith('.ezshell-tmp')) fs.writeFileSync(filePath, theirs, 'utf8')
      }
    }
    expect(() => applyServerEntry({ filePath, name: NAME, entry, fileSystem: racing })).toThrow(/다른 프로그램/)
    expect(fs.readFileSync(filePath, 'utf8')).toBe(theirs)
    expect(fs.existsSync(`${filePath}.ezshell-tmp`)).toBe(false)
  })

  it('lists projects whose local registration of the same name would win over the user-scope entry', () => {
    const filePath = tempFile(JSON.stringify({
      projects: {
        'D:/work/a': { mcpServers: { [NAME]: { type: 'http', url: 'x' } } },
        'D:/work/b': { mcpServers: { other: {} } },
        'D:/work/c': {}
      }
    }))
    expect(applyServerEntry({ filePath, name: NAME, entry }).shadowedProjects).toEqual(['D:/work/a'])
  })
})

describe('findLocalRegistrations', () => {
  const { findLocalRegistrations } = setupModule
  const claudeJson = (projects) => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-home-')), '.claude.json')
    fs.writeFileSync(filePath, JSON.stringify({ projects }))
    return filePath
  }

  it('finds a local-scope entry of the same name for the folder, however the path is spelled', () => {
    const filePath = claudeJson({
      'D:/Work/App': { mcpServers: { [NAME]: {} } },
      'D:/work/other': { mcpServers: { [NAME]: {} } },
      'D:/work/app2': { mcpServers: { other: {} } }
    })
    expect(findLocalRegistrations({ filePath, projectDir: 'd:\\work\\app\\', name: NAME, platform: 'win32' })).toEqual(['D:/Work/App'])
    expect(findLocalRegistrations({ filePath, projectDir: 'D:\\work\\app2', name: NAME, platform: 'win32' })).toEqual([])
  })

  it('compares case-sensitively off Windows', () => {
    const filePath = claudeJson({ '/home/me/App': { mcpServers: { [NAME]: {} } } })
    expect(findLocalRegistrations({ filePath, projectDir: '/home/me/app', name: NAME, platform: 'linux' })).toEqual([])
    expect(findLocalRegistrations({ filePath, projectDir: '/home/me/App/', name: NAME, platform: 'linux' })).toEqual(['/home/me/App'])
  })

  it('returns nothing for a missing or broken file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-home-'))
    expect(findLocalRegistrations({ filePath: path.join(dir, '.claude.json'), projectDir: 'D:\\a', name: NAME })).toEqual([])
    fs.writeFileSync(path.join(dir, '.claude.json'), '{ broken')
    expect(findLocalRegistrations({ filePath: path.join(dir, '.claude.json'), projectDir: 'D:\\a', name: NAME })).toEqual([])
  })
})
