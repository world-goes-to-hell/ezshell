// The file or folder name under the pointer in terminal output (an `ls` listing, a path in a log line),
// so the terminal's right-click menu can offer what the SFTP list offers for it.

/** One column of a terminal line: its text ('' for the second half of a wide character) */
export interface TerminalCell {
  text: string
  width: number
}

const MAX_NAME_LENGTH = 512
// What `ls -F` puts after a name, and punctuation that ends a name in a sentence or a "file:line" pair
const TRAILING_MARKS = /[*@|=:,;]+$/
const WRAPPERS: Array<[string, string]> = [['\'', '\''], ['"', '"'], ['`', '`'], ['(', ')'], ['[', ']'], ['<', '>']]

function isBlank(cell: TerminalCell | undefined): boolean {
  if (!cell) return true
  // An empty cell of width 0 is the second half of a wide character, part of the word
  if (cell.text === '') return cell.width !== 0
  return /\s/.test(cell.text)
}

/** The run of non-blank characters that covers `column`, or '' on empty space */
export function wordAtColumn(cells: TerminalCell[], column: number): string {
  if (column < 0 || column >= cells.length || isBlank(cells[column])) return ''
  let start = column
  let end = column
  while (start > 0 && !isBlank(cells[start - 1])) start--
  while (end < cells.length - 1 && !isBlank(cells[end + 1])) end++
  return cells.slice(start, end + 1).map(cell => cell.text).join('')
}

/** A run of non-blank characters and the columns it covers (both inclusive) */
export interface ScreenWord {
  text: string
  start: number
  end: number
}

/** Every word of a line, with its columns */
export function wordsInCells(cells: TerminalCell[]): ScreenWord[] {
  const words: ScreenWord[] = []
  let start = -1
  for (let column = 0; column <= cells.length; column++) {
    const blank = column === cells.length || isBlank(cells[column])
    if (!blank && start < 0) start = column
    if (blank && start >= 0) {
      words.push({ text: cells.slice(start, column).map(cell => cell.text).join(''), start, end: column - 1 })
      start = -1
    }
  }
  return words
}

const MONTHS = new Set(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])

/**
 * Whether a word of a listing is worth asking the server about: not the permissions, sizes, dates
 * and arrows that `ls -l` prints around the names.
 */
export function looksLikeName(name: string): boolean {
  if (/^[-dlbcps][-rwxsStT]{9}[.+@]?$/.test(name)) return false
  if (/^\d+(?:[.,:\-/]\d+)*[KMGTP]?i?B?$/i.test(name)) return false
  if (MONTHS.has(name.toLowerCase())) return false
  return true
}

/**
 * A word from the screen as a name: without quotes or brackets around it and without the marks
 * `ls -F` and sentences put after it. Null when nothing that could be a name is left.
 */
export function cleanName(word: string): string | null {
  let name = word.trim()
  for (let changed = true; changed;) {
    changed = false
    for (const [open, close] of WRAPPERS) {
      if (name.length >= 2 && name.startsWith(open) && name.endsWith(close)) {
        name = name.slice(1, -1)
        changed = true
      }
    }
    const trimmed = name.replace(TRAILING_MARKS, '')
    if (trimmed !== name) {
      name = trimmed
      changed = true
    }
  }
  // A folder's trailing slash is not part of its name
  name = name.replace(/\/+$/, '')
  if (!name || name.length > MAX_NAME_LENGTH || name === '.' || name === '..') return null
  // Control characters never belong to a name we would act on; a word of only punctuation is not one
  if (/[\u0000-\u001f\u007f]/.test(name) || !/[\p{L}\p{N}]/u.test(name)) return null
  return name
}

/** Joins a folder and a name, resolving `.` and `..` parts; null when it would climb above `/` */
function joinPath(folder: string, name: string): string | null {
  const parts: string[] = []
  for (const part of `${folder}/${name}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return `/${parts.join('/')}`
}

/**
 * The absolute path a name on the screen stands for. `cwd` is the folder the terminal is in as its
 * prompt shows it (may start with `~`), `home` the login folder. Null when it cannot be known
 * (a relative name without a known folder, `~` without a known home).
 */
export function resolveName(name: string, cwd: string | undefined, home: string | null): string | null {
  const expand = (path: string): string | null => {
    if (path.startsWith('/')) return path
    if (path === '~' || path.startsWith('~/')) return home && home.startsWith('/') ? `${home}/${path.slice(1)}` : null
    return null
  }
  const absolute = expand(name)
  if (absolute) return joinPath('', absolute)
  if (name.startsWith('~')) return null
  const folder = cwd ? expand(cwd.trim()) : null
  return folder ? joinPath(folder, name) : null
}

/** Whether resolving `name` needs the login folder (so the caller asks the server for it only then) */
export function needsHome(name: string, cwd: string | undefined): boolean {
  if (name.startsWith('/')) return false
  return name.startsWith('~') || Boolean(cwd?.trim().startsWith('~'))
}

export function splitPath(path: string): { folder: string; name: string } {
  const at = path.lastIndexOf('/')
  return { folder: at <= 0 ? '/' : path.slice(0, at), name: path.slice(at + 1) }
}
