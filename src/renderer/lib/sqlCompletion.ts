// Reading the query text for completion: what is being typed at the cursor, and which tables the
// statement names (with their aliases), so column names are offered only for those tables.

export type CompletionSpot =
  | { kind: 'qualified'; qualifier: string; prefix: string }
  | { kind: 'plain'; prefix: string }

export interface TableReference {
  schema: string | null
  table: string
  alias: string | null
}

const IDENT = '(?:[A-Za-z_][\\w$]*|`[^`]+`|"[^"]+")'

// Words that can follow a table name but are not its alias
const NOT_ALIAS = new Set([
  'WHERE', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'GROUP',
  'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FOR', 'AS', 'SET', 'LATERAL'
])

/** `a`, `` `a b` `` or `"a b"` → the name without quotes */
export function unquote(identifier: string): string {
  const first = identifier[0]
  if ((first === '`' || first === '"') && identifier.endsWith(first) && identifier.length >= 2) {
    return identifier.slice(1, -1).split(first + first).join(first)
  }
  return identifier
}

/** What the user is typing, from the text before the cursor */
export function completionSpot(before: string): CompletionSpot {
  const qualified = before.match(new RegExp(`(${IDENT})\\.([\\w$]*)$`))
  if (qualified) return { kind: 'qualified', qualifier: unquote(qualified[1]), prefix: qualified[2] }
  const plain = before.match(/[\w$]*$/)
  return { kind: 'plain', prefix: plain ? plain[0] : '' }
}

/** Tables after FROM / JOIN (and UPDATE-like words never reach here: only reading statements run) */
export function referencedTables(statement: string): TableReference[] {
  const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?(?:\\s+(?:AS\\s+)?(${IDENT}))?`, 'gi')
  const found: TableReference[] = []
  for (const match of statement.matchAll(pattern)) {
    const [, first, second, aliasRaw] = match
    const schema = second ? unquote(first) : null
    const table = unquote(second ?? first)
    const alias = aliasRaw && !NOT_ALIAS.has(aliasRaw.toUpperCase()) ? unquote(aliasRaw) : null
    if (/^\(/.test(table)) continue
    found.push({ schema, table, alias })
  }
  return found
}

/** The table a qualifier names, by alias first, then by table name (case-insensitive) */
export function resolveQualifier(qualifier: string, tables: TableReference[]): TableReference | null {
  const lower = qualifier.toLowerCase()
  return tables.find(t => t.alias?.toLowerCase() === lower)
    ?? tables.find(t => t.table.toLowerCase() === lower)
    ?? null
}

/** The name as it must be typed: quoted when it would not be read back the same way */
export function identifierText(name: string, engine: string): string {
  if (engine === 'mysql') return /^[A-Za-z_][\w$]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``
  if (engine === 'mssql') return /^[A-Za-z_][\w$#@]*$/.test(name) ? name : `[${name.replace(/]/g, ']]')}]`
  // PostgreSQL folds bare names to lower case
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}
