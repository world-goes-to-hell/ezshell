import { describe, it, expect } from 'vitest'
import { buildGroups, accountTitle, upsertSavedConnection, removeSavedConnection, endpointProblem, endpointKey, normalizeAlias, withAlias, ALIAS_MAX_LENGTH } from './dbChoices'
import { splitStatements, statementAt, quoteIdentifier, previewQuery } from './sqlStatements'
import type { DiscoveredDb, SavedDbConnection } from '../types/db'

const FOUND: DiscoveredDb[] = [
  { engine: 'mysql', label: 'MySQL', host: '127.0.0.1', port: 3306, isLocalOnly: true, isSupported: true, isConfirmed: true },
  { engine: 'postgres', label: 'PostgreSQL', host: '127.0.0.1', port: 5432, isLocalOnly: false, isSupported: true, isConfirmed: false },
  { engine: 'oracle', label: 'Oracle', host: '127.0.0.1', port: 1521, isLocalOnly: false, isSupported: false, isConfirmed: false }
]
const SAVED: SavedDbConnection = { id: 's1', engine: 'mysql', host: 'localhost', port: 3306, user: 'reader', password: 'pw', database: 'shop' }

describe('buildGroups', () => {
  it('groups saved accounts by server, then adds found servers without accounts', () => {
    const admin: SavedDbConnection = { id: 's2', label: '관리자', engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'root' }
    const groups = buildGroups(FOUND, [SAVED, admin])
    expect(groups.map(g => g.key)).toEqual([endpointKey(FOUND[0]), endpointKey(FOUND[1]), endpointKey(FOUND[2])])
    expect(groups[0]).toMatchObject({ label: 'MySQL', detail: 'localhost:3306 · 서버 안에서만 열림', isGuess: false })
    expect(groups[0].accounts.map(a => a.id)).toEqual(['s1', 's2'])
    expect(groups[1]).toMatchObject({ isGuess: true, accounts: [] })
    expect(groups[2].isSupported).toBe(false)
  })

  it('works with nothing found', () => {
    expect(buildGroups([], [SAVED])[0].label).toBe('MySQL/MariaDB')
    expect(buildGroups([], [])).toEqual([])
  })

  it('names an account by its label, or user and database', () => {
    expect(accountTitle(SAVED)).toBe('reader/shop')
    expect(accountTitle({ ...SAVED, label: 'MBRIS 조회용' })).toBe('MBRIS 조회용 (reader/shop)')
  })
})

describe('database aliases', () => {
  it('shows the alias as the title and keeps the engine in the detail', () => {
    const aliases = { [endpointKey(FOUND[1])]: 'MBRIS 운영 DB' }
    const groups = buildGroups(FOUND, [], aliases)
    expect(groups[1]).toMatchObject({ label: 'MBRIS 운영 DB', alias: 'MBRIS 운영 DB', detail: 'PostgreSQL · 127.0.0.1:5432' })
    expect(groups[0].label).toBe('MySQL')
    expect(groups[0].alias).toBeUndefined()
  })

  it('finds the alias whatever the loopback spelling of a saved account', () => {
    const aliases = { [endpointKey(FOUND[0])]: '쇼핑몰' }
    expect(buildGroups([], [SAVED], aliases)[0]).toMatchObject({ label: '쇼핑몰', detail: 'MySQL/MariaDB · localhost:3306' })
  })

  it('cleans up what the user typed', () => {
    expect(normalizeAlias('  운영   DB \n')).toBe('운영 DB')
    expect(normalizeAlias('   ')).toBe('')
    expect(normalizeAlias('가'.repeat(80))).toHaveLength(ALIAS_MAX_LENGTH)
  })

  it('sets and clears an alias without changing the given map', () => {
    const key = endpointKey(FOUND[1])
    const before = { other: '다른 DB' }
    const after = withAlias(before, key, ' 운영 DB ')
    expect(after).toEqual({ other: '다른 DB', [key]: '운영 DB' })
    expect(before).toEqual({ other: '다른 DB' })
    expect(withAlias(after, key, '  ')).toEqual({ other: '다른 DB' })
    expect(withAlias(undefined, key, '운영')).toEqual({ [key]: '운영' })
  })
})

describe('saved connections', () => {
  it('replaces the same account and keeps the list unchanged', () => {
    const list = [SAVED]
    const next = upsertSavedConnection(list, { ...SAVED, id: 's2', host: '127.0.0.1', password: 'new' })
    expect(next).toEqual([{ ...SAVED, id: 's2', host: '127.0.0.1', password: 'new' }])
    expect(list).toEqual([SAVED])
    expect(upsertSavedConnection(list, { ...SAVED, id: 's3', user: 'other' }).length).toBe(2)
    // One user for two databases is two accounts
    expect(upsertSavedConnection(list, { ...SAVED, id: 's4', database: 'meta' }).length).toBe(2)
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
