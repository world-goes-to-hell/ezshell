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

describe('checkReadOnly: SQL Server', () => {
  const ok = (sql) => checkReadOnly(sql, 'mssql').ok

  it('lets one reading statement through', () => {
    for (const sql of ['SELECT TOP 10 * FROM [dbo].[orders]', 'WITH x AS (SELECT 1 a) SELECT * FROM x', 'select 1 -- DROP TABLE t', "SELECT 'DELETE INTO' AS x", 'SELECT [delete], "update" FROM dbo.t', 'SELECT a]] FROM [we]]ird]']) {
      expect(ok(sql), sql).toBe(true)
    }
  })

  it('refuses writing words anywhere: statements need no semicolon there', () => {
    for (const sql of [
      'DELETE FROM dbo.orders', 'UPDATE dbo.orders SET amount = 0', 'SELECT * INTO dbo.copy FROM dbo.orders',
      'WITH x AS (SELECT 1 a) DELETE FROM dbo.orders', 'SELECT 1 DELETE FROM dbo.orders', 'SELECT 1 EXEC sp_who',
      'SELECT 1 COMMIT DELETE FROM t', 'USE master', 'SELECT 1; DROP TABLE dbo.orders', "SELECT * FROM OPENROWSET('a', 'b', 'c')",
      'SELECT 1 WAITFOR DELAY \'00:10:00\'', 'EXEC xp_cmdshell \'dir\'', 'SELECT dbo.xp_something()'
    ]) {
      expect(ok(sql), sql).toBe(false)
    }
  })

  it('says which word was refused and how to use it as a name', () => {
    expect(checkReadOnly('SELECT 1 DELETE FROM t', 'mssql').reason).toContain('DELETE')
    expect(checkReadOnly('SELECT 1 DELETE FROM t', 'mssql').reason).toContain('[delete]')
  })

  it('refuses an unclosed bracket name', () => {
    expect(checkReadOnly('SELECT * FROM [orders', 'mssql')).toEqual({ ok: false, reason: expect.stringContaining('닫히지 않은') })
  })
})
