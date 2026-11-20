// What the chat view draws (components/AgentChat): items built from an agent's transcript lines.
// Only these fields reach the window, each clipped: tool output can be huge and may hold secrets
// (the view shows what the terminal showed, nothing is written to disk).
//
// item: { id, kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice', time, text?, tool? }
// tool: { name, summary, input, result?, isError?, diff?: string[], todos?: { text, status }[] }

const LIMITS = {
  text: 100_000,
  thinking: 20_000,
  input: 8_000,
  result: 64_000,
  summary: 200,
  diffLines: 400,
  todos: 50
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? text.slice(0, max) + '\n…' : text
}

const oneLine = (text, max = LIMITS.summary) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max) + '…' : line
}

const timeOf = value => {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

const text = value => (typeof value === 'string' ? value : '')

/** A tool's input for the card: the text itself when it is one string, else readable JSON */
function inputText(input) {
  if (typeof input === 'string') return clip(input, LIMITS.input)
  try { return clip(JSON.stringify(input ?? {}, null, 2), LIMITS.input) } catch { return '' }
}

// MCP tools answer with JSON in one line: its texts' line breaks showed as \n and the card was a wall
// of text (2026-11-20 user report). Shown instead as an indented outline, each text with its own lines.
const MAX_OUTLINE_DEPTH = 16
const isFilled = value => value !== null && typeof value === 'object' && Object.keys(value).length > 0
const indent = lines => lines.map(line => (line ? '  ' + line : ''))

function scalarText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && !value.length) return '[]'
  if (value !== null && typeof value === 'object' && !Object.keys(value).length) return '{}'
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

/** One entry: `key:` or `-` (a list item), then its value on the same line or indented below */
function entryLines(label, value, depth) {
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    return [`${label} |`, ...indent(value.replace(/\r\n?/g, '\n').split('\n'))]
  }
  if (isFilled(value) && depth < MAX_OUTLINE_DEPTH) {
    const inner = outlineLines(value, depth + 1)
    return label === '-' ? [`- ${inner[0]}`, ...indent(inner.slice(1))] : [label, ...indent(inner)]
  }
  return [`${label} ${scalarText(value)}`]
}

function outlineLines(value, depth) {
  return Array.isArray(value)
    ? value.flatMap(entry => entryLines('-', entry, depth))
    : Object.entries(value).flatMap(([key, entry]) => entryLines(`${key}:`, entry, depth))
}

/** A JSON value as indented lines (a filled object or list), or as one line */
function readableValue(value) {
  return isFilled(value) ? outlineLines(value, 0).join('\n') : scalarText(value)
}

/** An MCP answer: a whole JSON object or list becomes an outline, anything else stays as it is */
function readableOutput(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[[{]/.test(trimmed)) return raw
  try {
    const value = JSON.parse(trimmed)
    return isFilled(value) ? readableValue(value) : raw
  } catch {
    return raw
  }
}

/** Output blocks as text: a string, or [{ type: 'text' | 'input_text', text }] */
function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : block?.type === 'image' ? '[이미지]' : ''))
    .filter(Boolean)
    .join('\n')
}

function clipLines(lines) {
  return lines.length > LIMITS.diffLines ? [...lines.slice(0, LIMITS.diffLines), `… ${lines.length - LIMITS.diffLines}줄 더`] : lines
}

/** Lines of a unified diff text, or of a new file's content (every line added) */
function diffFromText(diff) {
  return clipLines(text(diff).replace(/\r\n/g, '\n').split('\n').filter((line, index, all) => line || index < all.length - 1))
}

const addedLines = content => clipLines(text(content).replace(/\r\n/g, '\n').split('\n').map(line => '+' + line))

function todosOf(list, textKey, statusKey = 'status') {
  if (!Array.isArray(list)) return undefined
  return list.slice(0, LIMITS.todos).flatMap(entry => {
    const label = text(entry?.[textKey]).trim()
    return label ? [{ text: oneLine(label), status: ['completed', 'in_progress', 'pending'].includes(entry?.[statusKey]) ? entry[statusKey] : 'pending' }] : []
  })
}

module.exports = { LIMITS, clip, oneLine, timeOf, text, inputText, blocksText, diffFromText, addedLines, clipLines, todosOf, readableOutput, readableValue }
