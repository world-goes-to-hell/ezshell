import { describe, it, expect } from 'vitest'
import { formatShellCommand, formattedText } from './shellFormat'

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

  it('leaves a heredoc or an unclosed quote exactly as it is', () => {
    const heredoc = "cat <<EOF > f\na; b | c\nEOF"
    expect(text(heredoc)).toEqual(heredoc.split('\n'))
    expect(text("echo 'open; x")).toEqual(["echo 'open; x"])
  })

  it('never loses or adds characters other than line breaks and indents', () => {
    const command = `echo '=== x' ; docker exec m sh -c 'grep -h "/a" f | tail -4' | sed -E 's/t=[^& ]*/t=***/' | cut -c1-300 && echo ok`
    const squash = (value: string) => value.replace(/\s+/g, '')
    expect(squash(formattedText(formatShellCommand(command)))).toBe(squash(command))
  })
})
