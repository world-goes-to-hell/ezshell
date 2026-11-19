import { describe, it, expect } from 'vitest'
import { mergeChanges, buildChangeTree, totalLines, formatCount, type ChangeFolder } from './gitChangeTree'

describe('mergeChanges', () => {
  it('keeps one entry per path, the work tree kind winning, with line counts and the staged mark', () => {
    const files = mergeChanges(
      [{ path: 'src/a.ts', kind: 'added' }, { path: 'b.md', kind: 'modified' }],
      [{ path: 'src/a.ts', kind: 'modified' }, { path: 'gone.txt', kind: 'deleted' }],
      [{ path: 'new/c.js', kind: 'untracked' }],
      { 'src/a.ts': [10, 2], 'new/c.js': [5, 0], 'gone.txt': [0, 7] }
    )
    expect(files.map(f => [f.path, f.kind, f.added, f.removed, f.staged])).toEqual([
      ['src/a.ts', 'added', 10, 2, true],
      ['b.md', 'modified', null, null, true],
      ['gone.txt', 'deleted', 0, 7, false],
      ['new/c.js', 'untracked', 5, 0, false]
    ])
  })
})

describe('buildChangeTree', () => {
  const files = mergeChanges([], [
    { path: 'e2e/specs/b.js', kind: 'modified' },
    { path: 'e2e/specs/a.js', kind: 'modified' },
    { path: 'e2e/run.js', kind: 'modified' },
    { path: 'README.md', kind: 'modified' }
  ], [{ path: 'mockups/_assets/book.js', kind: 'untracked' }])

  it('puts folders first, then files, sorted, each folder counting the files below it', () => {
    const tree = buildChangeTree(files)
    expect(tree.map(n => `${n.kind}:${n.name}`)).toEqual(['folder:e2e', 'folder:mockups', 'file:README.md'])
    const e2e = tree[0] as ChangeFolder
    expect(e2e.count).toBe(3)
    expect(e2e.children.map(n => `${n.kind}:${n.name}`)).toEqual(['folder:specs', 'file:run.js'])
    expect((e2e.children[0] as ChangeFolder).children.map(n => n.name)).toEqual(['a.js', 'b.js'])
    expect((tree[1] as ChangeFolder).children[0].path).toBe('mockups/_assets')
  })
})

describe('totalLines', () => {
  it('adds the counts, a binary file counting as nothing', () => {
    const files = mergeChanges([], [{ path: 'a', kind: 'modified' }, { path: 'img.png', kind: 'modified' }], [], { a: [3, 1], 'img.png': [null, null] })
    expect(totalLines(files)).toEqual({ added: 3, removed: 1 })
    expect(formatCount(18966)).toBe('18,966')
  })
})
