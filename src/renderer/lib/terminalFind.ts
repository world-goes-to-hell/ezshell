// "이름 찾기" / "내용 찾기" of the terminal's right-click menu: the find / grep command line that is
// typed into the shell's input line. It is never run by the app: the user reads it and presses Enter.

export type FindKind = 'name' | 'content'
/** Where the search starts: the shell's current folder, the root, or a folder the user types */
export type FindScope = 'current' | 'root' | 'custom'

export interface FindRequest {
  kind: FindKind
  query: string
  scope: FindScope
  customDir?: string
  /** Content search only; name search always ignores case */
  ignoreCase?: boolean
}

export type FindResult = { ok: true; command: string } | { ok: false; problem: string }

export const FIND_QUERY_MAX_LENGTH = 200
const DIR_MAX_LENGTH = 1000
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** Virtual file systems: endless or meaningless to search, and reading them can hang */
const ROOT_SKIPPED = ['proc', 'sys', 'dev']

/** One shell word, whatever the text holds */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function quoteDir(dir: string): string {
  // The shell expands ~ only outside quotes
  if (dir === '~') return '~'
  if (dir.startsWith('~/')) return `~/${shellQuote(dir.slice(2))}`
  // A leading dash would be read as an option
  return shellQuote(dir.startsWith('-') ? `./${dir}` : dir)
}

function startDir(request: FindRequest): { dir: string } | { problem: string } {
  if (request.scope === 'current') return { dir: '.' }
  if (request.scope === 'root') return { dir: '/' }
  const dir = (request.customDir ?? '').trim()
  if (!dir) return { problem: '찾을 폴더를 입력해 주세요.' }
  if (CONTROL_CHARS.test(dir) || dir.length > DIR_MAX_LENGTH) return { problem: '폴더 경로에 줄바꿈이나 제어 문자를 넣을 수 없습니다.' }
  return { dir: quoteDir(dir) }
}

export function buildFindCommand(request: FindRequest): FindResult {
  // A line break would run the first half as soon as it is typed. Checked before trimming, which
  // would silently drop one at either end.
  if (CONTROL_CHARS.test(request.query)) return { ok: false, problem: '줄바꿈이나 제어 문자는 넣을 수 없습니다.' }
  const query = request.kind === 'name' ? request.query.trim() : request.query
  if (!query.trim()) return { ok: false, problem: request.kind === 'name' ? '찾을 이름을 입력해 주세요.' : '찾을 내용을 입력해 주세요.' }
  if (query.length > FIND_QUERY_MAX_LENGTH) return { ok: false, problem: `${FIND_QUERY_MAX_LENGTH}자까지 입력할 수 있습니다.` }
  const start = startDir(request)
  if ('problem' in start) return { ok: false, problem: start.problem }
  const isRoot = request.scope === 'root'

  if (request.kind === 'name') {
    // The user's own wildcards are kept; a plain word matches anywhere in the name
    const pattern = shellQuote(/[*?]/.test(query) ? query : `*${query}*`)
    if (isRoot) {
      const skipped = ROOT_SKIPPED.map(name => `-path /${name}`).join(' -o ')
      return { ok: true, command: `find / \\( ${skipped} \\) -prune -o -iname ${pattern} -print 2>/dev/null` }
    }
    return { ok: true, command: `find ${start.dir} -iname ${pattern} 2>/dev/null` }
  }

  // -F: the text as typed, not a pattern. -I: skip binary files.
  const flags = `-rnIF${request.ignoreCase ? 'i' : ''}`
  const excludes = isRoot ? `${ROOT_SKIPPED.map(name => `--exclude-dir=${name}`).join(' ')} ` : ''
  return { ok: true, command: `grep ${flags} ${excludes}-- ${shellQuote(query)} ${start.dir} 2>/dev/null` }
}

export interface FindPrefs {
  scope: FindScope
  customDir: string
  ignoreCase: boolean
}

export const DEFAULT_FIND_PREFS: FindPrefs = { scope: 'current', customDir: '', ignoreCase: true }

/** Reads what localStorage kept; anything unexpected falls back to the defaults */
export function parseFindPrefs(raw: string | null): FindPrefs {
  if (!raw) return DEFAULT_FIND_PREFS
  try {
    const value = JSON.parse(raw) as Partial<FindPrefs> | null
    if (!value || typeof value !== 'object') return DEFAULT_FIND_PREFS
    return {
      scope: value.scope === 'root' || value.scope === 'custom' ? value.scope : 'current',
      customDir: typeof value.customDir === 'string' ? value.customDir.slice(0, DIR_MAX_LENGTH) : '',
      ignoreCase: value.ignoreCase !== false
    }
  } catch {
    return DEFAULT_FIND_PREFS
  }
}
