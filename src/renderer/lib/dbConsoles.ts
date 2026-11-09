// Query consoles of a DB tab: several editors, each with its own result, sharing the tab's connection.
// The SQL written in them is kept per account on this PC (localStorage); results never are.

export interface ConsoleDraft {
  id: string
  name: string
  sql: string
}

export const MAX_CONSOLES = 10
/** Longer text is not kept (the console still holds it while the tab is open) */
const MAX_SAVED_SQL_CHARS = 200_000

export const DEFAULT_SQL = '-- Ctrl+Enter: 커서가 있는 문장(또는 선택한 부분)을 실행합니다. Ctrl+Space: 자동완성. 조회만 할 수 있습니다.\n'

const newId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(16).slice(2)}`)

/** "콘솔 N" with the smallest N not taken */
export function nextConsoleName(consoles: ConsoleDraft[]): string {
  const taken = new Set(consoles.map(c => c.name))
  let n = 1
  while (taken.has(`콘솔 ${n}`)) n++
  return `콘솔 ${n}`
}

export function addConsole(consoles: ConsoleDraft[], sql = DEFAULT_SQL): ConsoleDraft[] {
  if (consoles.length >= MAX_CONSOLES) return consoles
  return [...consoles, { id: newId(), name: nextConsoleName(consoles), sql }]
}

/** Closing the last console leaves a fresh one: a DB tab always has somewhere to type */
export function removeConsole(consoles: ConsoleDraft[], id: string): ConsoleDraft[] {
  const rest = consoles.filter(c => c.id !== id)
  return rest.length > 0 ? rest : addConsole([])
}

export function renameConsole(consoles: ConsoleDraft[], id: string, name: string): ConsoleDraft[] {
  const clean = name.trim().slice(0, 40)
  if (!clean) return consoles
  return consoles.map(c => (c.id === id ? { ...c, name: clean } : c))
}

export function withSql(consoles: ConsoleDraft[], id: string, sql: string): ConsoleDraft[] {
  return consoles.map(c => (c.id === id ? { ...c, sql } : c))
}

/** The neighbour to show after closing `id` */
export function neighbourOf(consoles: ConsoleDraft[], id: string): string | null {
  const index = consoles.findIndex(c => c.id === id)
  if (index < 0) return null
  return consoles[index + 1]?.id ?? consoles[index - 1]?.id ?? null
}

export function serializeConsoles(consoles: ConsoleDraft[]): string {
  return JSON.stringify(consoles.slice(0, MAX_CONSOLES).map(c => ({
    id: c.id,
    name: c.name,
    sql: c.sql.length > MAX_SAVED_SQL_CHARS ? c.sql.slice(0, MAX_SAVED_SQL_CHARS) : c.sql
  })))
}

/** What was stored, or one fresh console when nothing usable is there */
export function parseConsoles(raw: string | null): ConsoleDraft[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(value)) return addConsole([])
    const consoles = value
      .filter((c): c is ConsoleDraft => typeof c === 'object' && c !== null
        && typeof (c as ConsoleDraft).id === 'string' && typeof (c as ConsoleDraft).name === 'string' && typeof (c as ConsoleDraft).sql === 'string')
      .slice(0, MAX_CONSOLES)
      .map(c => ({ id: c.id, name: c.name.slice(0, 40) || '콘솔', sql: c.sql }))
    return consoles.length > 0 ? consoles : addConsole([])
  } catch {
    return addConsole([])
  }
}
