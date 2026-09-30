import { describe, it, expect } from 'vitest'
import { sortFileItems, nextSort, DEFAULT_SORT, type FileSort } from './fileSort'
import type { FileItem } from '../stores/sftpStore'

const file = (name: string, overrides: Partial<FileItem> = {}): FileItem => ({
  name, type: 'file', size: 0, modifyTime: 0, ...overrides
})
const dir = (name: string, overrides: Partial<FileItem> = {}): FileItem => file(name, { type: 'directory', ...overrides })
const names = (items: FileItem[]) => items.map(i => i.name)

describe('sortFileItems', () => {
  const items = [
    file('b.txt', { size: 300, modifyTime: 3000, owner: 'root', permissions: '644' }),
    dir('zeta', { modifyTime: 1000, owner: 'www', permissions: '755' }),
    file('a.txt', { size: 100, modifyTime: 1000, owner: 'www', permissions: '600' }),
    dir('alpha', { modifyTime: 5000, owner: 'root', permissions: '700' }),
    file('c.txt', { size: 200, modifyTime: 2000, owner: 'deploy', permissions: '644' })
  ]

  it('sorts by name ascending with folders first by default', () => {
    expect(names(sortFileItems(items, DEFAULT_SORT))).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt', 'c.txt'])
  })

  it('keeps folders first when sorting by name descending', () => {
    expect(names(sortFileItems(items, { key: 'name', direction: 'desc' }))).toEqual(['zeta', 'alpha', 'c.txt', 'b.txt', 'a.txt'])
  })

  it('sorts files by size, folders stay first and fall back to name', () => {
    expect(names(sortFileItems(items, { key: 'size', direction: 'desc' }))).toEqual(['alpha', 'zeta', 'b.txt', 'c.txt', 'a.txt'])
    expect(names(sortFileItems(items, { key: 'size', direction: 'asc' }))).toEqual(['alpha', 'zeta', 'a.txt', 'c.txt', 'b.txt'])
  })

  it('sorts by modified time within folders and within files', () => {
    expect(names(sortFileItems(items, { key: 'modifyTime', direction: 'desc' }))).toEqual(['alpha', 'zeta', 'b.txt', 'c.txt', 'a.txt'])
  })

  it('sorts by owner and breaks ties by name', () => {
    expect(names(sortFileItems(items, { key: 'owner', direction: 'asc' }))).toEqual(['alpha', 'zeta', 'c.txt', 'b.txt', 'a.txt'])
  })

  it('sorts by permissions', () => {
    expect(names(sortFileItems(items, { key: 'permissions', direction: 'asc' }))).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt', 'c.txt'])
  })

  it('compares numbers inside names naturally', () => {
    const logs = [file('log10'), file('log2'), file('log1')]
    expect(names(sortFileItems(logs, DEFAULT_SORT))).toEqual(['log1', 'log2', 'log10'])
  })

  it('orders names that differ only in case the same way regardless of input order', () => {
    const upperFirst = [file('README'), file('readme')]
    const lowerFirst = [file('readme'), file('README')]
    expect(names(sortFileItems(upperFirst, DEFAULT_SORT))).toEqual(names(sortFileItems(lowerFirst, DEFAULT_SORT)))
  })

  it('does not mutate the input list', () => {
    const input = [file('b'), file('a')]
    sortFileItems(input, DEFAULT_SORT)
    expect(names(input)).toEqual(['b', 'a'])
  })

  it('puts entries without the sort value after the others', () => {
    const mixed = [file('x'), file('y', { owner: 'root' })]
    expect(names(sortFileItems(mixed, { key: 'owner', direction: 'asc' }))).toEqual(['y', 'x'])
  })
})

describe('nextSort', () => {
  it('flips the direction when the same column is clicked again', () => {
    expect(nextSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', direction: 'desc' })
    expect(nextSort({ key: 'name', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' })
  })

  it('starts text columns ascending and date/size columns descending', () => {
    const current: FileSort = DEFAULT_SORT
    expect(nextSort(current, 'owner')).toEqual({ key: 'owner', direction: 'asc' })
    expect(nextSort(current, 'modifyTime')).toEqual({ key: 'modifyTime', direction: 'desc' })
    expect(nextSort(current, 'size')).toEqual({ key: 'size', direction: 'desc' })
  })
})
