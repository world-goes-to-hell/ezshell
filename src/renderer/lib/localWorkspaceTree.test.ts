import { describe, it, expect } from 'vitest'
import { pathKey, isInsidePath, worktreeOf, assignTabs, folderLabel } from './localWorkspaceTree'

describe('pathKey', () => {
  it('compares Windows paths without case and with either slash', () => {
    expect(pathKey('D:\\Work\\Repo\\')).toBe('d:/work/repo')
    expect(pathKey('d:/work/repo')).toBe('d:/work/repo')
    expect(pathKey('C:\\')).toBe('c:/')
  })

  it('keeps case on other systems', () => {
    expect(pathKey('/home/Me/repo/')).toBe('/home/Me/repo')
    expect(pathKey('/')).toBe('/')
  })
})

describe('isInsidePath', () => {
  it('is true for the folder itself and below it, not for a name that only starts the same', () => {
    expect(isInsidePath('D:\\work\\repo', 'd:/work/repo')).toBe(true)
    expect(isInsidePath('D:\\work\\repo\\src', 'D:\\work\\repo')).toBe(true)
    expect(isInsidePath('D:\\work\\repo-feature', 'D:\\work\\repo')).toBe(false)
    expect(isInsidePath('D:\\anything', 'D:\\')).toBe(true)
  })
})

describe('worktreeOf', () => {
  const trees = ['D:\\work\\repo', 'D:\\work\\repo-feature', 'D:\\work\\repo\\nested']
  it('picks the deepest worktree holding the folder', () => {
    expect(worktreeOf('D:\\work\\repo\\nested\\src', trees)).toBe('D:\\work\\repo\\nested')
    expect(worktreeOf('d:/work/repo/src', trees)).toBe('D:\\work\\repo')
    expect(worktreeOf('D:\\work\\repo-feature', trees)).toBe('D:\\work\\repo-feature')
  })

  it('is null outside every worktree or without a folder', () => {
    expect(worktreeOf('C:\\Users\\me', trees)).toBeNull()
    expect(worktreeOf(undefined, trees)).toBeNull()
  })
})

describe('assignTabs', () => {
  it('groups tabs under their worktree and keeps the rest apart, in tab order', () => {
    const result = assignTabs([
      { id: 'local:1', cwd: 'D:\\work\\repo' },
      { id: 'local:2', cwd: 'C:\\Users\\me' },
      { id: 'local:3', cwd: 'D:\\work\\repo\\src' },
      { id: 'local:4' }
    ], ['D:\\work\\repo'])
    expect(result.byWorktree.get('D:\\work\\repo')).toEqual(['local:1', 'local:3'])
    expect(result.others).toEqual(['local:2', 'local:4'])
  })
})

describe('folderLabel', () => {
  it('is the last folder name', () => {
    expect(folderLabel('D:\\work\\my-ssh-client\\')).toBe('my-ssh-client')
    expect(folderLabel('/home/me/gsd')).toBe('gsd')
  })
})
