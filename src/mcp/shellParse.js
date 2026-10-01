// Splits a POSIX shell command line into simple commands for the MCP command policy.
// It is not a full shell: input it cannot follow is reported as a failure, and the
// policy treats a failed parse as dangerous. Shell keywords and group braces
// (if, then, fi, {, }) appear as ordinary words so the policy still sees the commands.

const HEREDOC_OPS = new Set(['<<', '<<-'])
const REDIRECT_OPS = ['<<<', '<<-', '<<', '<&', '<>', '<', '>>', '>|', '>&', '>']
const DUP_TARGET = /^(\d+|-)$/

class ParseError extends Error {}

function skipDoubleQuoted(input, start) {
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue }
    if (input[i] === '"') return i
  }
  return -1
}

/** Index of the `)` that closes a `$(` / `<(` whose content starts at `start`, or -1 */
function findClosingParen(input, start) {
  let depth = 1
  for (let i = start; i < input.length; i++) {
    const c = input[i]
    if (c === '\\') { i++; continue }
    if (c === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return -1
      i = end
      continue
    }
    if (c === '"') {
      const end = skipDoubleQuoted(input, i + 1)
      if (end === -1) return -1
      i = end
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

function findBacktick(input, start) {
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue }
    if (input[i] === '`') return i
  }
  return -1
}

function tokenize(input) {
  const tokens = []
  const substitutions = []
  let word = ''
  let inWord = false
  let quoted = false

  const pushWord = () => {
    if (inWord) tokens.push({ type: 'word', text: word, quoted })
    word = ''
    inWord = false
    quoted = false
  }
  const addText = (text) => { word += text; inWord = true }

  /** `$(...)` or `<(...)` / `>(...)` starting at `i`; returns the index after `)` */
  const takeParenSubstitution = (i) => {
    const end = findClosingParen(input, i + 2)
    if (end === -1) throw new ParseError('닫히지 않은 괄호 치환')
    substitutions.push(input.slice(i + 2, end))
    addText(input.slice(i, end + 1))
    return end + 1
  }
  const takeBacktick = (i) => {
    const end = findBacktick(input, i + 1)
    if (end === -1) throw new ParseError('닫히지 않은 백틱')
    if (input.slice(i + 1, end).includes('\\')) throw new ParseError('백틱 안의 역슬래시는 해석하지 않음')
    substitutions.push(input.slice(i + 1, end))
    addText(input.slice(i, end + 1))
    return end + 1
  }
  const takeDoubleQuoted = (start) => {
    for (let j = start; j < input.length;) {
      const c = input[j]
      if (c === '"') { quoted = true; inWord = true; return j + 1 }
      if (c === '\\') {
        const next = input[j + 1]
        if (next === '\n') { j += 2; continue }
        if (next !== undefined && '$`"\\'.includes(next)) { addText(next); j += 2; continue }
        addText('\\')
        j++
        continue
      }
      if (c === '$' && input[j + 1] === '(') { j = takeParenSubstitution(j); continue }
      if (c === '`') { j = takeBacktick(j); continue }
      addText(c)
      j++
    }
    throw new ParseError('큰따옴표가 닫히지 않음')
  }

  let i = 0
  while (i < input.length) {
    const c = input[i]
    const next = input[i + 1]

    if (c === '\\') {
      if (next === '\n') { i += 2; continue }
      if (next === undefined) throw new ParseError('끝에 \\ 만 있음')
      addText(next)
      quoted = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) throw new ParseError('작은따옴표가 닫히지 않음')
      addText(input.slice(i + 1, end))
      quoted = true
      i = end + 1
      continue
    }
    if (c === '"') { i = takeDoubleQuoted(i + 1); continue }
    if (c === '$' && next === '(') { i = takeParenSubstitution(i); continue }
    if (c === '$' && next === "'") throw new ParseError("$'...' 인용은 해석하지 않음")
    if (c === '$' && next === '{') {
      const end = input.indexOf('}', i + 2)
      if (end === -1) throw new ParseError('닫히지 않은 ${')
      if (/['"`$\\{]/.test(input.slice(i + 2, end))) throw new ParseError('${} 안의 복잡한 내용은 해석하지 않음')
      addText(input.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '`') { i = takeBacktick(i); continue }
    if ((c === '<' || c === '>') && next === '(' && !inWord) { i = takeParenSubstitution(i); continue }
    if (c === '#' && !inWord) {
      const end = input.indexOf('\n', i)
      i = end === -1 ? input.length : end
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue }
    if (c === '\n' || c === ';') { pushWord(); tokens.push({ type: 'op', text: ';' }); i++; continue }
    if (c === '&' && next === '>') {
      pushWord()
      const op = input[i + 2] === '>' ? '&>>' : '&>'
      tokens.push({ type: 'redir', op, fd: '' })
      i += op.length
      continue
    }
    if (c === '&' || c === '|') {
      pushWord()
      if (next === c) { tokens.push({ type: 'op', text: c + c }); i += 2; continue }
      if (c === '|' && next === '&') { tokens.push({ type: 'op', text: '|' }); i += 2; continue }
      tokens.push({ type: 'op', text: c })
      i++
      continue
    }
    if (c === '(' || c === ')') { pushWord(); tokens.push({ type: 'op', text: c }); i++; continue }
    if (c === '>' || c === '<') {
      const fd = inWord && !quoted && /^\d+$/.test(word) ? word : ''
      if (fd) { word = ''; inWord = false } else { pushWord() }
      const op = REDIRECT_OPS.find(candidate => input.startsWith(candidate, i))
      if (HEREDOC_OPS.has(op)) throw new ParseError('heredoc은 해석하지 않음')
      tokens.push({ type: 'redir', op, fd })
      i += op.length
      continue
    }
    addText(c)
    i++
  }
  pushWord()
  return { tokens, substitutions }
}

function parseCommand(input) {
  try {
    const { tokens, substitutions } = tokenize(String(input))
    const segments = []
    let current = { words: [], redirects: [] }
    let background = false
    let heredoc = false
    const flush = () => {
      if (current.words.length > 0 || current.redirects.length > 0) segments.push(current)
      current = { words: [], redirects: [] }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.type === 'word') { current.words.push(token.text); continue }
      if (token.type === 'op') {
        if (token.text === '&') background = true
        flush()
        continue
      }
      const target = tokens[i + 1]
      if (!target || target.type !== 'word') throw new ParseError(`${token.op} 뒤에 대상이 없음`)
      i++
      if (HEREDOC_OPS.has(token.op)) heredoc = true
      const isDup = (token.op === '>&' || token.op === '<&') && DUP_TARGET.test(target.text)
      const op = isDup ? 'dup' : token.op === '>&' ? '>' : token.op === '<&' ? '<' : token.op
      current.redirects.push({ op, fd: token.fd, target: target.text })
    }
    flush()
    return { ok: true, segments, substitutions, background, heredoc }
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message }
    throw err
  }
}

module.exports = { parseCommand }
