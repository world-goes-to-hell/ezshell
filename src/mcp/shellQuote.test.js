import { describe, it, expect } from 'vitest'
import quote from './shellQuote.js'

const { shellQuote, quoteCdTarget } = quote

describe('shellQuote', () => {
  it('wraps a value in single quotes', () => {
    expect(shellQuote('/var/log')).toBe("'/var/log'")
  })

  it('keeps spaces, Korean and shell operators inside one word', () => {
    expect(shellQuote('로그 폴더; rm x')).toBe("'로그 폴더; rm x'")
  })

  it('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('quotes an empty value', () => {
    expect(shellQuote('')).toBe("''")
  })
})

describe('quoteCdTarget', () => {
  it('leaves a bare ~ for the shell to expand', () => {
    expect(quoteCdTarget('~')).toBe('~')
  })

  it('keeps ~/ unquoted and quotes the rest', () => {
    expect(quoteCdTarget("~/my app's logs")).toBe("~/'my app'\\''s logs'")
  })

  it('quotes other paths, including ~user', () => {
    expect(quoteCdTarget('/var/log')).toBe("'/var/log'")
    expect(quoteCdTarget('~user')).toBe("'~user'")
  })
})
