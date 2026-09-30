import { describe, it, expect } from 'vitest'
import { toFileNodes, type RemoteListEntry } from './fileExplorerNodes'

const entry = (name: string, overrides: Partial<RemoteListEntry> = {}): RemoteListEntry => ({
  name,
  isDirectory: false,
  ...overrides
})

describe('toFileNodes', () => {
  it('drops . and .. and builds child paths under the root', () => {
    const nodes = toFileNodes([entry('.'), entry('..'), entry('etc', { isDirectory: true })], '/')
    expect(nodes.map(n => n.path)).toEqual(['/etc'])
  })

  it('builds child paths under a nested directory', () => {
    expect(toFileNodes([entry('a.txt')], '/home/user')[0].path).toBe('/home/user/a.txt')
  })

  it('treats a link to a directory as an expandable directory marked as a link', () => {
    const [node] = toFileNodes([entry('app', { isSymlink: true, targetIsDirectory: true, linkTarget: '/opt/app' })], '/srv')
    expect(node).toMatchObject({ type: 'directory', isSymlink: true, linkTarget: '/opt/app', isBrokenLink: false, children: [] })
  })

  it('treats a link to a file as a file marked as a link', () => {
    const [node] = toFileNodes([entry('localtime', { isSymlink: true, targetIsDirectory: false })], '/etc')
    expect(node).toMatchObject({ type: 'file', isSymlink: true })
    expect(node.children).toBeUndefined()
  })

  it('keeps a broken link as a non-expandable entry', () => {
    const [node] = toFileNodes([entry('old', { isSymlink: true, isBrokenLink: true, linkTarget: '/gone' })], '/srv')
    expect(node).toMatchObject({ type: 'file', isSymlink: true, isBrokenLink: true, linkTarget: '/gone' })
  })

  it('does not mark regular entries as links', () => {
    const [node] = toFileNodes([entry('var', { isDirectory: true })], '/')
    expect(node.isSymlink).toBe(false)
  })

  it('sorts directories (including directory links) before files, then by name', () => {
    const nodes = toFileNodes([
      entry('zeta.txt'),
      entry('lib', { isSymlink: true, targetIsDirectory: true }),
      entry('bin', { isDirectory: true }),
      entry('alpha.txt')
    ], '/')
    expect(nodes.map(n => n.name)).toEqual(['bin', 'lib', 'alpha.txt', 'zeta.txt'])
  })
})
