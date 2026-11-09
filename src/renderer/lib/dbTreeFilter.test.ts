import { describe, it, expect } from 'vitest'
import {
  EMPTY_FILTER, isDatabaseShown, isSchemaShown, withDatabase, withSchema, withAllDatabases, shownCount, parseFilter, filterStorageKey
} from './dbTreeFilter'

const DBS = [{ name: 'mbris_2023', isSystem: false }, { name: 'mysql', isSystem: true }]
const SCHEMAS = [
  { name: 'public', isSystem: false },
  { name: 'en_2023', isSystem: false },
  { name: 'pg_catalog', isSystem: true },
  { name: 'information_schema', isSystem: true }
]

describe('dbTreeFilter', () => {
  it('shows everything but system databases and schemas by default', () => {
    expect(isDatabaseShown(EMPTY_FILTER, DBS[0])).toBe(true)
    expect(isDatabaseShown(EMPTY_FILTER, DBS[1])).toBe(false)
    expect(shownCount(EMPTY_FILTER, 'mbris_2023', SCHEMAS)).toBe('2/4')
  })

  it('keeps the user choices without changing the old filter', () => {
    const shown = withSchema(withDatabase(EMPTY_FILTER, 'mysql', true), 'mbris_2023', 'pg_catalog', true)
    const hidden = withSchema(shown, 'mbris_2023', 'en_2023', false)
    expect(isDatabaseShown(hidden, DBS[1])).toBe(true)
    expect(isSchemaShown(hidden, 'mbris_2023', SCHEMAS[2])).toBe(true)
    expect(isSchemaShown(hidden, 'mbris_2023', SCHEMAS[1])).toBe(false)
    expect(shownCount(hidden, 'mbris_2023', SCHEMAS)).toBe('2/4')
    expect(EMPTY_FILTER).toEqual({ databases: {}, schemas: {} })
    // The same schema name in another database follows its own default
    expect(isSchemaShown(hidden, 'other', SCHEMAS[1])).toBe(true)
  })

  it('shows or hides every database at once', () => {
    const none = withAllDatabases(EMPTY_FILTER, DBS, false)
    expect(DBS.some(d => isDatabaseShown(none, d))).toBe(false)
    const all = withAllDatabases(none, DBS, true)
    expect(DBS.every(d => isDatabaseShown(all, d))).toBe(true)
  })

  it('reads only usable stored values', () => {
    expect(parseFilter(null)).toEqual(EMPTY_FILTER)
    expect(parseFilter('not json')).toEqual(EMPTY_FILTER)
    expect(parseFilter('{"databases":{"a":true},"schemas":{"b":"yes"}}')).toEqual({ databases: { a: true }, schemas: {} })
    expect(filterStorageKey({ engine: 'postgres', endpoint: { host: '127.0.0.1', port: 5432 }, user: 'admin' })).toBe('dbTreeFilter:postgres:127.0.0.1:5432:admin')
  })
})
