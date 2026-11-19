const fs = require('fs')
const path = require('path')
const { readLinesFromStart, readLinesFromEnd } = require('./boundedRead.js')
const { LIMITS, isUuid, clip, oneLine, isoTime, textOrNull } = require('./common.js')

// Claude Code keeps one `<session id>.jsonl` per session in `projects/<folder name>/`. Folders next
// to them (`<session id>/subagents/...`) are sub-agent runs and are not sessions to resume.

/** Wrappers Claude Code puts around input that the user did not type as a prompt */
const NOT_A_PROMPT = /^<(command-|local-command|task-notification|system-reminder|user-prompt-submit-hook|bash-)/

async function listFiles(root) {
  const projects = path.join(root, 'projects')
  let folders
  try {
    folders = await fs.promises.readdir(projects, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const dir = path.join(projects, folder.name)
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && isUuid(entry.name.slice(0, -6))) {
        files.push(path.join(dir, entry.name))
      }
    }
  }
  return files
}

/** Text the user typed, or null for tool results, injected context and slash commands */
function promptText(line) {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return null
  const content = line.message?.content
  let text
  if (typeof content === 'string') text = content
  else if (Array.isArray(content) && content.length && content.every(block => block?.type === 'text' || block?.type === 'image')) {
    text = content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  } else return null
  const trimmed = text.trim()
  if (!trimmed || NOT_A_PROMPT.test(trimmed)) return null
  return trimmed.replace(/<\/?pasted_content[^>]*>/g, '').trim() || null
}

function replyText(line) {
  if (line.type !== 'assistant' || line.isSidechain || !Array.isArray(line.message?.content)) return null
  const text = line.message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim()
  return text || null
}

/** Reads the start for where and when, the end for the latest title, model and branch */
async function summarize(file) {
  const id = path.basename(file, '.jsonl')
  const head = { cwd: null, branch: null, version: null, created: null, prompt: null }
  await readLinesFromStart(file, line => {
    head.cwd ??= textOrNull(line.cwd)
    head.branch ??= textOrNull(line.gitBranch)
    head.version ??= textOrNull(line.version)
    head.created ??= isoTime(line.timestamp)
    head.prompt ??= promptText(line)
    return Boolean(head.cwd && head.created && head.prompt)
  })
  const tail = (await readLinesFromEnd(file, { maxBytes: 64 * 1024 })) ?? []
  let named = null
  let aiTitle = null
  let model = null
  let branch = null
  // A long session can start with tool output and slash commands for many MB (a continued session
  // did: 24MB). Then the latest prompt from the end stands in for the first one.
  let lastPrompt = null
  for (const line of tail) {
    lastPrompt = promptText(line) ?? lastPrompt
    if (line.type === 'agent-name') named = textOrNull(line.agentName) ?? named
    if (line.type === 'ai-title') aiTitle = textOrNull(line.aiTitle) ?? aiTitle
    if (line.type === 'assistant' && !line.isSidechain) model = textOrNull(line.message?.model) ?? model
    branch = textOrNull(line.gitBranch) ?? branch
  }
  if (!head.prompt && !lastPrompt) {
    // Tool output after the last prompt can be hundreds of KB; look further only for such sessions
    for (const line of (await readLinesFromEnd(file, { maxBytes: 1024 * 1024 })) ?? []) lastPrompt = promptText(line) ?? lastPrompt
  }
  return {
    agent: 'claude',
    id,
    cwd: head.cwd,
    branch: branch ?? head.branch,
    model: model === '<synthetic>' ? null : model,
    version: head.version,
    title: oneLine(named ?? aiTitle ?? head.prompt ?? lastPrompt ?? '', LIMITS.title),
    preview: oneLine(head.prompt ?? lastPrompt ?? '', LIMITS.preview),
    hasPrompt: Boolean(head.prompt ?? lastPrompt),
    created: head.created
  }
}

async function detail(file) {
  let firstPrompt = null
  await readLinesFromStart(file, line => {
    firstPrompt = promptText(line)
    return firstPrompt !== null
  })
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

module.exports = { listFiles, summarize, detail, promptText, replyText }
