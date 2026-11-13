import { describe, it, expect } from 'vitest'
import {
  exportText, xlsxBytes, uniqueNames, columnLetters, tableOfQuery, exportFileName, parseExportPrefs, DEFAULT_EXPORT_PREFS, type ExportOptions
} from './dbExport'
import { crc32, zipStore } from './zipStore'
import type { DbCell, DbColumn } from '../types/db'

// PostgreSQL type numbers: 23 int4, 1700 numeric, 25 text, 16 bool
const COLUMNS: DbColumn[] = [{ name: 'id', type: '23' }, { name: 'name', type: '25' }, { name: 'amount', type: '1700' }, { name: 'paid', type: '16' }]
const ROWS: DbCell[][] = [
  [1, 'kim', '10.50', true],
  [2, 'say "hi", ok', '0', false],
  [3, null, null, null],
  [4, 'two\nlines', '-3.25', true]
]
const OPTIONS: ExportOptions = { includeHeader: true, tableName: 'shop.orders', engine: 'postgres' }

describe('exportText: CSV and TSV', () => {
  it('quotes fields with the separator, quotes or line breaks, and leaves NULL empty', () => {
    expect(exportText('csv', COLUMNS, ROWS, OPTIONS)).toBe([
      'id,name,amount,paid',
      '1,kim,10.50,true',
      '2,"say ""hi"", ok",0,false',
      '3,,,',
      '4,"two\nlines",-3.25,true',
      ''
    ].join('\r\n'))
  })

  it('can leave the header out', () => {
    expect(exportText('csv', COLUMNS, ROWS.slice(0, 1), { ...OPTIONS, includeHeader: false })).toBe('1,kim,10.50,true\r\n')
  })

  it('separates with tabs and quotes a field that has one', () => {
    expect(exportText('tsv', [{ name: 'a', type: '25' }, { name: 'b', type: '25' }], [['x\ty', 'has, comma']], OPTIONS)).toBe('a\tb\r\n"x\ty"\thas, comma\r\n')
  })

  it('is empty for no rows and no header', () => {
    expect(exportText('csv', COLUMNS, [], { ...OPTIONS, includeHeader: false })).toBe('')
  })
})

describe('exportText: SQL', () => {
  it('writes one INSERT per row with quoted names, numbers bare and strings escaped', () => {
    expect(exportText('sql', COLUMNS, [[1, 'it\'s', '10.50', true], [3, null, null, null]], OPTIONS)).toBe([
      'INSERT INTO "shop"."orders" ("id", "name", "amount", "paid") VALUES (1, \'it\'\'s\', 10.50, TRUE);',
      'INSERT INTO "shop"."orders" ("id", "name", "amount", "paid") VALUES (3, NULL, NULL, NULL);',
      ''
    ].join('\n'))
  })

  it('quotes for MySQL and doubles its backslashes', () => {
    const columns: DbColumn[] = [{ name: 'id', type: 'int' }, { name: 'path', type: 'varchar' }]
    expect(exportText('sql', columns, [['7', 'C:\\temp']], { ...OPTIONS, tableName: 'files', engine: 'mysql' }))
      .toBe('INSERT INTO `files` (`id`, `path`) VALUES (7, \'C:\\\\temp\');\n')
  })

  it('keeps text that only looks like a number as text, and uses a stand-in table name', () => {
    expect(exportText('sql', [{ name: 'zip', type: '25' }], [['01234']], { ...OPTIONS, tableName: '' })).toBe('INSERT INTO "table_name" ("zip") VALUES (\'01234\');\n')
  })
})

describe('exportText: JSON and Markdown', () => {
  it('writes an array of objects and keeps null and types', () => {
    expect(JSON.parse(exportText('json', COLUMNS, ROWS.slice(0, 3), OPTIONS))).toEqual([
      { id: 1, name: 'kim', amount: '10.50', paid: true },
      { id: 2, name: 'say "hi", ok', amount: '0', paid: false },
      { id: 3, name: null, amount: null, paid: null }
    ])
  })

  it('numbers repeated column names so no value is lost', () => {
    const columns: DbColumn[] = [{ name: 'id', type: '23' }, { name: 'id', type: '23' }, { name: '', type: '25' }]
    expect(uniqueNames(columns)).toEqual(['id', 'id_2', 'column_3'])
    expect(JSON.parse(exportText('json', columns, [[1, 2, 'x']], OPTIONS))).toEqual([{ id: 1, id_2: 2, column_3: 'x' }])
  })

  it('writes a table and escapes what would break it', () => {
    expect(exportText('markdown', [{ name: 'a', type: '25' }, { name: 'b', type: '25' }], [['x|y', 'l1\nl2'], [null, 1]], OPTIONS))
      .toBe('| a | b |\n| --- | --- |\n| x\\|y | l1<br>l2 |\n|  | 1 |\n')
  })
})

describe('zipStore', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('writes local headers, the directory and the end record', () => {
    const data = new TextEncoder().encode('hello')
    const zip = zipStore([{ name: 'a.txt', data }])
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    // 30 header + 5 name + 5 data, then the directory
    expect(view.getUint32(40, true)).toBe(0x02014b50)
    const end = zip.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(1)
    expect(view.getUint32(end + 16, true)).toBe(40)
    expect(new TextDecoder().decode(zip.slice(35, 40))).toBe('hello')
  })
})

describe('xlsxBytes', () => {
  const sheet = (columns: DbColumn[], rows: DbCell[][]): string => {
    const text = new TextDecoder().decode(xlsxBytes(columns, rows))
    return text.slice(text.indexOf('<worksheet'), text.indexOf('</worksheet>'))
  }

  it('writes numbers as numbers, text as text, booleans as booleans and leaves NULL out', () => {
    const xml = sheet(COLUMNS, ROWS.slice(0, 3))
    expect(xml).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">id</t></is></c>')
    expect(xml).toContain('<c r="A2"><v>1</v></c>')
    expect(xml).toContain('<c r="C2"><v>10.5</v></c>')
    expect(xml).toContain('<c r="D2" t="b"><v>1</v></c>')
    expect(xml).toContain('<c r="B3" t="inlineStr"><is><t xml:space="preserve">say &quot;hi&quot;, ok</t></is></c>')
    expect(xml).toContain('<row r="4"><c r="A4"><v>3</v></c></row>')
  })

  it('keeps a number too long for Excel as text, and drops characters XML cannot hold', () => {
    const xml = sheet([{ name: 'n', type: '1700' }, { name: 't', type: '25' }], [['12345678901234567890', 'a\u0001b<c>&']])
    expect(xml).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">12345678901234567890</t></is></c>')
    expect(xml).toContain('<t xml:space="preserve">ab&lt;c&gt;&amp;</t>')
  })

  it('names columns past Z', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })
})

describe('names and remembered choices', () => {
  it('finds the table of a simple query', () => {
    expect(tableOfQuery('SELECT * FROM "public"."orders" LIMIT 100;')).toBe('public.orders')
    expect(tableOfQuery('select a from `shop`.`items` where x = 1')).toBe('shop.items')
    expect(tableOfQuery('SELECT 1')).toBe('')
  })

  it('names the file after the table and the time', () => {
    expect(exportFileName('public.orders', 'xlsx', new Date(2026, 10, 13, 9, 5, 7))).toBe('orders_20261113-090507.xlsx')
    expect(exportFileName('', 'csv', new Date(2026, 0, 1, 0, 0, 0))).toBe('query_20260101-000000.csv')
  })

  it('reads remembered choices and ignores broken ones', () => {
    expect(parseExportPrefs('{"format":"csv","includeHeader":false}')).toEqual({ format: 'csv', includeHeader: false })
    expect(parseExportPrefs('{"format":"exe"}')).toEqual(DEFAULT_EXPORT_PREFS)
    expect(parseExportPrefs('not json')).toEqual(DEFAULT_EXPORT_PREFS)
    expect(parseExportPrefs(null)).toEqual(DEFAULT_EXPORT_PREFS)
  })
})
