import { describe, it, expect } from 'vitest'
import { parentOf, replaceChildren, mergeRoot, toFileItem } from './fileExplorerTree'
import type { FileNode } from './fileExplorerNodes'

const file = (path: string, size = 10): FileNode => ({ name: path.split('/').pop() as string, path, type: 'file', isSymlink: false, size })
const dir = (path: string, children: FileNode[] = [], isExpanded = false): FileNode =>
  ({ name: path.split('/').pop() as string, path, type: 'directory', isSymlink: false, children, isLoaded: children.length > 0, isExpanded })

describe('fileExplorerTree', () => {
  it('finds the parent folder', () => {
    expect(parentOf('/var/log/app.log')).toBe('/var/log')
    expect(parentOf('/etc')).toBe('/')
    expect(parentOf('/var/log/')).toBe('/var')
  })

  it('replaces one folder\'s children and keeps open subfolders open', () => {
    const tree = [dir('/var', [dir('/var/log', [file('/var/log/a.log')], true), file('/var/x')], true), dir('/etc')]
    const fresh = [dir('/var/log'), file('/var/new.txt')]
    const next = replaceChildren(tree, '/var', fresh)
    expect(next[0].children?.map(n => n.name)).toEqual(['log', 'new.txt'])
    expect(next[0].children?.[0]).toMatchObject({ isExpanded: true, children: [file('/var/log/a.log')] })
    expect(next[1]).toBe(tree[1])
    expect(tree[0].children?.length).toBe(2)
  })

  it('reaches a nested folder', () => {
    const tree = [dir('/var', [dir('/var/log', [], false)], true)]
    const next = replaceChildren(tree, '/var/log', [file('/var/log/b.log')])
    expect(next[0].children?.[0]).toMatchObject({ isExpanded: true, isLoaded: true, children: [file('/var/log/b.log')] })
  })

  it('keeps open folders when the top level is read again', () => {
    const old = [dir('/var', [file('/var/a')], true), file('/gone')]
    const merged = mergeRoot(old, [dir('/var'), file('/new')])
    expect(merged[0]).toMatchObject({ isExpanded: true, children: [file('/var/a')] })
    expect(merged.map(n => n.name)).toEqual(['var', 'new'])
  })

  it('describes a node for the context menu', () => {
    expect(toFileItem(file('/var/log/app.log', 2048))).toEqual({ name: 'app.log', type: 'file', size: 2048, modifyTime: 0 })
  })
})
