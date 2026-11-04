// Display-only layout of a shell command for the MCP activity view. AI agents send long one-liners
// joined with ; && || |; this breaks them into lines and names the parts for colouring.
// Nothing but line breaks and indentation is added, and each line ends with its operator, so the
// formatted text still runs the same when copied into bash. Anything it cannot read safely (a heredoc,
// an unclosed quote) is left exactly as it was.

/**
 * `heredoc`: a line of a heredoc body, kept exactly; `heredoc-end`: the line that closes it.
 * `keyword`: only from highlightCodeLine, for the code in a heredoc body.
 */
export type ShellTokenKind = 'command' | 'option' | 'string' | 'variable' | 'operator' | 'redirect' | 'comment' | 'text' | 'space' | 'heredoc' | 'heredoc-end' | 'keyword'

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

interface PendingHeredoc {
  delimiter: string
  /** <<- : the body and the end line may start with tabs */
  stripTabs: boolean
}

/** Where a heredoc operator at `start` (<< or <<-, then the delimiter) ends, and what ends its body */
function readHeredocOperator(command: string, start: number): { end: number; heredoc: PendingHeredoc } {
  let index = start + 2
  const stripTabs = command[index] === '-'
  if (stripTabs) index += 1
  while (command[index] === ' ' || command[index] === '\t') index += 1
  const wordStart = index
  while (index < command.length && !/[\s;&|()<>]/.test(command[index])) {
    if (command[index] === "'" || command[index] === '"') index = closingQuote(command, index)
    else index += 1
  }
  // Quotes only say the body is taken literally; the delimiter is the word without them
  const delimiter = command.slice(wordStart, index).replace(/['"\\]/g, '')
  if (!delimiter) throw new Unreadable()
  return { end: index, heredoc: { delimiter, stripTabs } }
}

function tokenize(command: string): ShellLine[] {
  const lines: ShellLine[] = [{ indent: 0, tokens: [] }]
  let line = lines[0]
  let expectCommand = true
  let groupDepth = 0
  let index = 0
  // Heredocs opened on the current line; their bodies start after it
  let pendingHeredocs: PendingHeredoc[] = []

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
    // The body of a heredoc starts after the line that opens it: nothing on that line may move down
    if (groupDepth > 0 || pendingHeredocs.length > 0) return
    if (CONTINUING.has(text)) newLine(1)
    else if (LIST_ENDS.has(text)) newLine(0)
  }
  /** At the newline that ends a line opening heredocs: each body, line by line, exactly as written */
  const readHeredocBodies = () => {
    for (const { delimiter, stripTabs } of pendingHeredocs) {
      for (;;) {
        if (index >= command.length) throw new Unreadable()
        const lineEnd = command.indexOf('\n', index + 1)
        const stop = lineEnd < 0 ? command.length : lineEnd
        const body = command.slice(index + 1, stop)
        index = stop
        const isEnd = (stripTabs ? body.replace(/^\t+/, '') : body) === delimiter
        trimEnd()
        line = { indent: 0, tokens: [{ kind: isEnd ? 'heredoc-end' : 'heredoc', text: body }] }
        lines.push(line)
        if (isEnd) break
      }
    }
    pendingHeredocs = []
  }

  while (index < command.length) {
    const char = command[index]
    const two = command.slice(index, index + 2)

    if (char === '\n') {
      if (pendingHeredocs.length > 0) {
        // A heredoc inside ( ) would need its body kept inside the group's line; not worth the risk
        if (groupDepth > 0) throw new Unreadable()
        readHeredocBodies()
        continue
      }
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
      // A heredoc body is not shell syntax: it is kept line for line (readHeredocBodies)
      const { end, heredoc } = readHeredocOperator(command, index)
      push('redirect', command.slice(index, end))
      pendingHeredocs = [...pendingHeredocs, heredoc]
      index = end
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
      // Only a one-line script: indenting a script that already has lines would change their text
      // (a heredoc body or a multi-line string inside it)
      const isScript = token.kind === 'string' && token.text.startsWith("'") && !token.text.includes('\n') && previous?.text === '-c'
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

// Words coloured in a heredoc body. Bodies are mostly Python, shell or SQL scripts; a word of another
// language that happens to be here only gets a colour, the text never changes.
const CODE_KEYWORDS = new Set([
  'import', 'from', 'as', 'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or',
  'is', 'None', 'True', 'False', 'try', 'except', 'finally', 'with', 'lambda', 'pass', 'break', 'continue', 'raise',
  'yield', 'global', 'then', 'fi', 'do', 'done', 'case', 'esac', 'function', 'local', 'export',
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'UPDATE', 'SET', 'DELETE', 'JOIN', 'ON', 'AND', 'OR', 'ORDER', 'BY', 'GROUP', 'LIMIT', 'VALUES'
])

/** Colours for one line of a heredoc body: strings, a # comment and common keywords. The text is unchanged. */
export function highlightCodeLine(text: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const add = (kind: ShellTokenKind, value: string) => {
    const last = tokens[tokens.length - 1]
    if (kind === 'text' && last?.kind === 'text') last.text += value
    else tokens.push({ kind, text: value })
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '#') {
      add('comment', text.slice(index))
      break
    }
    if (char === "'" || char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1
      end = Math.min(end + 1, text.length)
      add('string', text.slice(index, end))
      index = end
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index))
    if (word) {
      add(CODE_KEYWORDS.has(word[0]) ? 'keyword' : 'text', word[0])
      index += word[0].length
      continue
    }
    add('text', char)
    index += 1
  }
  return tokens
}

/** The formatted command as text: what is shown, and what a copy gives */
export function formattedText(lines: ShellLine[]): string {
  return lines.map(line => INDENT.repeat(line.indent) + line.tokens.map(token => token.text).join('')).join('\n')
}
