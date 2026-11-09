import { describe, it, expect } from 'vitest'
import { checkReadOnly } from './sqlGuard.js'

describe('checkReadOnly', () => {
  it('lets reading statements through', () => {
    for (const sql of ['SELECT 1', '  select * from t;', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'DESC users']) {
      expect(checkReadOnly(sql, 'mysql')).toEqual({ ok: true })
    }
    expect(checkReadOnly('TABLE users', 'postgres')).toEqual({ ok: true })
  })

  it('refuses statements that change something', () => {
    for (const sql of ['DELETE FROM t', 'update t set a=1', 'DROP TABLE t', 'SET SESSION TRANSACTION READ WRITE', 'KILL 12', 'CALL p()', 'BEGIN']) {
      const result = checkReadOnly(sql, 'mysql')
      expect(result.ok).toBe(false)
    }
    expect(checkReadOnly('SET default_transaction_read_only = off', 'postgres').ok).toBe(false)
    expect(checkReadOnly('DESC users', 'postgres').ok).toBe(false)
  })

  it('looks past leading comments', () => {
    expect(checkReadOnly('-- note\n/* block */ SELECT 1', 'postgres')).toEqual({ ok: true })
    expect(checkReadOnly('# note\nDELETE FROM t', 'mysql').ok).toBe(false)
  })

  it('allows only one statement', () => {
    expect(checkReadOnly('SELECT 1; DELETE FROM t', 'postgres').reason).toContain('하나')
    expect(checkReadOnly('SELECT 1;;  -- end', 'postgres')).toEqual({ ok: true })
  })

  it('does not split on semicolons inside strings, identifiers or dollar quotes', () => {
    expect(checkReadOnly("SELECT 'a;b', \"c;d\" FROM t", 'postgres')).toEqual({ ok: true })
    expect(checkReadOnly('SELECT `a;b` FROM t', 'mysql')).toEqual({ ok: true })
    expect(checkReadOnly("SELECT 'it''s; fine'", 'postgres')).toEqual({ ok: true })
    expect(checkReadOnly("SELECT 'a\\'; DELETE FROM t; '", 'mysql')).toEqual({ ok: true })
    expect(checkReadOnly('SELECT $tag$ ; $tag$', 'postgres')).toEqual({ ok: true })
  })

  it('refuses writing a file on the MySQL server', () => {
    expect(checkReadOnly("SELECT * FROM t INTO OUTFILE '/tmp/x'", 'mysql').ok).toBe(false)
    expect(checkReadOnly("SELECT 'INTO OUTFILE' FROM t", 'mysql')).toEqual({ ok: true })
  })

  it('refuses MySQL executable comments, which the server runs as code', () => {
    expect(checkReadOnly("SELECT * FROM t /*!INTO OUTFILE '/tmp/x'*/", 'mysql').reason).toContain('실행되는 주석')
    expect(checkReadOnly('SELECT 1 /*M!100000 , 2 */', 'mysql').ok).toBe(false)
    expect(checkReadOnly('SELECT /*+ MAX_EXECUTION_TIME(10) */ 1', 'mysql')).toEqual({ ok: true })
    expect(checkReadOnly('SELECT 1 /*! not code in postgres */', 'postgres')).toEqual({ ok: true })
  })

  it('treats MySQL "--" without a space as code, not a comment', () => {
    expect(checkReadOnly("SELECT * FROM t --1 INTO OUTFILE '/tmp/x'", 'mysql').ok).toBe(false)
    expect(checkReadOnly("SELECT 1 -- INTO OUTFILE '/tmp/x'", 'mysql')).toEqual({ ok: true })
  })

  it('refuses functions that act outside the query, however they are written', () => {
    expect(checkReadOnly("SELECT set_config('default_transaction_read_only', 'off', false)", 'postgres').reason).toContain('set_config')
    expect(checkReadOnly("SELECT pg_catalog.set_config('x', 'y', false)", 'postgres').ok).toBe(false)
    expect(checkReadOnly(`SELECT "set_config"('x', 'y', false)`, 'postgres').ok).toBe(false)
    expect(checkReadOnly("SELECT dblink_exec('dbname=shop', 'DELETE FROM t')", 'postgres').ok).toBe(false)
    expect(checkReadOnly('SELECT pg_terminate_backend(123)', 'postgres').ok).toBe(false)
    expect(checkReadOnly('SELECT pg_advisory_lock(1)', 'postgres').ok).toBe(false)
    expect(checkReadOnly("SELECT GET_LOCK('x', 10)", 'mysql').ok).toBe(false)
    expect(checkReadOnly("SELECT `load_file`('/etc/passwd')", 'mysql').ok).toBe(false)
    expect(checkReadOnly("SELECT 'set_config' AS note, current_setting('statement_timeout')", 'postgres')).toEqual({ ok: true })
  })

  it("reads PostgreSQL E'' strings with backslash escapes", () => {
    expect(checkReadOnly("SELECT E'it\\'s; fine'", 'postgres')).toEqual({ ok: true })
    expect(checkReadOnly("SELECT E'a\\'; DELETE FROM t; '", 'postgres')).toEqual({ ok: true })
  })

  it('refuses empty and unclosed text', () => {
    expect(checkReadOnly('  -- only a comment', 'mysql').ok).toBe(false)
    expect(checkReadOnly('', 'mysql').ok).toBe(false)
    expect(checkReadOnly("SELECT 'open", 'mysql').reason).toContain('따옴표')
    expect(checkReadOnly('SELECT 1 /* open', 'postgres').ok).toBe(false)
  })
})
