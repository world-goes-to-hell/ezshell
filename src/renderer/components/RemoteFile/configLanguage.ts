// Colours for configuration files the bundled languages do not know: .env, .conf, systemd units,
// hosts, crontab. Line by line: a comment, a [section], or a key and its value. The point is that
// commented-out lines look like comments and the settings in use stand out.
import { StreamLanguage, type StreamParser } from '@codemirror/language'

interface ConfigState {
  /** Where in the line the next token is: before the key, right after it, or in the value */
  position: 'start' | 'afterKey' | 'value'
  /** Whether the next token follows the line start or a space (a `#` there starts a comment) */
  isSpaced: boolean
}

const KEYWORDS = /^(?:export|declare|setenv|set|unset|local)(?=\s)/
// KEY=value, key: value, key.sub = value
const KEY_BEFORE_SIGN = /^[A-Za-z_][\w.\-/]*(?=\s*[=:])/
// A directive and its arguments: "Port 22", "server_name example.com;"
const KEY_BEFORE_SPACE = /^[A-Za-z_][\w.\-]*(?=\s|$)/
const NUMBER = /^-?\d+(?:\.\d+)?(?![\w.:\-/])/
const ATOM = /^(?:true|false|yes|no|on|off|null|none)(?![\w.\-/])/i
const VARIABLE = /^\$(?:\{[^}\n]*\}|[A-Za-z_]\w*)/

export const configParser: StreamParser<ConfigState> = {
  name: 'config',
  startState: () => ({ position: 'start', isSpaced: true }),
  token(stream, state) {
    if (stream.sol()) {
      state.position = 'start'
      state.isSpaced = true
    }
    if (stream.eatSpace()) {
      state.isSpaced = true
      return null
    }
    const wasSpaced = state.isSpaced
    state.isSpaced = false
    const ch = stream.peek()

    // "#" after the line start or a space; ";" and "//" only at the line start (they occur in values)
    if ((ch === '#' && wasSpaced) || (state.position === 'start' && (ch === ';' || stream.match('//', false)))) {
      stream.skipToEnd()
      return 'comment'
    }

    if (state.position === 'start') {
      if (ch === '[' && stream.match(/^\[[^\]\n]*\]/)) return 'heading'
      if (stream.match(KEYWORDS)) return 'keyword'
      if (stream.match(KEY_BEFORE_SIGN)) {
        state.position = 'afterKey'
        return 'propertyName'
      }
      state.position = 'value'
      if (stream.match(KEY_BEFORE_SPACE)) return 'propertyName'
    }

    if (state.position === 'afterKey') {
      state.position = 'value'
      if (stream.eat('=') || stream.eat(':')) return 'operator'
    }

    if (ch === '"' || ch === '\'') {
      stream.next()
      let isEscaped = false
      for (let next = stream.next(); next !== undefined; next = stream.next()) {
        if (next === ch && !isEscaped) break
        isEscaped = !isEscaped && next === '\\'
      }
      return 'string'
    }
    if (stream.match(VARIABLE)) return 'typeName'
    if (stream.match(NUMBER)) return 'number'
    if (stream.match(ATOM)) return 'atom'
    // Plain text of a value, up to something that may start another kind of token
    if (!stream.match(/^[^\s"'$]+/)) stream.next()
    return null
  },
  languageData: { commentTokens: { line: '#' } }
}

export const configLanguage = StreamLanguage.define(configParser)

const CONFIG_EXTENSIONS = new Set(['env', 'conf', 'cfg', 'cnf', 'service', 'timer', 'socket', 'mount', 'target', 'path', 'repo', 'list', 'desktop', 'rules', 'cf'])
const CONFIG_NAMES = new Set(['hosts', 'fstab', 'crontab', 'sshd_config', 'ssh_config', 'sudoers', 'environment', 'exports', 'profile'])
const SHELL_NAMES = new Set(['.bashrc', '.bash_profile', '.bash_aliases', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', 'bashrc'])

/** Which of our own choices fits a file name the bundled list has no language for */
export function fallbackLanguage(fileName: string): 'config' | 'shell' | null {
  const name = fileName.toLowerCase()
  if (SHELL_NAMES.has(name)) return 'shell'
  // .env, .env.local, prod.env
  if (/^\.?env(?:\.[\w-]+)*$/.test(name) || CONFIG_NAMES.has(name)) return 'config'
  const dot = name.lastIndexOf('.')
  return dot >= 0 && CONFIG_EXTENSIONS.has(name.slice(dot + 1)) ? 'config' : null
}

const BACKUP_PART = /^(?:\d+|bak\d*|backup|bkp|old|orig|org|ori|save|prev|copy|백업|원본)$/i

/**
 * The names to look a language up by: the name itself, then the name without its backup marks
 * ("compose.yaml.bak_20261020" is YAML too).
 */
export function namesWithoutBackupMarks(fileName: string): string[] {
  const names = [fileName]
  let name = fileName.replace(/~$/, '')
  if (name !== fileName) names.push(name)
  for (let i = 0; i < 4; i++) {
    const match = /^(.+)[._\-]([^._\-]+)$/.exec(name)
    if (!match || !BACKUP_PART.test(match[2])) break
    name = match[1]
    names.push(name)
  }
  return names
}
