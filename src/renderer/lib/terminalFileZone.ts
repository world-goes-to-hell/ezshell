import { textAfterPrompt } from './commandCapture'

/**
 * The "file zone" of a terminal: the output printed since the shell last changed folder. Relative
 * names in it ("catalina.log") mean files of the folder the tab is in now; names printed before the
 * last `cd` belong to another folder, so they are not looked up as relative names. Rows are buffer
 * rows (0-based, scrollback included).
 */
export interface FileZone {
  start: number
  end: number
}

/**
 * From the row where the folder last changed (null: no folder known) to the row above the cursor
 * (the prompt being typed at is not output). None in a full-screen program or before any output.
 */
export function fileZone({ start, cursorRow, isAlternate }: { start: number | null; cursorRow: number; isAlternate: boolean }): FileZone | null {
  if (start === null || isAlternate) return null
  const end = cursorRow - 1
  return start <= end ? { start, end } : null
}

/** The part of the zone on screen, and whether it goes on above or below it */
export function visiblePart(zone: FileZone, viewportTop: number, rows: number): { top: number; height: number; cutTop: boolean; cutBottom: boolean } | null {
  const bottom = viewportTop + rows - 1
  const top = Math.max(zone.start, viewportTop)
  const last = Math.min(zone.end, bottom)
  if (top > last) return null
  return { top, height: last - top + 1, cutTop: zone.start < viewportTop, cutBottom: zone.end > bottom }
}

/** A name found relative to the terminal's folder (not `/...` or `~...`) */
export function isRelativeName(name: string): boolean {
  return !name.startsWith('/') && !name.startsWith('~')
}


/**
 * Whether the zone's lines hold output, not only prompts: right after `cd` (or Enter on an empty
 * prompt) the zone is the prompt line alone and is not drawn. A prompt is a line with a shell prompt
 * mark (lib/commandCapture).
 */
export function zoneHasOutput(lines: string[]): boolean {
  return lines.some(line => line.trim() !== '' && textAfterPrompt(line) === null)
}

/**
 * Which folder the names a command printed are in: the terminal's folder (`cwd`), the one folder
 * an `ls` was given (`dir`, as typed), or unknown (`none`: several folders, recursive listings,
 * `tree`, chained commands), whose relative names are then not looked up.
 */
export type ListingBase = { kind: 'cwd' } | { kind: 'dir'; dir: string } | { kind: 'none' }

const LS_COMMANDS = new Set(['ls', 'll', 'la', 'l', 'dir', 'vdir', 'lsd', 'exa', 'eza'])
const PREFIX_COMMANDS = new Set(['sudo', 'command', 'nice', 'time', 'env'])
// sudo options followed by a value; any other option (-i, -s, -D: another folder or shell) is unknown
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-p', '-U', '-C', '-h', '-r', '-t', '-T'])
const SUDO_FLAGS = new Set(['-E', '-H', '-n', '-S', '-k', '-b', '-P'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const GLOB = /[*?[]/

/**
 * The command word after `LANG=C`, `sudo -u app`, `env X=1`, `nice`, ...; null when a prefix has an
 * option whose effect is not known here (a login shell or another folder, `nice -n 5`).
 */
function skipPrefixes(words: string[]): string[] | null {
  let rest = words
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1)
    if (rest.length === 0 || !PREFIX_COMMANDS.has(rest[0])) return rest
    const prefix = rest[0]
    rest = rest.slice(1)
    while (rest.length > 0 && rest[0].startsWith('-')) {
      const option = rest[0]
      if (prefix === 'sudo' && SUDO_VALUE_OPTIONS.has(option)) rest = rest.slice(2)
      else if (prefix === 'sudo' && SUDO_FLAGS.has(option)) rest = rest.slice(1)
      else if (option === '--') { rest = rest.slice(1); break }
      else return null
    }
  }
}

/** Shell words of the first pipeline stage; null when the line chains commands (`;`, `&&`, `||`) */
function firstStageWords(command: string): string[] | null {
  const words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; hasWord = true; continue }
    if (ch === '\\' && i + 1 < command.length) { word += command[++i]; hasWord = true; continue }
    if (ch === ';' || (ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) return null
    if (ch === '|') break
    if (/\s/.test(ch)) {
      if (hasWord) words.push(word)
      word = ''
      hasWord = false
      continue
    }
    word += ch
    hasWord = true
  }
  if (hasWord) words.push(word)
  return words
}

const stripSlashes = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

export function listingBase(command: string | null): ListingBase {
  if (!command || !command.trim()) return { kind: 'cwd' }
  const stage = firstStageWords(command)
  const words = stage && skipPrefixes(stage)
  if (!words) return { kind: 'none' }
  const name = words[0]
  if (name === 'tree') return { kind: 'none' }
  if (!name || !LS_COMMANDS.has(name)) return { kind: 'cwd' }
  const args: string[] = []
  let options = true
  for (const word of words.slice(1)) {
    if (options && word === '--') { options = false; continue }
    if (options && word.startsWith('-') && word.length > 1) {
      if (word === '--recursive' || (!word.startsWith('--') && word.includes('R'))) return { kind: 'none' }
      if (word === '--directory' || (!word.startsWith('--') && word.includes('d'))) return { kind: 'cwd' }
      continue
    }
    args.push(word)
  }
  if (args.length === 0) return { kind: 'cwd' }
  if (args.length > 1) return { kind: 'none' }
  const [arg] = args
  if (GLOB.test(arg)) {
    // `*` and `*/` can expand to folders, whose contents ls prints under headers: unknown.
    // `*.log` comes out as the names it matched, in the current folder.
    const last = arg.replace(/\/+$/, '').split('/').pop() ?? ''
    return arg.endsWith('/') || /^[*?]+$/.test(last) ? { kind: 'none' } : { kind: 'cwd' }
  }
  const dir = stripSlashes(arg)
  return dir === '.' || dir === '' ? { kind: 'cwd' } : { kind: 'dir', dir }
}

export interface ZoneCommand {
  /** Buffer row of the command line */
  row: number
  base: ListingBase
  /** The command prints a file list (isListing): only such output gets a border */
  listing?: boolean
}

export interface ZoneBlock extends FileZone {
  base: ListingBase
  listing: boolean
}

/**
 * Whether the command prints a file list (`ls`, `ll`, `la` ..., also through `| grep`): the output
 * a border is drawn around. Names in other output (`cat`, `grep -rn`, a log) can still be looked up,
 * but a border there (`docker ps`) only suggests files that are not there.
 */
export function isListing(command: string | null): boolean {
  if (!command || !command.trim()) return false
  const stage = firstStageWords(command)
  const words = stage && skipPrefixes(stage)
  return Boolean(words && words[0] && LS_COMMANDS.has(words[0]))
}

/** The zone cut at each command line; rows before the first command are the current folder's */
export function zoneBlocks(zone: FileZone, commands: ZoneCommand[]): ZoneBlock[] {
  const inside = commands.filter(c => c.row >= zone.start && c.row <= zone.end).sort((a, b) => a.row - b.row)
  const blocks: ZoneBlock[] = []
  if (inside.length === 0 || inside[0].row > zone.start) {
    blocks.push({ start: zone.start, end: (inside[0]?.row ?? zone.end + 1) - 1, base: { kind: 'cwd' }, listing: false })
  }
  inside.forEach((command, i) => {
    blocks.push({ start: command.row, end: (inside[i + 1]?.row ?? zone.end + 1) - 1, base: command.base, listing: command.listing === true })
  })
  return blocks
}

/**
 * The name to look up for a word on `row`: absolute and home paths as they are; a relative name
 * joined to the folder its command listed (`../test.txt`), as it is on a command line itself, and
 * null outside the zone or under a command whose folder is unknown.
 */
export function lookupName(name: string, row: number, zone: FileZone | null, commands: ZoneCommand[]): string | null {
  if (!isRelativeName(name)) return name
  if (!zone || row < zone.start || row > zone.end) return null
  const command = commands
    .filter(c => c.row >= zone.start && c.row <= row)
    .reduce<ZoneCommand | null>((latest, c) => (!latest || c.row > latest.row ? c : latest), null)
  if (!command || command.row === row || command.base.kind === 'cwd') return name
  if (command.base.kind === 'none') return null
  const dir = stripSlashes(command.base.dir)
  // `ls file.txt` prints the name it was given: that one is in the current folder
  if (name === dir) return name
  return `${dir === '/' ? '' : dir}/${name}`
}
