const PLACEHOLDER = '?'
const MAX_LENGTH = 3
const MAX_DIGITS = 2
const NON_LATIN_LENGTH = 2

/** "[개발] ", "(운영) ", "【prod】 " at the start of a name */
const LEADING_TAG = /^[[(【]([^\])】]*)[\])】]\s*/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const WORD_SEPARATORS = /[\s_\-/]+/
const QUALIFIER = /\(([^)]+)\)/
const LATIN_RUN = /^[A-Za-z0-9]+/
const TRAILING_DIGITS = /\d+$/
const DIGITS_ONLY = /^\d+$/
const HAS_LATIN = /[A-Za-z]/

/** Letters of `word` (up to what fits next to `digits`) followed by the digits. */
function withDigits(word: string, digits: string): string {
  const tail = digits.slice(-MAX_DIGITS)
  const head = Array.from(word).slice(0, MAX_LENGTH - tail.length).join('')
  return (head + tail).toUpperCase()
}

function shorten(word: string): string {
  const latin = word.match(LATIN_RUN)
  if (!latin) return Array.from(word).slice(0, NON_LATIN_LENGTH).join('')

  const run = latin[0]
  const digits = run.match(TRAILING_DIGITS)?.[0] ?? ''
  return withDigits(run.slice(0, run.length - digits.length), digits)
}

/**
 * A 1-3 character label that tells sessions apart in the icon-only sidebar.
 *
 * Names like "[개발] 바우처 WAS" share their prefix within a folder, so the
 * leading tag is dropped and the last word (usually the server role) is used.
 */
export function getAbbreviation(name: string): string {
  let text = name.trim()
  if (!text) return PLACEHOLDER

  // Default session names are "user@host"
  if (text.includes('@') && !/\s/.test(text)) {
    text = text.slice(text.lastIndexOf('@') + 1)
  }
  if (IPV4.test(text)) return text.slice(text.lastIndexOf('.') + 1)

  let lastTag = ''
  for (let tag = text.match(LEADING_TAG); tag; tag = text.match(LEADING_TAG)) {
    lastTag = tag[1].trim()
    text = text.slice(tag[0].length)
  }

  const words = text.split(WORD_SEPARATORS).filter(Boolean)
  if (words.length === 0) return lastTag ? shorten(lastTag) : PLACEHOLDER

  const last = words[words.length - 1]
  if (DIGITS_ONLY.test(last) && words.length > 1) {
    return withDigits(words[words.length - 2], last)
  }

  // A latin word is usually the role ("DB", "MCP"), while hangul words describe it
  const target = [...words].reverse().find(word => HAS_LATIN.test(word)) ?? last
  const qualifier = target.match(QUALIFIER)
  return shorten(qualifier ? qualifier[1] : target)
}
