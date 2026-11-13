import { describe, it, expect } from 'vitest'
import { moveColumn, clampTreeWidth, rangeOf, rangeAsTsv, TREE_DEFAULT_WIDTH } from './dbGrid'
import { lookupQuery } from './sqlStatements'
import { sqlLiteral } from './dbExport'

describe('moveColumn', () => {
  it('moves a column to the place it was dropped on', () => {
    expect(moveColumn([0, 1, 2, 3], 0, 2)).toEqual([1, 2, 0, 3])
    expect(moveColumn([0, 1, 2, 3], 3, 0)).toEqual([3, 0, 1, 2])
    expect(moveColumn([2, 0, 1], 1, 2)).toEqual([2, 1, 0])
  })

  it('leaves the order alone for the same place or a place that does not exist', () => {
    const order = [0, 1, 2]
    expect(moveColumn(order, 1, 1)).toBe(order)
    expect(moveColumn(order, 5, 0)).toBe(order)
    expect(moveColumn(order, 0, -1)).toBe(order)
  })
})

describe('clampTreeWidth', () => {
  it('keeps the width within its limits and leaves room for the query side', () => {
    expect(clampTreeWidth(300)).toBe(300)
    expect(clampTreeWidth(50)).toBe(180)
    expect(clampTreeWidth(2000)).toBe(640)
    expect(clampTreeWidth(600, 800)).toBe(480)
    expect(clampTreeWidth(Number.NaN)).toBe(TREE_DEFAULT_WIDTH)
  })
})

describe('lookupQuery and sqlLiteral', () => {
  it('asks a related table for the rows of one value', () => {
    const target = { schema: 'public', table: 'customers', column: 'id' }
    expect(lookupQuery(target, sqlLiteral(7, { name: 'customer_id', type: '23' }, 'postgres'), 'postgres'))
      .toBe('SELECT * FROM "public"."customers" WHERE "id" = 7 LIMIT 100;')
    expect(lookupQuery({ schema: 'shop', table: 'orders', column: 'code' }, sqlLiteral("a'b\\c", { name: 'code', type: 'varchar' }, 'mysql'), 'mysql'))
      .toBe("SELECT * FROM `shop`.`orders` WHERE `code` = 'a''b\\\\c' LIMIT 100;")
  })

  it('writes values by their kind', () => {
    expect(sqlLiteral('12', { name: 'n', type: '1700' }, 'postgres')).toBe('12')
    expect(sqlLiteral('12', { name: 't', type: '25' }, 'postgres')).toBe("'12'")
    expect(sqlLiteral(true, { name: 'b', type: '16' }, 'postgres')).toBe('TRUE')
    expect(sqlLiteral(null, { name: 'x', type: '25' }, 'postgres')).toBe('NULL')
    expect(sqlLiteral("1; DROP TABLE t; --", { name: 't', type: '25' }, 'postgres')).toBe("'1; DROP TABLE t; --'")
  })
})

describe('rangeOf and rangeAsTsv', () => {
  const rows = [[1, 'a', null], [2, 'b\tc', true], [3, 'line1\nline2', false]]

  it('gives the block whichever way it was dragged', () => {
    expect(rangeOf({ row: 2, place: 1 }, { row: 0, place: 0 })).toEqual({ rowFrom: 0, rowTo: 2, placeFrom: 0, placeTo: 1 })
    expect(rangeOf({ row: 1, place: 1 }, { row: 1, place: 1 })).toEqual({ rowFrom: 1, rowTo: 1, placeFrom: 1, placeTo: 1 })
  })

  it('copies the block as tab-separated lines, NULL empty, one cell per value', () => {
    expect(rangeAsTsv(rows, [0, 1, 2], { rowFrom: 0, rowTo: 2, placeFrom: 0, placeTo: 2 })).toBe('1\ta\t\n2\tb c\ttrue\n3\tline1 line2\tfalse')
    expect(rangeAsTsv(rows, [0, 1, 2], { rowFrom: 1, rowTo: 2, placeFrom: 0, placeTo: 0 })).toBe('2\n3')
  })

  it('follows the order the columns are shown in', () => {
    // Columns moved: the third is shown first
    expect(rangeAsTsv(rows, [2, 0, 1], { rowFrom: 1, rowTo: 1, placeFrom: 0, placeTo: 1 })).toBe('true\t2')
  })
})

describe('SQL Server statements', () => {
  it('quotes with brackets and limits with TOP', async () => {
    const { quoteIdentifier, previewQuery } = await import('./sqlStatements')
    expect(quoteIdentifier('we]ird', 'mssql')).toBe('[we]]ird]')
    expect(previewQuery('dbo', 'orders', 'mssql')).toBe('SELECT TOP 100 * FROM [dbo].[orders];')
    expect(lookupQuery({ schema: 'dbo', table: 'customers', column: 'id' }, '7', 'mssql')).toBe('SELECT TOP 100 * FROM [dbo].[customers] WHERE [id] = 7;')
    expect(sqlLiteral('한글', { name: 'n', type: 'nvarchar' }, 'mssql')).toBe("N'한글'")
    expect(sqlLiteral('abc', { name: 'n', type: 'nvarchar' }, 'mssql')).toBe("'abc'")
  })
})
