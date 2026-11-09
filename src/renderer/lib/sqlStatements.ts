// Which statement Ctrl+Enter runs: the selection, or the statement the cursor is in (statements end
// with ; outside strings and comments). main checks again that it is one reading statement.

export interface StatementRange {
  from: number
  to: number
  text: string
}

/** Ranges between semicolons that are not inside quotes or comments (trimmed, empty ones dropped) */
export function splitStatements(sql: string): StatementRange[] {
  const ranges: StatementRange[] = []
  let start = 0
  let i = 0
  const push = (end: number): void => {
    const raw = sql.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && !/^(--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(text)) {
      ranges.push({ from: start + lead, to: start + lead + text.length, text })
    }
  }
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if ((c === '-' && next === '-') || c === '#') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\' && c === "'") j += 2
        else if (sql[j] === c && sql[j + 1] === c) j += 2
        else if (sql[j] === c) break
        else j++
      }
      i = j + 1
    } else if (c === '$' && /^\$[A-Za-z_]?\w*\$/.test(sql.slice(i, i + 64))) {
      const tag = (sql.slice(i, i + 64).match(/^\$[A-Za-z_]?\w*\$/) as RegExpMatchArray)[0]
      const end = sql.indexOf(tag, i + tag.length)
      i = end < 0 ? sql.length : end + tag.length
    } else if (c === ';') {
      push(i)
      start = i + 1
      i++
    } else {
      i++
    }
  }
  push(sql.length)
  return ranges
}

/**
 * The statement to run for a cursor at `pos`: the one containing it, else the nearest one before it
 * (the cursor is usually just after the `;`), else the first one after it.
 */
export function statementAt(sql: string, pos: number): StatementRange | null {
  const ranges = splitStatements(sql)
  if (ranges.length === 0) return null
  const inside = ranges.find(r => pos >= r.from && pos <= r.to + 1)
  if (inside) return inside
  const before = [...ranges].reverse().find(r => r.to < pos)
  return before ?? ranges[0]
}

/** An identifier quoted for the engine (`a`.`b` or "a"."b") */
export function quoteIdentifier(name: string, engine: string): string {
  return engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`
}

export function previewQuery(schema: string, table: string, engine: string, limit = 100): string {
  return `SELECT * FROM ${quoteIdentifier(schema, engine)}.${quoteIdentifier(table, engine)} LIMIT ${limit};`
}
