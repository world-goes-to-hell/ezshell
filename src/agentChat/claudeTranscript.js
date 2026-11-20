const { promptText } = require('../agentHistory/claude.js')
const { LIMITS, clip, oneLine, timeOf, text, inputText, blocksText, clipLines, addedLines, todosOf, readableOutput, readableValue } = require('./items.js')

// An MCP tool (`mcp__<server>__<tool>`): its arguments and answer are JSON, shown as an outline
const isMcpTool = name => name.startsWith('mcp__')

// Claude Code's `<session id>.jsonl`, line by line (checked on this PC's transcripts, 2026-11-19):
// an `assistant` line holds one content block (text, thinking or tool_use); blocks of one answer share
// `message.id`. A `user` line is the typed prompt or tool results (`tool_use_id`, the edit in
// `toolUseResult`). Many other kinds (attachment, api-request, file-history, mode...) are not for the
// view: only the kinds below are read, so a new kind in a later CLI is skipped, not misdrawn.

const INTERRUPTED = /^\[Request interrupted by user/
// A slash command the user ran, as Claude records it once the command has finished:
// "<command-name>/compact</command-name> <command-message>compact</command-message> <command-args></command-args>"
const COMMAND_NAME = /^\s*<command-name>(\/[^<\s]{1,60})<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/** The slash command of a user line as the user typed it ("/compact focus on X"), or null */
function commandText(line) {
  const content = line.message?.content
  if (line.isMeta || typeof content !== 'string') return null
  const name = COMMAND_NAME.exec(content)
  if (!name) return null
  const args = COMMAND_ARGS.exec(content)?.[1]?.trim()
  return args ? `${name[1]} ${args}` : name[1]
}

function toolSummary(name, input) {
  const value = input && typeof input === 'object' ? input : {}
  const first = key => text(value[key])
  switch (name) {
    case 'Bash': return oneLine(first('command'))
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return oneLine(first('file_path') || first('notebook_path'))
    case 'Grep': case 'Glob': return oneLine(first('pattern'))
    case 'WebFetch': return oneLine(first('url'))
    case 'WebSearch': return oneLine(first('query'))
    case 'Task': case 'Agent': return oneLine(first('description'))
    case 'TodoWrite': return Array.isArray(value.todos) ? `${value.todos.length}개 항목` : ''
    default: {
      const firstText = Object.values(value).find(item => typeof item === 'string')
      return oneLine(firstText ?? '')
    }
  }
}

/** The edit a tool made, as diff lines: Claude puts it in the result line's `toolUseResult` */
function diffOf(result) {
  if (!result || typeof result !== 'object') return undefined
  if (Array.isArray(result.structuredPatch) && result.structuredPatch.length) {
    const lines = []
    for (const hunk of result.structuredPatch) {
      lines.push(`@@ -${hunk?.oldStart ?? 0},${hunk?.oldLines ?? 0} +${hunk?.newStart ?? 0},${hunk?.newLines ?? 0} @@`)
      if (Array.isArray(hunk?.lines)) lines.push(...hunk.lines.filter(line => typeof line === 'string'))
      if (lines.length > LIMITS.diffLines) break
    }
    return clipLines(lines)
  }
  if (result.type === 'create' && typeof result.content === 'string') return addedLines(result.content)
  return undefined
}

/** Keeps a map from growing without end: the oldest entries go first */
function remember(map, key, value, max = 5000) {
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
}

function createClaudeParser() {
  /** tool_use id → its item (a result comes on a later line) */
  const tools = new Map()
  /** results whose tool_use is not read yet (reading older parts of the file goes backwards) */
  const orphans = new Map()
  let name = null
  let aiTitle = null
  // A compaction's notice, held until the next shown item: Claude writes the boundary first and the
  // `/compact` that asked for it last, so the notice follows that command (it came first: user report,
  // 2026-11-20); after an automatic compaction it goes before whatever comes next
  let pendingNotice = null
  let heldAt = 0

  function attach(item, result) {
    item.tool.result = isMcpTool(item.tool.name) ? clip(readableOutput(result.result), LIMITS.result) : result.result
    if (result.isError) item.tool.isError = true
    if (result.diff) item.tool.diff = result.diff
  }

  /**
   * Items made or changed by one line, and the title when the line names the conversation. `older`:
   * a line from before what was read (its title is not the latest).
   */
  function feed(line, { older = false } = {}) {
    const out = []
    if (!line || typeof line !== 'object' || line.isSidechain) return { items: out }
    const time = timeOf(line.timestamp)
    if (!older && line.type === 'agent-name' && text(line.agentName).trim()) name = oneLine(line.agentName)
    if (!older && line.type === 'ai-title' && text(line.aiTitle).trim()) aiTitle = oneLine(line.aiTitle)
    if (line.type === 'system' && line.subtype === 'compact_boundary') {
      if (pendingNotice) out.push(pendingNotice)
      pendingNotice = { id: `notice:${line.uuid ?? time}`, kind: 'notice', time, text: '이전 대화를 요약했습니다' }
      heldAt = Date.now()
      return finish(out)
    }
    if (line.type === 'assistant' && Array.isArray(line.message?.content)) {
      line.message.content.forEach((block, index) => {
        const id = `${line.uuid ?? line.message.id}:${index}`
        if (block?.type === 'text' && text(block.text).trim()) {
          out.push({ id, kind: 'assistant', time, text: clip(block.text, LIMITS.text) })
        } else if (block?.type === 'thinking' && text(block.thinking).trim()) {
          out.push({ id, kind: 'thinking', time, text: clip(block.thinking, LIMITS.thinking) })
        } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const toolName = text(block.name) || '도구'
          const item = {
            id: `tool:${block.id}`,
            kind: 'tool',
            time,
            tool: {
              name: toolName,
              summary: toolSummary(toolName, block.input),
              input: toolName === 'TodoWrite' ? ''
                : isMcpTool(toolName) ? clip(readableValue(block.input ?? {}), LIMITS.input)
                  : inputText(toolName === 'Bash' ? text(block.input?.command) : block.input),
              ...(toolName === 'TodoWrite' ? { todos: todosOf(block.input?.todos, 'content') } : {})
            }
          }
          const early = orphans.get(block.id)
          if (early) { attach(item, early); orphans.delete(block.id) }
          remember(tools, block.id, item)
          out.push(item)
        }
      })
    }
    if (line.type === 'user') {
      const command = commandText(line)
      if (line.isCompactSummary) {
        // The summary that follows a compact boundary: the boundary's notice already says it (once, not twice)
      } else if (command) {
        out.push({ id: `user:${line.uuid ?? time}`, kind: 'user', time, text: clip(command, LIMITS.text) })
      } else {
        const prompt = promptText(line)
        if (prompt !== null) {
          out.push(INTERRUPTED.test(prompt)
            ? { id: `notice:${line.uuid ?? time}`, kind: 'notice', time, text: '중지했습니다' }
            : { id: `user:${line.uuid ?? time}`, kind: 'user', time, text: clip(prompt, LIMITS.text) })
        }
        const content = line.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            const result = {
              result: clip(blocksText(block.content), LIMITS.result),
              isError: block.is_error === true,
              diff: diffOf(line.toolUseResult)
            }
            const item = tools.get(block.tool_use_id)
            if (item) { attach(item, result); out.push(item) } else remember(orphans, block.tool_use_id, result, 500)
          }
        }
      }
    }
    return finish(out, commandText(line))
  }

  /** The line's items with a held compaction notice put in place, and the title */
  function finish(out, command = null) {
    let items = out
    if (pendingNotice && out.length) {
      items = command && /^\/compact\b/.test(command) ? [...out, pendingNotice] : [pendingNotice, ...out]
      pendingNotice = null
    }
    const title = name ?? aiTitle
    return title ? { items, title } : { items }
  }

  /**
   * The held compaction notice once nothing came after it for `waitMs` (the file ends at the boundary, or
   * the command line is late): [] or [notice]. A first read of the file passes 0.
   */
  function flush(waitMs = 0) {
    if (!pendingNotice || Date.now() - heldAt < waitMs) return []
    const notice = pendingNotice
    pendingNotice = null
    return [notice]
  }

  return { feed, flush }
}

module.exports = { createClaudeParser, toolSummary, remember }
