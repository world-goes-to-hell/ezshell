import { describe, it, expect } from 'vitest'
import { extractCommand, readInputLine, buildInsertSequence, getHistoryKey, isHistoryShortcut, type BufferLike } from './commandCapture'

describe('extractCommand', () => {
  it.each([
    ['[root@devel-docker-1 mbris-old]# docker compose ps', 'docker compose ps'],
    ['user@host:~$ ls -al', 'ls -al'],
    ['host% make build', 'make build'],
    ['PS C:\\Users\\me> Get-ChildItem', 'Get-ChildItem'],
    ['~/project ❯ git status', 'git status'],
    ['$ tail -f app.log   ', 'tail -f app.log']
  ])('strips the prompt from %s', (line, expected) => {
    expect(extractCommand(line)).toBe(expected)
  })

  it.each([
    ['a bare $ prompt', '$ ls', 'ls'],
    ['a bare # prompt', '# systemctl status nginx', 'systemctl status nginx'],
    ['a named > prompt', 'mysql> SELECT 1;', 'SELECT 1;']
  ])('keeps %s', (_label, line, expected) => {
    expect(extractCommand(line)).toBe(expected)
  })

  it('only strips up to the first prompt marker', () => {
    expect(extractCommand('[root@dev ~]# echo a > b # note')).toBe('echo a > b # note')
  })

  it.each([
    ['a password prompt', '[sudo] password for root: '],
    ['a yes/no answer', 'Are you sure you want to continue connecting (yes/no)? yes'],
    ['plain output', 'total 48'],
    ['an empty prompt', '[root@dev ~]# '],
    ['a command starting with a space (ignorespace)', '[root@dev ~]#  export TOKEN=secret'],
    ['an empty line', ''],
    ['a shell continuation line (PS2), e.g. a heredoc body', '> password=hunter2'],
    ['a MySQL continuation line', '    -> WHERE id = 1'],
    ['a Python REPL line', '>>> import os']
  ])('ignores %s', (_label, line) => {
    expect(extractCommand(line)).toBeNull()
  })
})

function makeBuffer(lines: Array<{ text: string; isWrapped?: boolean }>, cursorY: number, baseY = 0): BufferLike {
  return {
    baseY,
    cursorY,
    getLine: (y: number) => {
      const line = lines[y]
      if (!line) return undefined
      return {
        isWrapped: line.isWrapped ?? false,
        translateToString: (trimRight?: boolean) => (trimRight ? line.text.trimEnd() : line.text)
      }
    }
  }
}

describe('readInputLine', () => {
  it('reads the line under the cursor', () => {
    const buffer = makeBuffer([{ text: 'old output' }, { text: '$ ls   ' }], 1)
    expect(readInputLine(buffer)).toBe('$ ls')
  })

  it('joins a long command wrapped over several rows, keeping spaces at the wrap point', () => {
    const buffer = makeBuffer([
      { text: '$ echo aaaa ' },
      { text: 'bbbb cccc   ', isWrapped: true }
    ], 1)
    expect(readInputLine(buffer)).toBe('$ echo aaaa bbbb cccc')
  })

  it('includes wrapped rows below the cursor', () => {
    const buffer = makeBuffer([
      { text: '$ echo aaaa ' },
      { text: 'bbbb', isWrapped: true }
    ], 0)
    expect(readInputLine(buffer)).toBe('$ echo aaaa bbbb')
  })

  it('uses baseY for scrolled buffers', () => {
    const buffer = makeBuffer([{ text: 'scrollback' }, { text: '$ pwd' }], 0, 1)
    expect(readInputLine(buffer)).toBe('$ pwd')
  })
})

describe('buildInsertSequence', () => {
  it('replaces the current input line without pressing Enter', () => {
    expect(buildInsertSequence('ls -al')).toBe('\x05\x15ls -al')
  })
})

describe('getHistoryKey', () => {
  it('uses the saved session id when there is one', () => {
    expect(getHistoryKey({ savedSessionId: 'abc-123', host: 'h', port: 22, username: 'u' })).toBe('abc-123')
  })

  it('falls back to user@host:port for quick connects', () => {
    expect(getHistoryKey({ savedSessionId: null, host: '10.0.0.1', port: 2222, username: 'root' })).toBe('quick:root@10.0.0.1:2222')
  })

  it('defaults the port to 22', () => {
    expect(getHistoryKey({ savedSessionId: null, host: 'h', username: 'u' })).toBe('quick:u@h:22')
  })

  it('returns null without connection info', () => {
    expect(getHistoryKey(null)).toBeNull()
  })
})

describe('isHistoryShortcut', () => {
  const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: '', ...init }) as KeyboardEvent

  it('matches Ctrl+Shift+H by physical key, so it works with the Korean input mode on', () => {
    expect(isHistoryShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyH', key: 'ㅗ' }))).toBe(true)
  })

  it.each([
    ['Ctrl+H (backspace in terminals)', { ctrlKey: true, code: 'KeyH' }],
    ['Ctrl+Shift+Alt+H', { ctrlKey: true, shiftKey: true, altKey: true, code: 'KeyH' }],
    ['Ctrl+Shift+J', { ctrlKey: true, shiftKey: true, code: 'KeyJ' }]
  ])('does not match %s', (_label, init) => {
    expect(isHistoryShortcut(key(init))).toBe(false)
  })
})
