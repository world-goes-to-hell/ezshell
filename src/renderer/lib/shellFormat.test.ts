import { describe, it, expect } from 'vitest'
import { formatShellCommand, formattedText, highlightCodeLine } from './shellFormat'

/** Lines as plain text, with two spaces per indent level */
const text = (command: string) => formattedText(formatShellCommand(command)).split('\n')
const kinds = (command: string) => formatShellCommand(command).flatMap(line => line.tokens).filter(token => token.kind !== 'space')

describe('formatShellCommand', () => {
  it('keeps a simple command on one line', () => {
    expect(text('ls -al /tmp')).toEqual(['ls -al /tmp'])
  })

  it('starts a new line after ; and keeps the ;', () => {
    expect(text("echo '=== a'; docker ps; uptime")).toEqual(["echo '=== a';", 'docker ps;', 'uptime'])
  })

  it('puts a piped command on an indented line, the | ending the line before', () => {
    expect(text("grep x f | tail -4 | sed -E 's/a/b/'")).toEqual(['grep x f |', '  tail -4 |', "  sed -E 's/a/b/'"])
  })

  it('treats && and || like a pipe', () => {
    expect(text('mkdir -p $P && cd $P || exit 1')).toEqual(['mkdir -p $P &&', '  cd $P ||', '  exit 1'])
  })

  it('does not split inside quotes, $( ) or backticks', () => {
    expect(text(`echo "a; b | c" 'd && e' $(f | g; h) \`i; j\``)).toEqual([`echo "a; b | c" 'd && e' $(f | g; h) \`i; j\``])
  })

  it('keeps 2>&1 and other redirects in one piece', () => {
    expect(text('make 2>&1 | tee log')).toEqual(['make 2>&1 |', '  tee log'])
    expect(kinds('make 2>/dev/null').map(token => [token.kind, token.text])).toEqual([['command', 'make'], ['redirect', '2>'], ['text', '/dev/null']])
  })

  it('formats the script given to sh -c one level deeper, keeping the quotes', () => {
    expect(text("docker exec main sh -c 'grep -h x f | tail -4' | cut -c1-300")).toEqual([
      "docker exec main sh -c 'grep -h x f |",
      '    tail -4\' |',
      '  cut -c1-300'
    ])
  })

  it('keeps existing line breaks as line breaks', () => {
    expect(text('set -e\nP=/tmp/x\ncd $P')).toEqual(['set -e', 'P=/tmp/x', 'cd $P'])
  })

  it('names the parts of a command for colouring', () => {
    expect(kinds('sudo -n mkdir "$P" ${HOME}/x').map(token => token.kind)).toEqual(['command', 'option', 'text', 'string', 'variable', 'text'])
  })

  it('takes the word after VAR= assignments as the command', () => {
    expect(kinds('LANG=C sort f').map(token => [token.kind, token.text])).toEqual([['text', 'LANG=C'], ['command', 'sort'], ['text', 'f']])
  })

  it('shows a comment as a comment', () => {
    expect(kinds('ls # list').map(token => token.kind)).toEqual(['command', 'comment'])
  })

  it('leaves an unclosed quote exactly as it is', () => {
    expect(text("echo 'open; x")).toEqual(["echo 'open; x"])
  })

  it('formats the command before a heredoc and keeps its body exactly, indentation included', () => {
    const command = "cd /x && python3 - <<'EOF'\nimport os\nfor n in names:\n    a = 1; b = 2\nEOF"
    expect(text(command)).toEqual(['cd /x &&', "  python3 - <<'EOF'", 'import os', 'for n in names:', '    a = 1; b = 2', 'EOF'])
    const lines = formatShellCommand(command)
    expect(lines[0].tokens[0]).toEqual({ kind: 'command', text: 'cd' })
    expect(lines.slice(2, 5).every(line => line.indent === 0 && line.tokens.every(token => token.kind === 'heredoc'))).toBe(true)
    expect(lines[5].tokens).toEqual([{ kind: 'heredoc-end', text: 'EOF' }])
  })

  it('does not split the rest of the line that starts a heredoc, and goes on after it', () => {
    expect(text('cat <<EOF | grep a\nb; c\nEOF\necho done; ls')).toEqual(['cat <<EOF | grep a', 'b; c', 'EOF', 'echo done;', 'ls'])
  })

  it('ends a <<- heredoc at a tab-indented delimiter', () => {
    expect(text('cat <<-END\n\tx\n\tEND\nls')).toEqual(['cat <<-END', '\tx', '\tEND', 'ls'])
  })

  it('leaves a heredoc without its end line, or one inside ( ), exactly as it is', () => {
    expect(text('cat <<EOF\nno end; x')).toEqual(['cat <<EOF', 'no end; x'])
    expect(text('(cat <<EOF\na\nEOF\n)')).toEqual(['(cat <<EOF', 'a', 'EOF', ')'])
  })

  it('does not lay out a sh -c script that holds a heredoc', () => {
    const command = "sh -c 'cat <<EOF\na | b\nEOF' | wc -l"
    expect(text(command)).toEqual(["sh -c 'cat <<EOF", 'a | b', "EOF' |", '  wc -l'])
  })

  it('never loses or adds characters other than line breaks and indents', () => {
    const command = `echo '=== x' ; docker exec m sh -c 'grep -h "/a" f | tail -4' | sed -E 's/t=[^& ]*/t=***/' | cut -c1-300 && cat <<'EOF' | wc\n  a; b\nEOF\necho ok`
    const squash = (value: string) => value.replace(/\s+/g, '')
    expect(squash(formattedText(formatShellCommand(command)))).toBe(squash(command))
  })
})

describe('highlightCodeLine', () => {
  const join = (line: string) => highlightCodeLine(line).map(token => token.text).join('')

  it('colours keywords, strings and a comment without changing the text', () => {
    const line = "    if p.pw_dir!=f'/home/{n}': errs.append('home')  # check"
    expect(join(line)).toBe(line)
    const kinds = highlightCodeLine(line).filter(token => token.kind !== 'text').map(token => [token.kind, token.text])
    expect(kinds).toEqual([['keyword', 'if'], ['string', "'/home/{n}'"], ['string', "'home'"], ['comment', '# check']])
  })

  it('does not take a keyword inside a longer name or a # inside a string', () => {
    expect(highlightCodeLine('information = "a#b"').map(token => token.kind)).toEqual(['text', 'string'])
  })

  it('treats an unclosed quote as a string to the end of the line', () => {
    expect(highlightCodeLine("x = 'abc").map(token => [token.kind, token.text])).toEqual([['text', 'x = '], ['string', "'abc"]])
  })
})
