import { describe, it, expect } from 'vitest'
import { buildChoices, upsertSavedConnection, removeSavedConnection, endpointProblem, endpointKey } from './dbChoices'
import { splitStatements, statementAt, quoteIdentifier, previewQuery } from './sqlStatements'
import type { DiscoveredDb, SavedDbConnection } from '../types/db'

const FOUND: DiscoveredDb[] = [
  { engine: 'mysql', label: 'MySQL', host: '127.0.0.1', port: 3306, isLocalOnly: true, isSupported: true, isConfirmed: true },
  { engine: 'postgres', label: 'PostgreSQL', host: '127.0.0.1', port: 5432, isLocalOnly: false, isSupported: true, isConfirmed: false },
  { engine: 'oracle', label: 'Oracle', host: '127.0.0.1', port: 1521, isLocalOnly: false, isSupported: false, isConfirmed: false }
]
const SAVED: SavedDbConnection = { id: 's1', engine: 'mysql', host: 'localhost', port: 3306, user: 'reader', password: 'pw', database: 'shop' }

describe('buildChoices', () => {
  it('puts saved accounts first and leaves out found databases they already cover', () => {
    const choices = buildChoices(FOUND, [SAVED])
    expect(choices.map(c => c.key)).toEqual(['saved:s1', `found:${endpointKey(FOUND[1])}`, `found:${endpointKey(FOUND[2])}`])
    expect(choices[0]).toMatchObject({ label: 'MySQL', detail: 'reader/shop · localhost:3306', isGuess: false })
    expect(choices[1].isGuess).toBe(true)
    expect(choices[2].isSupported).toBe(false)
  })

  it('works with nothing found', () => {
    expect(buildChoices([], [SAVED])[0].label).toBe('MySQL/MariaDB')
    expect(buildChoices([], [])).toEqual([])
  })
})

describe('saved connections', () => {
  it('replaces the same account and keeps the list unchanged', () => {
    const list = [SAVED]
    const next = upsertSavedConnection(list, { ...SAVED, id: 's2', host: '127.0.0.1', password: 'new' })
    expect(next).toEqual([{ ...SAVED, id: 's2', host: '127.0.0.1', password: 'new' }])
    expect(list).toEqual([SAVED])
    expect(upsertSavedConnection(list, { ...SAVED, id: 's3', user: 'other' }).length).toBe(2)
    expect(removeSavedConnection(next, 's2')).toEqual([])
  })
})

describe('endpointProblem', () => {
  it('names what is missing', () => {
    expect(endpointProblem({ host: '', port: 3306 }, 'a')).toContain('호스트')
    expect(endpointProblem({ host: 'a b', port: 3306 }, 'a')).toContain('공백')
    expect(endpointProblem({ host: 'db', port: '0' }, 'a')).toContain('포트')
    expect(endpointProblem({ host: 'db', port: 3306 }, ' ')).toContain('사용자')
    expect(endpointProblem({ host: '10.0.0.5', port: '5432' }, 'app')).toBeNull()
  })
})

describe('statements', () => {
  const sql = "SELECT 1;\n-- next\nSELECT ';' FROM t;\n\nSELECT 3"

  it('splits on semicolons outside strings and comments', () => {
    expect(splitStatements(sql).map(r => r.text)).toEqual(['SELECT 1', "-- next\nSELECT ';' FROM t", 'SELECT 3'])
    expect(splitStatements('  ;; -- only\n')).toEqual([])
  })

  it('picks the statement at the cursor, or the one just before it', () => {
    expect(statementAt(sql, 3)?.text).toBe('SELECT 1')
    expect(statementAt(sql, 9)?.text).toBe('SELECT 1')
    expect(statementAt(sql, sql.indexOf('FROM'))?.text).toContain("SELECT ';'")
    expect(statementAt(sql, sql.length)?.text).toBe('SELECT 3')
    expect(statementAt('', 0)).toBeNull()
  })

  it('quotes identifiers for each engine', () => {
    expect(quoteIdentifier('a`b', 'mysql')).toBe('`a``b`')
    expect(quoteIdentifier('a"b', 'postgres')).toBe('"a""b"')
    expect(previewQuery('shop', 'orders', 'mysql')).toBe('SELECT * FROM `shop`.`orders` LIMIT 100;')
  })
})
