import { describe, it, expect } from 'vitest'
import { readTypedInput, findSuggestions, resolveSuggestKey, isTypingInput, cellWidth, type CursorBufferLike } from './historySuggest'

const COLS = 20

/** Fake xterm buffer: rows of plain ASCII, cursor at (cursorX, cursorY); wrapped rows marked with a leading '~' */
function buffer(rows: string[], cursorY: number, cursorX: number): CursorBufferLike {
  const lines = rows.map(row => {
    const isWrapped = row.startsWith('~')
    const text = (isWrapped ? row.slice(1) : row).padEnd(COLS, ' ')
    return {
      isWrapped,
      translateToString: (trimRight = false, start = 0, end = COLS) => {
        const part = text.slice(start, end)
        return trimRight ? part.trimEnd() : part
      }
    }
  })
  return { baseY: 0, cursorY, cursorX, getLine: (y: number) => lines[y] }
}

const entries = (...commands: string[]) => commands.map((command, i) => ({ command, lastUsedAt: 1000 - i }))

describe('readTypedInput', () => {
  it('reads what was typed after the prompt up to the cursor', () => {
    expect(readTypedInput(buffer(['$ systemctl re'], 0, 14))).toBe('systemctl re')
  })

  it('keeps a trailing space, which narrows the match ("git " vs "gitk")', () => {
    expect(readTypedInput(buffer(['$ git '], 0, 6))).toBe('git ')
  })

  it('joins a soft-wrapped input line', () => {
    // "$ docker compose logs -f" wraps after 20 columns
    expect(readTypedInput(buffer(['$ docker compose log', '~s -f'], 1, 4))).toBe('docker compose logs -f')
  })

  it('is null when the cursor is not at the end of the input (editing in the middle)', () => {
    expect(readTypedInput(buffer(['$ systemctl restart'], 0, 6))).toBeNull()
  })

  it('is null for lines that are not commands: password prompts, continuation lines, no prompt', () => {
    expect(readTypedInput(buffer(['Password: abc'], 0, 13))).toBeNull()
    expect(readTypedInput(buffer(['> secret=1'], 0, 10))).toBeNull()
    expect(readTypedInput(buffer(['total 48'], 0, 8))).toBeNull()
  })

  it('is null for input kept out of history (leading space) and for fewer than 2 characters', () => {
    expect(readTypedInput(buffer(['$  export X=1'], 0, 13))).toBeNull()
    expect(readTypedInput(buffer(['$ l'], 0, 3))).toBeNull()
    expect(readTypedInput(buffer(['$ '], 0, 2))).toBeNull()
  })
})

describe('findSuggestions', () => {
  it('lists commands starting with the input, most recent first, then ones containing it', () => {
    const list = entries('git status', 'sudo systemctl restart nginx', 'systemctl reload sshd', 'systemctl restart nginx')

    expect(findSuggestions(list, 'systemctl re')).toEqual([
      'systemctl reload sshd',
      'systemctl restart nginx',
      'sudo systemctl restart nginx'
    ])
  })

  it('leaves out the command that is exactly what was typed', () => {
    expect(findSuggestions(entries('ls -al', 'ls -al /var'), 'ls -al')).toEqual(['ls -al /var'])
  })

  it('is case sensitive like the shell, and caps the list', () => {
    expect(findSuggestions(entries('LS', 'ls'), 'ls ')).toEqual([])
    const many = entries(...Array.from({ length: 12 }, (_, i) => `echo ${i}`))
    expect(findSuggestions(many, 'echo', 8)).toHaveLength(8)
  })
})

describe('resolveSuggestKey', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

  it('starts with nothing selected; arrows move through the list and wrap', () => {
    expect(resolveSuggestKey(key('ArrowDown'), 3, null)).toEqual({ type: 'select', index: 0 })
    expect(resolveSuggestKey(key('ArrowDown'), 3, 2)).toEqual({ type: 'select', index: 0 })
    expect(resolveSuggestKey(key('ArrowUp'), 3, null)).toEqual({ type: 'select', index: 2 })
    expect(resolveSuggestKey(key('ArrowUp'), 3, 0)).toEqual({ type: 'select', index: 2 })
  })

  it('Enter fills the line only with a selected item; without one it closes and lets the shell run the line', () => {
    expect(resolveSuggestKey(key('Enter'), 3, 1)).toEqual({ type: 'accept', index: 1 })
    expect(resolveSuggestKey(key('Enter'), 3, null)).toEqual({ type: 'close', passThrough: true })
  })

  it('Escape closes without reaching the shell; Tab closes and goes to the shell completion', () => {
    expect(resolveSuggestKey(key('Escape'), 3, 0)).toEqual({ type: 'close', passThrough: false })
    expect(resolveSuggestKey(key('Tab'), 3, 0)).toEqual({ type: 'close', passThrough: true })
  })

  it('leaves typing and modified keys to the shell', () => {
    expect(resolveSuggestKey(key('a'), 3, 0)).toEqual({ type: 'pass' })
    expect(resolveSuggestKey(key('ArrowDown', { ctrlKey: true }), 3, 0)).toEqual({ type: 'pass' })
    expect(resolveSuggestKey(key('Enter', { shiftKey: true }), 3, 0)).toEqual({ type: 'pass' })
  })
})

describe('isTypingInput', () => {
  it('counts characters, backspace and pasted text as typing', () => {
    expect(isTypingInput('s')).toBe(true)
    expect(isTypingInput('\x7f')).toBe(true)
    expect(isTypingInput('docker ps')).toBe(true)
  })

  it('does not count Enter, Ctrl+C / Ctrl+D, Tab or escape sequences (arrows, shell history recall)', () => {
    for (const data of ['\r', '\x03', '\x04', '\t', '\x1b[A', '\x1b[B', '\x1b']) {
      expect(isTypingInput(data)).toBe(false)
    }
  })
})

describe('cellWidth', () => {
  it('counts terminal columns: two for Hangul and other wide characters', () => {
    expect(cellWidth('ls -al')).toBe(6)
    expect(cellWidth('echo 안녕')).toBe(9)
    expect(cellWidth('ｆｕｌｌ')).toBe(8)
    expect(cellWidth('')).toBe(0)
  })
})
