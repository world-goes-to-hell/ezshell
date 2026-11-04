// Display-only layout of a shell command for the MCP activity view. AI agents send long one-liners
// joined with ; && || |; this breaks them into lines and names the parts for colouring.
// Nothing but line breaks and indentation is added, and each line ends with its operator, so the
// formatted text still runs the same when copied into bash. Anything it cannot read safely (a heredoc,
// an unclosed quote) is left exactly as it was.

export type ShellTokenKind = 'command' | 'option' | 'string' | 'variable' | 'operator' | 'redirect' | 'comment' | 'text' | 'space'

export interface ShellToken {
  kind: ShellTokenKind
  text: string
}

export interface ShellLine {
  /** Indent level; each level is two spaces */
  indent: number
  tokens: ShellToken[]
}

const INDENT = '  '
/** Operators after which the next command goes on an indented line (it continues this one) */
const CONTINUING = new Set(['|', '|&', '&&', '||'])
const LIST_ENDS = new Set([';', ';;', '&'])
const WORD_END = /[\s'"`$;&|()<>]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/
const SPECIAL_PARAMETER = /^[0-9@*#?$!-]/

class Unreadable extends Error {}

/** Index just past the quote that closes the one at `start` (single quotes take no escapes) */
function closingQuote(command: string, start: number): number {
  const quote = command[start]
  for (let index = start + 1; index < command.length; index += 1) {
    if (quote !== "'" && command[index] === '\\') { index += 1; continue }
    if (command[index] === quote) return index + 1
  }
  throw new Unreadable()
}

/** Index just past the ) that closes the ( at `start`, skipping quoted text inside */
function closingParen(command: string, start: number): number {
  let depth = 0
  for (let index = start; index < command.length; index += 1) {
    const char = command[index]
    if (char === '\\') { index += 1; continue }
    if (char === "'" || char === '"' || char === '`') { index = closingQuote(command, index) - 1; continue }
    if (char === '(') depth += 1
    if (char === ')' && --depth === 0) return index + 1
  }
  throw new Unreadable()
}

/** Index just past a $ expansion starting at `start`, or start + 1 for a lone $ */
function expansionEnd(command: string, start: number): number {
  const rest = command.slice(start + 1)
  if (rest.startsWith('(')) return closingParen(command, start + 1)
  if (rest.startsWith('{')) {
    const close = command.indexOf('}', start)
    if (close < 0) throw new Unreadable()
    return close + 1
  }
  if (rest.startsWith("'")) return closingQuote(command, start + 1)
  const name = NAME.exec(rest)
  if (name) return start + 1 + name[0].length
  if (SPECIAL_PARAMETER.test(rest)) return start + 2
  return start + 1
}

function tokenize(command: string): ShellLine[] {
  const lines: ShellLine[] = [{ indent: 0, tokens: [] }]
  let line = lines[0]
  let expectCommand = true
  let groupDepth = 0
  let index = 0

  const push = (kind: ShellTokenKind, text: string) => {
    if (kind === 'space' && line.tokens.length === 0) return
    line.tokens.push({ kind, text })
    if (kind !== 'space' && kind !== 'comment') expectCommand = false
  }
  const trimEnd = () => {
    while (line.tokens.length > 0 && line.tokens[line.tokens.length - 1].kind === 'space') line.tokens.pop()
  }
  const newLine = (indent: number) => {
    trimEnd()
    line = { indent, tokens: [] }
    lines.push(line)
    expectCommand = true
  }
  const operator = (text: string) => {
    push('operator', text)
    expectCommand = true
    if (groupDepth > 0) return
    if (CONTINUING.has(text)) newLine(1)
    else if (LIST_ENDS.has(text)) newLine(0)
  }

  while (index < command.length) {
    const char = command[index]
    const two = command.slice(index, index + 2)

    if (char === '\n') {
      if (groupDepth > 0) push('space', char)
      else newLine(0)
      index += 1
    } else if (/\s/.test(char)) {
      // A run of blanks (not newlines, handled above)
      const end = index + (/^[^\S\n]+/.exec(command.slice(index))?.[0].length ?? 1)
      push('space', command.slice(index, end))
      index = end
    } else if (char === '#' && (index === 0 || /\s/.test(command[index - 1]))) {
      const end = command.indexOf('\n', index)
      const stop = end < 0 ? command.length : end
      line.tokens.push({ kind: 'comment', text: command.slice(index, stop) })
      index = stop
    } else if (char === "'" || char === '"') {
      const end = closingQuote(command, index)
      push('string', command.slice(index, end))
      index = end
    } else if (char === '`') {
      const end = closingQuote(command, index)
      push('variable', command.slice(index, end))
      index = end
    } else if (char === '$') {
      const end = expansionEnd(command, index)
      push(end === index + 1 ? 'text' : 'variable', command.slice(index, end))
      index = end
    } else if (two === '<<' && command[index + 2] !== '<') {
      // A heredoc body is not shell syntax; splitting it would change the text the program receives
      throw new Unreadable()
    } else if (char === '<' || char === '>') {
      let end = index + 1
      while (command[end] === '<' || command[end] === '>') end += 1
      if (command[end] === '&') {
        end += 1
        while (end < command.length && /[0-9-]/.test(command[end])) end += 1
      }
      // A file descriptor written right before the redirect belongs to it (2>&1)
      const last = line.tokens[line.tokens.length - 1]
      if (last && last.kind === 'text' && /^\d+$/.test(last.text)) {
        line.tokens.pop()
        push('redirect', last.text + command.slice(index, end))
      } else {
        push('redirect', command.slice(index, end))
      }
      index = end
    } else if (two === '&&' || two === '||' || two === '|&' || two === ';;') {
      operator(two)
      index += 2
    } else if (char === '|' || char === ';' || char === '&') {
      operator(char)
      index += 1
    } else if (char === '(') {
      push('operator', char)
      expectCommand = true
      groupDepth += 1
      index += 1
    } else if (char === ')') {
      push('operator', char)
      groupDepth = Math.max(0, groupDepth - 1)
      index += 1
    } else {
      let end = index + 1
      while (end < command.length && (command[end - 1] === '\\' || !WORD_END.test(command[end]))) end += 1
      const word = command.slice(index, end)
      const isAssignment = expectCommand && ASSIGNMENT.test(word)
      const kind: ShellTokenKind = isAssignment ? 'text' : expectCommand ? 'command' : word.startsWith('-') ? 'option' : 'text'
      push(kind, word)
      if (isAssignment) expectCommand = true
      index = end
    }
  }
  trimEnd()
  return lines.filter((entry, position) => entry.tokens.length > 0 || position === 0)
}

/** The script given to `sh -c '...'` / `bash -c '...'`, laid out one level deeper inside its quotes */
function expandInlineScripts(lines: ShellLine[]): ShellLine[] {
  return lines.flatMap((line) => {
    const out: ShellLine[] = [{ indent: line.indent, tokens: [] }]
    let current = out[0]
    line.tokens.forEach((token, position) => {
      const previous = line.tokens.slice(0, position).filter(entry => entry.kind !== 'space').pop()
      const isScript = token.kind === 'string' && token.text.startsWith("'") && previous?.text === '-c'
      const inner = isScript ? formatShellCommand(token.text.slice(1, -1)) : null
      if (!inner || inner.length < 2) {
        current.tokens.push(token)
        return
      }
      inner.forEach((innerLine, innerIndex) => {
        const tokens = [
          ...(innerIndex === 0 ? [{ kind: 'string' as const, text: "'" }] : []),
          ...innerLine.tokens,
          ...(innerIndex === inner.length - 1 ? [{ kind: 'string' as const, text: "'" }] : [])
        ]
        if (innerIndex === 0) {
          current.tokens.push(...tokens)
        } else {
          current = { indent: line.indent + 1 + innerLine.indent, tokens }
          out.push(current)
        }
      })
    })
    return out
  })
}

export function formatShellCommand(command: string): ShellLine[] {
  try {
    return expandInlineScripts(tokenize(command))
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error
    return command.split('\n').map(text => ({ indent: 0, tokens: [{ kind: 'text', text }] }))
  }
}

/** The formatted command as text: what is shown, and what a copy gives */
export function formattedText(lines: ShellLine[]): string {
  return lines.map(line => INDENT.repeat(line.indent) + line.tokens.map(token => token.text).join('')).join('\n')
}
