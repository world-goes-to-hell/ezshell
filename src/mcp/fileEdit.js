// Text changes for the MCP file tools: the edit_file replacement, and what changed between two
// versions of a file (shown to the user before anything is written).
const { structuredPatch } = require('diff')

const CONTEXT_LINES = 3
/**
 * Working out an exact diff is quadratic in the worst case (every line different): seconds for a few
 * thousand lines, and it runs in the main process. Past this limit the change is shown as the whole
 * file replaced, which is still complete.
 */
const DIFF_TIMEOUT_MS = 300
const LINE_TYPES = { '+': 'add', '-': 'remove', ' ': 'context', '\\': 'note' }

function countOccurrences(text, part) {
  let count = 0
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count++
  return count
}

/** Lines as an editor counts them: a final line break does not start another line. */
function splitLines(text) {
  if (text === '') return []
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.slice(0, -1) : lines
}

const countLines = (text) => splitLines(text).length

/**
 * Replace `oldString` by `newString`, both taken literally. Without `replaceAll` the text must occur
 * exactly once: a change must never land somewhere the caller did not mean.
 * `maxLength` (characters) refuses a result that would be too large before it is built.
 */
function applyEdit(content, { oldString, newString, replaceAll = false, maxLength = Infinity }) {
  const count = countOccurrences(content, oldString)
  if (count === 0) {
    // A file with CRLF line ends never matches text written with LF; say so instead of a bare "not found"
    const crlf = content.includes('\r\n') && oldString.includes('\n') && !oldString.includes('\r\n')
    return crlf ? { ok: false, reason: 'not-found', count, crlf: true } : { ok: false, reason: 'not-found', count }
  }
  if (count > 1 && !replaceAll) return { ok: false, reason: 'ambiguous', count }
  if (content.length + count * (newString.length - oldString.length) > maxLength) return { ok: false, reason: 'too-large', count }
  return { ok: true, content: content.split(oldString).join(newString) }
}

/** Every old line removed, every new line added: always correct, and cheap to compute. */
function wholeFileChange(before, after) {
  const removed = splitLines(before).map(text => ({ type: 'remove', text }))
  const added = splitLines(after).map(text => ({ type: 'add', text }))
  return {
    added: added.length,
    removed: removed.length,
    isWholeFile: true,
    hunks: [{ header: `@@ -1,${removed.length} +1,${added.length} @@`, lines: [...removed, ...added] }]
  }
}

/**
 * What changes between `before` (null for a file that does not exist yet) and `after`:
 * hunks of typed lines, and how many lines are added and removed.
 * `maxEditLength` is for tests; in use only the time limit applies.
 */
function describeChange(before, after, { timeoutMs = DIFF_TIMEOUT_MS, maxEditLength } = {}) {
  const from = before === null ? '' : before
  const limits = maxEditLength === undefined ? { timeout: timeoutMs } : { timeout: timeoutMs, maxEditLength }
  const patch = structuredPatch('before', 'after', from, after, '', '', { context: CONTEXT_LINES, ...limits })
  if (!patch) return wholeFileChange(from, after)
  const hunks = patch.hunks.map(hunk => ({
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    lines: hunk.lines.map(line => ({ type: LINE_TYPES[line[0]] || 'context', text: line.slice(1) }))
  }))
  const count = (type) => hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.type === type).length, 0)
  return { added: count('add'), removed: count('remove'), hunks }
}

const MARKS = { add: '+', remove: '-', context: ' ', note: '\\' }

/** The hunks as plain diff text, for the activity view. */
function toUnifiedText(hunks) {
  return hunks.map(hunk => [hunk.header, ...hunk.lines.map(line => MARKS[line.type] + line.text), ''].join('\n')).join('')
}

module.exports = { applyEdit, describeChange, toUnifiedText, countLines }
