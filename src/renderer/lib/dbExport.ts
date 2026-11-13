// A query result written out in the formats people hand on: a spreadsheet, CSV / TSV, INSERT
// statements, JSON, a Markdown table. Pure functions; the dialog decides where the text goes.
import type { DbCell, DbColumn } from '../types/db'
import { quoteIdentifier } from './sqlStatements'
import { zipStore } from './zipStore'

export type ExportFormat = 'xlsx' | 'csv' | 'tsv' | 'sql' | 'json' | 'markdown'

export interface ExportFormatInfo {
  format: ExportFormat
  label: string
  /** What it is for, shown under the choice */
  hint: string
  extension: string
  /** A file only (binary): cannot go to the clipboard */
  isBinary: boolean
}

export const EXPORT_FORMATS: ExportFormatInfo[] = [
  { format: 'xlsx', label: 'Excel', hint: '엑셀 파일. 숫자는 숫자로, 첫 줄은 열 이름으로 고정됩니다.', extension: 'xlsx', isBinary: true },
  { format: 'csv', label: 'CSV', hint: '쉼표로 구분한 텍스트. 엑셀에서 한글이 깨지지 않게 저장합니다.', extension: 'csv', isBinary: false },
  { format: 'tsv', label: 'TSV', hint: '탭으로 구분한 텍스트. 복사해서 엑셀·시트에 바로 붙여 넣을 수 있습니다.', extension: 'tsv', isBinary: false },
  { format: 'sql', label: 'SQL INSERT', hint: '다른 DB 에 넣을 수 있는 INSERT 문.', extension: 'sql', isBinary: false },
  { format: 'json', label: 'JSON', hint: '행마다 객체 하나인 배열.', extension: 'json', isBinary: false },
  { format: 'markdown', label: 'Markdown', hint: '문서·메신저에 붙이는 표.', extension: 'md', isBinary: false }
]

export interface ExportOptions {
  /** CSV / TSV: the first line holds the column names */
  includeHeader: boolean
  /** SQL: the table the INSERT statements name */
  tableName: string
  /** SQL: `mysql` or `postgres`, for quoting names and strings */
  engine: string
}

// PostgreSQL sends type numbers (int2, int4, int8, oid, float4, float8, numeric), MySQL type names
// SQL Server (tedious) names: intn / decimaln / numericn / floatn / moneyn are the nullable forms
const NUMERIC_TYPES = new Set(['20', '21', '23', '26', '700', '701', '1700', 'decimal', 'tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'float', 'double', 'year',
  'intn', 'decimaln', 'numeric', 'numericn', 'floatn', 'real', 'money', 'moneyn', 'smallmoney'])
const NUMBER_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

/** A value that is a number: sent as one, or text of a numeric column (the drivers send big and exact numbers as text) */
function isNumeric(cell: DbCell, column: DbColumn): cell is number | string {
  if (typeof cell === 'number') return Number.isFinite(cell)
  return typeof cell === 'string' && NUMERIC_TYPES.has(column.type) && NUMBER_TEXT.test(cell)
}

/** Column names for keys: empty ones get a name, repeated ones a number */
export function uniqueNames(columns: DbColumn[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((column, index) => {
    const base = column.name || `column_${index + 1}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  })
}

function delimited(columns: DbColumn[], rows: DbCell[][], separator: string, includeHeader: boolean): string {
  const needsQuotes = new RegExp(`["\\r\\n${separator === '\t' ? '\\t' : separator}]|^\\s|\\s$`)
  const field = (cell: DbCell | string): string => {
    if (cell === null) return ''
    const text = String(cell)
    return needsQuotes.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = rows.map(row => row.map(field).join(separator))
  if (includeHeader) lines.unshift(columns.map(column => field(column.name)).join(separator))
  // CRLF: what spreadsheet programs expect between records
  return lines.join('\r\n') + (lines.length > 0 ? '\r\n' : '')
}

function sqlString(text: string, engine: string): string {
  // MySQL also reads a backslash as an escape; PostgreSQL (standard strings) does not
  const escaped = engine === 'mysql' ? text.replace(/\\/g, '\\\\') : text
  // SQL Server keeps characters outside its code page only in an N'...' string
  // eslint-disable-next-line no-control-regex
  const prefix = engine === 'mssql' && /[^\x00-\x7f]/.test(text) ? 'N' : ''
  return `${prefix}'${escaped.replace(/'/g, '\'\'')}'`
}

/** A value written as SQL: NULL, TRUE / FALSE, a bare number, or a quoted string */
export function sqlLiteral(cell: DbCell, column: DbColumn, engine: string): string {
  if (cell === null) return 'NULL'
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  if (isNumeric(cell, column)) return String(cell)
  return sqlString(String(cell), engine)
}

function sqlInserts(columns: DbColumn[], rows: DbCell[][], { tableName, engine }: ExportOptions): string {
  // A name with dots is schema.table: each part is quoted on its own
  const table = tableName.split('.').filter(Boolean).map(part => quoteIdentifier(part, engine)).join('.') || quoteIdentifier('table_name', engine)
  const names = uniqueNames(columns).map(name => quoteIdentifier(name, engine)).join(', ')
  return rows.map(row => `INSERT INTO ${table} (${names}) VALUES (${row.map((cell, i) => sqlLiteral(cell, columns[i], engine)).join(', ')});`).join('\n') + (rows.length > 0 ? '\n' : '')
}

function json(columns: DbColumn[], rows: DbCell[][]): string {
  const names = uniqueNames(columns)
  return JSON.stringify(rows.map(row => Object.fromEntries(row.map((cell, i) => [names[i], cell]))), null, 2) + '\n'
}

function markdown(columns: DbColumn[], rows: DbCell[][]): string {
  const cell = (value: DbCell | string): string => (value === null ? '' : String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'))
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
  return [line(columns.map(column => cell(column.name))), line(columns.map(() => '---')), ...rows.map(row => line(row.map(cell)))].join('\n') + '\n'
}

/** The result as text in one of the text formats */
export function exportText(format: Exclude<ExportFormat, 'xlsx'>, columns: DbColumn[], rows: DbCell[][], options: ExportOptions): string {
  switch (format) {
    case 'csv': return delimited(columns, rows, ',', options.includeHeader)
    case 'tsv': return delimited(columns, rows, '\t', options.includeHeader)
    case 'sql': return sqlInserts(columns, rows, options)
    case 'json': return json(columns, rows)
    case 'markdown': return markdown(columns, rows)
  }
}

// ---- Excel ----

/** Text for XML: the five characters escaped, and the control characters XML 1.0 forbids removed */
function xml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** A, B, …, Z, AA, AB, … */
export function columnLetters(index: number): string {
  let letters = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  return letters
}

// Excel keeps 15 significant digits: a longer number stays text so no digit is lost
const MAX_NUMBER_DIGITS = 15
const MAX_CELL_CHARS = 32767

function sheetXml(columns: DbColumn[], rows: DbCell[][]): string {
  const textCell = (ref: string, text: string, style = ''): string =>
    `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(text.slice(0, MAX_CELL_CHARS))}</t></is></c>`
  const cell = (value: DbCell, column: DbColumn, ref: string): string => {
    if (value === null) return ''
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
    if (isNumeric(value, column) && String(value).replace(/[^\d]/g, '').length <= MAX_NUMBER_DIGITS) return `<c r="${ref}"><v>${Number(value)}</v></c>`
    return textCell(ref, String(value))
  }
  // Width from the header and the first rows, like the grid on screen
  const widths = columns.map((column, i) => {
    let longest = column.name.length
    for (let r = 0; r < Math.min(rows.length, 100); r++) longest = Math.max(longest, rows[r][i] === null ? 0 : String(rows[r][i]).length)
    return Math.min(60, Math.max(8, longest + 2))
  })
  const header = `<row r="1">${columns.map((column, i) => textCell(`${columnLetters(i)}1`, column.name, ' s="1"')).join('')}</row>`
  const body = rows.map((row, r) => `<row r="${r + 2}">${row.map((value, i) => cell(value, columns[i], `${columnLetters(i)}${r + 2}`)).join('')}</row>`).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    // The header row stays in view while scrolling
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${header}${body}</sheetData>`
    + '</worksheet>'
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>'
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>'
const WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + '<sheets><sheet name="결과" sheetId="1" r:id="rId1"/></sheets>'
  + '</workbook>'
const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>'
// Style 0: plain. Style 1: bold, for the header row.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>'

/** The result as the bytes of an .xlsx file: one sheet, the column names in a bold first row */
export function xlsxBytes(columns: DbColumn[], rows: DbCell[][]): Uint8Array {
  const encoder = new TextEncoder()
  return zipStore([
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: encoder.encode(WORKBOOK) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml(columns, rows)) }
  ])
}

// ---- Names ----

/** The table a simple query reads ("FROM shop.orders"), for the INSERT statements and the file name */
export function tableOfQuery(sql: string): string {
  const match = /\bfrom\s+((?:[`"]?[\w$]+[`"]?\s*\.\s*)?[`"]?[\w$]+[`"]?)/i.exec(sql)
  return match ? match[1].replace(/[`"\s]/g, '') : ''
}

/** File name for the export: the table (or "query") and the time */
export function exportFileName(table: string, extension: string, now: Date): string {
  const base = (table.split('.').pop() || 'query').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'query'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${base}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${extension}`
}

export interface ExportPrefs {
  format: ExportFormat
  includeHeader: boolean
}

export const DEFAULT_EXPORT_PREFS: ExportPrefs = { format: 'xlsx', includeHeader: true }

/** The choices remembered on this PC; anything unexpected falls back to the default */
export function parseExportPrefs(raw: string | null): ExportPrefs {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object') return DEFAULT_EXPORT_PREFS
    const { format, includeHeader } = value as Record<string, unknown>
    return {
      format: EXPORT_FORMATS.some(info => info.format === format) ? (format as ExportFormat) : DEFAULT_EXPORT_PREFS.format,
      includeHeader: typeof includeHeader === 'boolean' ? includeHeader : DEFAULT_EXPORT_PREFS.includeHeader
    }
  } catch {
    return DEFAULT_EXPORT_PREFS
  }
}
