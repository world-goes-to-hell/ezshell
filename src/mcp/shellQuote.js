/** Quote a value as one POSIX shell word: it's -> 'it'\''s' */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Like shellQuote, but a leading ~ or ~/ stays unquoted so the shell still expands it */
function quoteCdTarget(target) {
  if (target === '~') return '~'
  if (target.startsWith('~/')) return `~/${shellQuote(target.slice(2))}`
  return shellQuote(target)
}

module.exports = { shellQuote, quoteCdTarget }
