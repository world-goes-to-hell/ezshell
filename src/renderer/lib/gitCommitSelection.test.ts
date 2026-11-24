import { describe, expect, it } from 'vitest'
import { buildChangeTree, type ChangedFile, type ChangeFolder } from './gitChangeTree'
import { checkState, nextSelection, selectablePaths, toggleOne, togglePaths } from './gitCommitSelection'

const file = (path: string, kind: ChangedFile['kind'] = 'modified', staged = false): ChangedFile =>
  ({ path, kind, added: 1, removed: 0, staged })

describe('selectablePaths', () => {
  it('gives the files under a folder, without conflicts or nested repositories', () => {
    const tree = buildChangeTree([file('src/a.ts'), file('src/lib/b.ts'), file('src/c.ts', 'conflict'), file('README.md'), file('src/vendor/', 'untracked')])
    const src = tree.find((node): node is ChangeFolder => node.kind === 'folder' && node.path === 'src')!
    expect(selectablePaths(src).sort()).toEqual(['src/a.ts', 'src/lib/b.ts'])
    expect(selectablePaths(tree).sort()).toEqual(['README.md', 'src/a.ts', 'src/lib/b.ts'])
  })
})

describe('checkState', () => {
  it('is all, some or none of the paths', () => {
    const paths = ['a', 'b']
    expect(checkState(paths, new Set(['a', 'b', 'x']))).toBe('all')
    expect(checkState(paths, new Set(['b']))).toBe('some')
    expect(checkState(paths, new Set(['x']))).toBe('none')
    expect(checkState([], new Set(['x']))).toBe('none')
  })
})

describe('toggling', () => {
  it('ticks all of a folder unless all are ticked, then unticks them', () => {
    const some = togglePaths(new Set(['a']), ['a', 'b'])
    expect([...some].sort()).toEqual(['a', 'b'])
    const none = togglePaths(new Set(['a', 'b', 'x']), ['a', 'b'])
    expect([...none]).toEqual(['x'])
  })

  it('flips one file and leaves the set it was given alone', () => {
    const before = new Set(['a'])
    expect([...toggleOne(before, 'b')].sort()).toEqual(['a', 'b'])
    expect([...toggleOne(before, 'a')]).toEqual([])
    expect([...before]).toEqual(['a'])
  })
})

describe('nextSelection', () => {
  it('ticks the staged files on the first read', () => {
    const next = nextSelection(null, [file('a', 'modified', true), file('b'), file('c', 'untracked')])
    expect([...next.selected]).toEqual(['a'])
    expect([...next.staged]).toEqual(['a'])
  })

  it('ticks a file when it becomes staged, and does not tick again one the user unticked', () => {
    const first = nextSelection(null, [file('a', 'modified', true), file('b')])
    const unticked = { ...first, selected: new Set<string>() }
    const next = nextSelection(unticked, [file('a', 'modified', true), file('b', 'modified', true)])
    expect([...next.selected]).toEqual(['b'])
  })

  it('drops paths that left the list or became conflicts, and keeps the rest', () => {
    const previous = { selected: new Set(['a', 'b', 'c']), staged: new Set<string>() }
    const next = nextSelection(previous, [file('a'), file('c', 'conflict'), file('d')])
    expect([...next.selected]).toEqual(['a'])
  })
})
