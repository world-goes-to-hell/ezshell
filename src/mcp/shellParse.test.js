import { describe, it, expect } from 'vitest'
import parser from './shellParse.js'

const { parseCommand } = parser
const words = (input) => parseCommand(input).segments.map(segment => segment.words)

describe('parseCommand', () => {
  it('splits on ; && || | and newlines', () => {
    expect(words('ls -al; pwd && whoami || id | wc -l\nuptime'))
      .toEqual([['ls', '-al'], ['pwd'], ['whoami'], ['id'], ['wc', '-l'], ['uptime']])
  })

  it('removes quotes and escapes', () => {
    expect(words(`grep "a b" 'c;d' e\\ f r''m \\rm`)).toEqual([['grep', 'a b', 'c;d', 'e f', 'rm', 'rm']])
  })

  it('keeps operators inside quotes as text', () => {
    expect(words(`grep '|' file`)).toEqual([['grep', '|', 'file']])
  })

  it('collects command substitutions', () => {
    expect(parseCommand('echo $(rm -rf x) `id` "$(whoami)"').substitutions).toEqual(['rm -rf x', 'id', 'whoami'])
  })

  it('collects the outer text of nested substitutions', () => {
    expect(parseCommand('echo $(echo $(id))').substitutions).toEqual(['echo $(id)'])
  })

  it('collects process substitutions', () => {
    expect(parseCommand('diff <(ls a) <(ls b)').substitutions).toEqual(['ls a', 'ls b'])
  })

  it('parses redirects and descriptor duplication', () => {
    const [segment] = parseCommand('cat a > b 2>&1 < c').segments
    expect(segment.words).toEqual(['cat', 'a'])
    expect(segment.redirects).toEqual([
      { op: '>', fd: '', target: 'b' },
      { op: 'dup', fd: '2', target: '1' },
      { op: '<', fd: '', target: 'c' }
    ])
  })

  it('parses attached and &> redirects', () => {
    const [segment] = parseCommand('echo x>out &>log').segments
    expect(segment.words).toEqual(['echo', 'x'])
    expect(segment.redirects).toEqual([
      { op: '>', fd: '', target: 'out' },
      { op: '&>', fd: '', target: 'log' }
    ])
  })

  it('treats a quoted > as a plain word', () => {
    expect(parseCommand(`grep '>' f`).segments[0].redirects).toEqual([])
  })

  it('marks background jobs but not &&', () => {
    expect(parseCommand('sleep 10 &').background).toBe(true)
    expect(parseCommand('a && b').background).toBe(false)
  })

  it('fails closed on heredocs but allows here-strings', () => {
    expect(parseCommand('cat <<EOF\nhi\nEOF').ok).toBe(false)
    expect(parseCommand('cat <<-EOF\nhi\nEOF').ok).toBe(false)
    expect(parseCommand("cat <<EOF\nit's\nEOF\nrm x # '").ok).toBe(false)
    const result = parseCommand('cat <<< hello')
    expect(result.ok).toBe(true)
    expect(result.segments[0].redirects).toEqual([{ op: '<<<', fd: '', target: 'hello' }])
    expect(result.heredoc).toBe(false)
  })

  it('fails closed on constructs that can hide commands', () => {
    expect(parseCommand('echo ${x:-$(rm -rf /)}').ok).toBe(false)
    expect(parseCommand('echo ${x:-`rm x`}').ok).toBe(false)
    expect(parseCommand("echo ${x:-'}'}; rm y #'").ok).toBe(false)
    expect(parseCommand('echo ${x:-"}"}; rm y #"').ok).toBe(false)
    expect(parseCommand('echo ${x:-{a}}').ok).toBe(false)
    expect(parseCommand("echo $'\\'' ; rm x # '").ok).toBe(false)
    expect(parseCommand('echo `echo \\`rm x\\``').ok).toBe(false)
  })

  it('still parses plain ${VAR} expansions', () => {
    expect(words('echo ${HOME}/x')).toEqual([['echo', '${HOME}/x']])
  })

  it('keeps compound keywords as ordinary words', () => {
    expect(words('if x; then rm y; fi')).toEqual([['if', 'x'], ['then', 'rm', 'y'], ['fi']])
  })

  it('ignores comments', () => {
    expect(words('ls # rm -rf /')).toEqual([['ls']])
    expect(words('echo a#b')).toEqual([['echo', 'a#b']])
  })

  it('splits subshell parentheses', () => {
    expect(words('(cd /tmp; rm x)')).toEqual([['cd', '/tmp'], ['rm', 'x']])
  })

  it('keeps ${VAR} as text', () => {
    expect(words('echo ${HOME}/x')).toEqual([['echo', '${HOME}/x']])
  })

  it('fails on input it cannot follow', () => {
    expect(parseCommand(`echo 'oops`).ok).toBe(false)
    expect(parseCommand('echo "oops').ok).toBe(false)
    expect(parseCommand('echo $(id').ok).toBe(false)
    expect(parseCommand('echo `id').ok).toBe(false)
    expect(parseCommand('ls >').ok).toBe(false)
  })
})
