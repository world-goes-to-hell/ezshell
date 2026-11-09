import { describe, it, expect } from 'vitest'
import {
  addConsole, removeConsole, renameConsole, withSql, neighbourOf, nextConsoleName, parseConsoles, serializeConsoles, MAX_CONSOLES, DEFAULT_SQL
} from './dbConsoles'

describe('dbConsoles', () => {
  it('names new consoles with the smallest free number', () => {
    const one = addConsole([])
    expect(one[0]).toMatchObject({ name: '콘솔 1', sql: DEFAULT_SQL })
    const three = addConsole(addConsole(one))
    expect(three.map(c => c.name)).toEqual(['콘솔 1', '콘솔 2', '콘솔 3'])
    expect(nextConsoleName(removeConsole(three, three[1].id))).toBe('콘솔 2')
  })

  it('stops at the maximum and always keeps one console', () => {
    let list = addConsole([])
    for (let i = 0; i < MAX_CONSOLES + 3; i++) list = addConsole(list)
    expect(list.length).toBe(MAX_CONSOLES)
    const single = addConsole([])
    const after = removeConsole(single, single[0].id)
    expect(after.length).toBe(1)
    expect(after[0].id).not.toBe(single[0].id)
  })

  it('renames and edits without changing the old list', () => {
    const list = addConsole(addConsole([]))
    const renamed = renameConsole(list, list[1].id, '  비교용  ')
    expect(renamed[1].name).toBe('비교용')
    expect(list[1].name).toBe('콘솔 2')
    expect(renameConsole(list, list[1].id, '   ')).toBe(list)
    expect(withSql(list, list[0].id, 'SELECT 1')[0].sql).toBe('SELECT 1')
  })

  it('shows the next console after closing one, else the previous', () => {
    const list = addConsole(addConsole(addConsole([])))
    expect(neighbourOf(list, list[1].id)).toBe(list[2].id)
    expect(neighbourOf(list, list[2].id)).toBe(list[1].id)
    expect(neighbourOf(list, 'none')).toBeNull()
  })

  it('stores and reads back only usable consoles', () => {
    const list = withSql(addConsole([]), addConsole([])[0].id, 'x')
    const read = parseConsoles(serializeConsoles(list))
    expect(read.map(c => c.name)).toEqual(['콘솔 1'])
    expect(parseConsoles(null).length).toBe(1)
    expect(parseConsoles('not json').length).toBe(1)
    expect(parseConsoles('[{"id":1}]').length).toBe(1)
    expect(parseConsoles('[{"id":"a","name":"A","sql":"SELECT 2"}]')).toEqual([{ id: 'a', name: 'A', sql: 'SELECT 2' }])
  })
})
