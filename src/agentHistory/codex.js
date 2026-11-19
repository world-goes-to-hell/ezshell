const fs = require('fs')
const path = require('path')
const { readLinesFromStart, readLinesFromEnd } = require('./boundedRead.js')
const { LIMITS, isUuid, clip, oneLine, isoTime, textOrNull } = require('./common.js')

// Codex writes `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` and later compresses older ones to
// `.jsonl.zst`. The first line (`session_meta`) has the id, folder and git branch. Names the user
// gave sessions are in `session_index.jsonl`.
const ROLLOUT = /^rollout-.+\.jsonl(\.zst)?$/
const DIGITS = /^\d+$/
const MAX_INDEX_BYTES = 4 * 1024 * 1024

async function subfolders(dir) {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && DIGITS.test(entry.name))
      .map(entry => path.join(dir, entry.name))
  } catch {
    return []
  }
}

async function listFiles(root) {
  const files = []
  for (const year of await subfolders(path.join(root, 'sessions'))) {
    for (const month of await subfolders(year)) {
      for (const day of await subfolders(month)) {
        let entries
        try {
          entries = await fs.promises.readdir(day, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry.isFile() && ROLLOUT.test(entry.name)) files.push(path.join(day, entry.name))
        }
      }
    }
  }
  return files
}

/** id → the latest name, from `session_index.jsonl` (later lines win) */
async function readThreadNames(root) {
  const names = new Map()
  const file = path.join(root, 'session_index.jsonl')
  try {
    const { size } = await fs.promises.stat(file)
    if (size > MAX_INDEX_BYTES) return names
    for (const line of (await fs.promises.readFile(file, 'utf8')).split('\n')) {
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        const name = textOrNull(entry?.thread_name)
        if (isUuid(entry?.id) && name) names.set(entry.id.toLowerCase(), name)
      } catch { /* a broken line does not hide the others */ }
    }
  } catch { /* no index */ }
  return names
}

const itemOf = line => (line.type === 'event_msg' && line.payload?.type === 'item_completed' ? line.payload.item : null)

const joinText = (content, types) => Array.isArray(content)
  ? content.filter(block => types.includes(block?.type) && typeof block.text === 'string').map(block => block.text).join('\n').trim()
  : ''

/** What the user typed. The `response_item` copies also carry injected context, so they are not used. */
function promptText(line) {
  const item = itemOf(line)
  if (item?.type !== 'UserMessage') return null
  return joinText(item.content, ['text']) || null
}

/**
 * Older Codex (before `item_completed`) has the prompt only in `response_item`, next to context the
 * CLI injects as user messages (`<environment_context>`, `# AGENTS.md instructions`, ...).
 */
function legacyPromptText(line) {
  const payload = line.type === 'response_item' ? line.payload : null
  if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return null
  const text = payload.content
    .filter(block => block?.type === 'input_text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(part => part && !part.startsWith('<') && !part.startsWith('#'))
    .join('\n')
  return text || null
}

function replyText(line) {
  const item = itemOf(line)
  if (item?.type !== 'AgentMessage') return null
  return joinText(item.content, ['Text', 'text']) || null
}

/** The title is from the first prompt; the caller puts the name from `readThreadNames` over it. */
async function summarize(file) {
  const head = { meta: null, model: null, prompt: null, legacy: null }
  await readLinesFromStart(file, line => {
    if (!head.meta && line.type === 'session_meta' && line.payload) head.meta = line.payload
    if (line.type === 'turn_context') head.model ??= textOrNull(line.payload?.model)
    head.prompt ??= promptText(line)
    head.legacy ??= legacyPromptText(line)
    return Boolean(head.meta && head.model && head.prompt)
  })
  const meta = head.meta ?? {}
  const id = isUuid(meta.id) ? meta.id.toLowerCase() : null
  if (!id) return null
  head.prompt ??= head.legacy
  return {
    agent: 'codex',
    id,
    cwd: textOrNull(meta.cwd),
    branch: textOrNull(meta.git?.branch),
    model: head.model,
    version: textOrNull(meta.cli_version),
    title: oneLine(head.prompt ?? '', LIMITS.title),
    preview: oneLine(head.prompt ?? '', LIMITS.preview),
    hasPrompt: Boolean(head.prompt),
    created: isoTime(meta.timestamp)
  }
}

async function detail(file) {
  let firstPrompt = null
  let legacy = null
  await readLinesFromStart(file, line => {
    firstPrompt = promptText(line)
    legacy ??= legacyPromptText(line)
    return firstPrompt !== null
  })
  firstPrompt ??= legacy
  const tail = await readLinesFromEnd(file)
  const turns = []
  for (const line of tail ?? []) {
    const prompt = promptText(line)
    const reply = prompt === null ? replyText(line) : null
    if (prompt === null && reply === null) continue
    turns.push({ role: prompt !== null ? 'user' : 'assistant', text: clip(prompt ?? reply, LIMITS.turn), time: isoTime(line.timestamp) })
  }
  return { firstPrompt: firstPrompt === null ? null : clip(firstPrompt, LIMITS.firstPrompt), turns: turns.slice(-LIMITS.turns), turnsUnavailable: tail === null }
}

module.exports = { listFiles, readThreadNames, summarize, detail, promptText, legacyPromptText, replyText }
