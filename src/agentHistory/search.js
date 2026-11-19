const { readLinesFromStart } = require('./boundedRead.js')
const claude = require('./claude.js')
const codex = require('./codex.js')

// Finding sessions by what was said in them: the questions and the answers, not tool output or
// injected context. Transcripts are large and may hold secrets, so each is read as a stream from the
// start up to a bound and only a one-line excerpt around the first hit leaves the main process.

const MAX_WORDS = 10
const MAX_WORD_LENGTH = 100
/** Per file, after decompression: past this a session is not searched further */
const MAX_FILE_BYTES = 16 * 1024 * 1024
const SNIPPET_LENGTH = 120
const SNIPPET_LEAD = 40

/** The words of a search: split at whitespace, without case, each once */
function searchWords(query) {
  if (typeof query !== 'string') return []
  const words = query.toLowerCase().split(/\s+/).map(word => word.slice(0, MAX_WORD_LENGTH)).filter(Boolean)
  return [...new Set(words)].slice(0, MAX_WORDS)
}

const TEXT_OF = {
  claude: line => claude.promptText(line) ?? claude.replyText(line),
  codex: line => codex.promptText(line) ?? codex.legacyPromptText(line) ?? codex.replyText(line)
}

/** One line of `text` around [at, at + length), with … where it was cut */
function excerpt(text, at, length) {
  const start = Math.max(0, Math.min(at, text.length) - SNIPPET_LEAD)
  const end = Math.min(text.length, Math.max(start + SNIPPET_LENGTH, at + length))
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/**
 * Whether every word is somewhere in the session's questions and answers; the excerpt is around the
 * first hit of a word. Null when not all words were found within the bound, or when cancelled.
 */
async function searchFile(agent, file, words, isCancelled = () => false) {
  const textOf = TEXT_OF[agent]
  if (!textOf || words.length === 0) return null
  const found = new Set()
  let snippet = null
  let cancelled = false
  await readLinesFromStart(file, line => {
    if (isCancelled()) {
      cancelled = true
      return true
    }
    const text = textOf(line)
    if (!text) return false
    const lower = text.toLowerCase()
    for (const word of words) {
      if (found.has(word)) continue
      const at = lower.indexOf(word)
      if (at === -1) continue
      found.add(word)
      snippet ??= excerpt(text, at, word.length)
    }
    return found.size === words.length
  }, { maxBytes: MAX_FILE_BYTES })
  if (cancelled || found.size !== words.length) return null
  return { snippet: snippet ?? '' }
}

module.exports = { searchWords, searchFile, excerpt, MAX_FILE_BYTES, SNIPPET_LENGTH }
