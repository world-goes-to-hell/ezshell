import { describe, it, expect } from 'vitest'
import { buildFindCommand, parseFindPrefs, shellQuote, DEFAULT_FIND_PREFS, FIND_QUERY_MAX_LENGTH } from './terminalFind'

const command = (request: Parameters<typeof buildFindCommand>[0]): string => {
  const result = buildFindCommand(request)
  if (!result.ok) throw new Error(result.problem)
  return result.command
}

describe('shellQuote', () => {
  it('keeps everything inside one word', () => {
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$(rm -rf /); `x`')).toBe("'$(rm -rf /); `x`'")
  })
})

describe('name search', () => {
  it('matches the word anywhere in the name, from the current folder', () => {
    expect(command({ kind: 'name', query: ' nginx ', scope: 'current' })).toBe("find . -iname '*nginx*' 2>/dev/null")
  })

  it('keeps the wildcards the user typed', () => {
    expect(command({ kind: 'name', query: '*.log', scope: 'current' })).toBe("find . -iname '*.log' 2>/dev/null")
  })

  it('skips the virtual file systems when starting at the root', () => {
    expect(command({ kind: 'name', query: 'my.cnf', scope: 'root' }))
      .toBe("find / \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -iname '*my.cnf*' -print 2>/dev/null")
  })

  it('quotes a typed folder', () => {
    expect(command({ kind: 'name', query: 'a', scope: 'custom', customDir: ' /var/my logs ' })).toBe("find '/var/my logs' -iname '*a*' 2>/dev/null")
    expect(command({ kind: 'name', query: 'a', scope: 'custom', customDir: '~/app dir' })).toBe("find ~/'app dir' -iname '*a*' 2>/dev/null")
    expect(command({ kind: 'name', query: 'a', scope: 'custom', customDir: '-odd' })).toBe("find './-odd' -iname '*a*' 2>/dev/null")
  })
})

describe('content search', () => {
  it('searches the text as typed', () => {
    expect(command({ kind: 'content', query: 'jdbc:mysql', scope: 'current' })).toBe("grep -rnIF -- 'jdbc:mysql' . 2>/dev/null")
    expect(command({ kind: 'content', query: 'Error', scope: 'custom', customDir: '/etc', ignoreCase: true })).toBe("grep -rnIFi -- 'Error' '/etc' 2>/dev/null")
  })

  it('skips the virtual file systems when starting at the root', () => {
    expect(command({ kind: 'content', query: 'x', scope: 'root' })).toBe("grep -rnIF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -- 'x' / 2>/dev/null")
  })

  it('cannot break out of the quotes', () => {
    expect(command({ kind: 'content', query: "'; rm -rf ~ #", scope: 'current' })).toBe("grep -rnIF -- ''\\''; rm -rf ~ #' . 2>/dev/null")
    expect(command({ kind: 'content', query: '-e', scope: 'current' })).toBe("grep -rnIF -- '-e' . 2>/dev/null")
  })
})

describe('refusals', () => {
  it('names what is missing', () => {
    expect(buildFindCommand({ kind: 'name', query: '  ', scope: 'current' })).toEqual({ ok: false, problem: '찾을 이름을 입력해 주세요.' })
    expect(buildFindCommand({ kind: 'content', query: '', scope: 'current' })).toMatchObject({ ok: false })
    expect(buildFindCommand({ kind: 'name', query: 'a', scope: 'custom', customDir: ' ' })).toEqual({ ok: false, problem: '찾을 폴더를 입력해 주세요.' })
  })

  it('refuses line breaks and control characters, which would run a command as it is typed', () => {
    expect(buildFindCommand({ kind: 'content', query: 'a\nreboot', scope: 'current' }).ok).toBe(false)
    expect(buildFindCommand({ kind: 'name', query: 'a\r', scope: 'current' }).ok).toBe(false)
    expect(buildFindCommand({ kind: 'name', query: 'a\u0003', scope: 'current' }).ok).toBe(false)
    expect(buildFindCommand({ kind: 'name', query: 'a', scope: 'custom', customDir: '/tmp\nreboot' }).ok).toBe(false)
  })

  it('limits the length', () => {
    expect(buildFindCommand({ kind: 'name', query: 'a'.repeat(FIND_QUERY_MAX_LENGTH + 1), scope: 'current' }).ok).toBe(false)
  })
})

describe('parseFindPrefs', () => {
  it('reads what was kept and falls back on anything else', () => {
    expect(parseFindPrefs(JSON.stringify({ scope: 'root', customDir: '/var', ignoreCase: false }))).toEqual({ scope: 'root', customDir: '/var', ignoreCase: false })
    expect(parseFindPrefs(JSON.stringify({ scope: 'elsewhere', customDir: 3 }))).toEqual(DEFAULT_FIND_PREFS)
    expect(parseFindPrefs('{broken')).toEqual(DEFAULT_FIND_PREFS)
    expect(parseFindPrefs(null)).toEqual(DEFAULT_FIND_PREFS)
  })
})
