const { promptText } = require('../agentHistory/claude.js')
const { isInboxPrompt } = require('../ipc/agentInboxPrompts.js')
const { createTurnUsage } = require('./turnUsage.js')
const { isClaudeInboxTool } = require('./inboxQuestions.js')
const { ASK_TOOL, askQuestionsOf, askAnswersOf } = require('./askQuestions.js')
const { LIMITS, clip, oneLine, timeOf, text, inputText, blocksText, clipLines, addedLines, todosOf, readableOutput, readableValue } = require('./items.js')

// An MCP tool (`mcp__<server>__<tool>`): its arguments and answer are JSON, shown as an outline
const isMcpTool = name => name.startsWith('mcp__')

// Claude Code's `<session id>.jsonl`, line by line (checked on this PC's transcripts, 2026-11-19):
// an `assistant` line holds one content block (text, thinking or tool_use); blocks of one answer share
// `message.id`. A `user` line is the typed prompt or tool results (`tool_use_id`, the edit in
// `toolUseResult`). A message typed while Claude works is an `attachment` line (queuedPrompt). Many
// other kinds (other attachments, api-request, file-history, mode...) are not for the view: only the kinds below are read, so a new kind in a later CLI is skipped, not misdrawn.

const INTERRUPTED = /^\[Request interrupted by user/
// A slash command the user ran, as Claude records it once the command has finished:
// "<command-name>/compact</command-name> <command-message>compact</command-message> <command-args></command-args>"
const COMMAND_NAME = /^\s*<command-name>(\/[^<\s]{1,60})<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
// What a slash command printed, on the user line after the command (checked on this PC's transcripts,
// 2026-11-21): "<local-command-stdout>Set model to `Opus 5.5` …</local-command-stdout>", stderr on failure
const COMMAND_OUTPUT = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/
// The terminal colours Claude keeps in it ("\u001b[2mCompacted …\u001b[22m")
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g

/**
 * What the user typed while Claude was working, from the line that marks Claude reading it mid-turn
 * (`attachment.type: queued_command`, checked on this PC's transcripts, 2026-11-22), or null. The queue's
 * own `queue-operation` lines are only the waiting list. Task notifications and other agents' messages
 * arrive the same way with their own `origin`: those are not the user's words.
 */
function queuedPrompt(line) {
  const queued = line.attachment
  if (line.type !== 'attachment' || queued?.type !== 'queued_command' || queued.commandMode !== 'prompt') return null
  const origin = queued.origin?.kind
  if (origin !== undefined && origin !== 'human') return null
  const content = queued.prompt
  let body
  let hasImage = false
  if (typeof content === 'string') {
    body = content
  } else if (Array.isArray(content) && content.every(block => block?.type === 'text' || block?.type === 'image')) {
    body = content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    hasImage = content.some(block => block.type === 'image')
  } else return null
  const prompt = body.replace(/\r\n?/g, '\n').trim()
  // Before `origin` existed, a notification still started with its tag
  if (origin === undefined && prompt.startsWith('<')) return null
  return prompt || hasImage ? { prompt, hasImage } : null
}

/** A slash command's printed output as plain text, or null */
function commandOutput(line) {
  const content = line.message?.content
  if (line.isMeta || typeof content !== 'string') return null
  const match = COMMAND_OUTPUT.exec(content)
  if (!match) return null
  const output = match[2].replace(ANSI, '').replace(/\r\n?/g, '\n').trim()
  return output ? { text: output, isError: match[1] === 'stderr' } : null
}

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
  // The last slash command read: its output follows on the next user line
  let lastCommand = null
  const turns = createTurnUsage()

  function attach(item, result) {
    item.tool.result = isMcpTool(item.tool.name) ? clip(readableOutput(result.result), LIMITS.result) : result.result
    if (result.isError) item.tool.isError = true
    if (result.diff) item.tool.diff = result.diff
    if (item.tool.question) item.tool.answers = askAnswersOf(result.toolResult, item.tool.question.questions)
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
    if (line.type === 'system' && line.subtype === 'turn_duration') {
      const owner = turns.duration(line.durationMs, { older })
      if (owner) out.push(owner)
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
          // A question to the user: drawn as a card of its choices (the JSON input is not shown)
          const question = toolName === ASK_TOOL ? askQuestionsOf(block.input) : null
          const item = {
            id: `tool:${block.id}`,
            kind: 'tool',
            time,
            tool: {
              name: toolName,
              summary: toolSummary(toolName, block.input),
              input: toolName === 'TodoWrite' || question ? ''
                : isMcpTool(toolName) ? clip(readableValue(block.input ?? {}), LIMITS.input)
                  : inputText(toolName === 'Bash' ? text(block.input?.command) : block.input),
              ...(toolName === 'TodoWrite' ? { todos: todosOf(block.input?.todos, 'content') } : {}),
              ...(isClaudeInboxTool(toolName) ? { isInbox: true } : {}),
              ...(question ? { question } : {})
            }
          }
          const early = orphans.get(block.id)
          if (early) { attach(item, early); orphans.delete(block.id) }
          remember(tools, block.id, item)
          out.push(item)
        }
      })
      // What the answer cost: one message's usage is repeated on each of its block lines
      const usage = line.message.usage
      if (usage && typeof line.message.id === 'string') {
        const owner = turns.add(line.message.id, {
          input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
          cached: usage.cache_read_input_tokens ?? 0,
          output: usage.output_tokens ?? 0
        }, { older, at: time })
        if (owner) out.push(owner)
      }
    }
    const absorbed = queuedPrompt(line)
    if (absorbed !== null) {
      const { prompt, hasImage } = absorbed
      const item = {
        id: `user:${line.uuid ?? time}`, kind: 'user', time,
        ...(prompt ? { text: clip(prompt, LIMITS.text) } : {}),
        ...(hasImage ? { hasImage: true } : {}),
        ...(prompt && !hasImage && isInboxPrompt(prompt) ? { inboxNotice: true } : {})
      }
      turns.start(item, { older })
      out.push(item)
    }
    if (line.type === 'user') {
      const command = commandText(line)
      const output = commandOutput(line)
      if (line.isCompactSummary) {
        // The summary that follows a compact boundary: the boundary's notice already says it (once, not twice)
      } else if (output) {
        // /compact's own report ("Compacted …"): the boundary's notice says it
        const compacted = lastCommand ? /^\/compact\b/.test(lastCommand) : /^Compacted\b/.test(output.text)
        if (!compacted) {
          out.push({
            id: `output:${line.uuid ?? time}`, kind: 'output', time, text: clip(output.text, LIMITS.result),
            ...(output.isError ? { isError: true } : {})
          })
        }
        lastCommand = null
      } else if (command) {
        lastCommand = command
        const item = { id: `user:${line.uuid ?? time}`, kind: 'user', time, text: clip(command, LIMITS.text) }
        turns.start(item, { older })
        out.push(item)
      } else {
        const prompt = promptText(line)
        const content = line.message?.content
        const hasImage = Array.isArray(content) && content.some(block => block?.type === 'image')
        const imageOnly = !line.isMeta && hasImage && content.every(block => block?.type === 'image')
        if (prompt !== null && INTERRUPTED.test(prompt)) {
          out.push({ id: `notice:${line.uuid ?? time}`, kind: 'notice', time, text: '중지했습니다', interrupted: true })
        } else if (prompt !== null || imageOnly) {
          const item = {
            id: `user:${line.uuid ?? time}`, kind: 'user', time,
            ...(prompt !== null ? { text: clip(prompt, LIMITS.text) } : {}),
            ...(hasImage ? { hasImage: true } : {}),
            ...(prompt !== null && !hasImage && isInboxPrompt(prompt) ? { inboxNotice: true } : {})
          }
          turns.start(item, { older })
          out.push(item)
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            const result = {
              result: clip(blocksText(block.content), LIMITS.result),
              isError: block.is_error === true,
              diff: diffOf(line.toolUseResult),
              // Only an AskUserQuestion's answers are kept (an orphan result waits in memory)
              toolResult: line.toolUseResult?.answers ? { answers: line.toolUseResult.answers } : undefined
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

  /** The questions of an AskUserQuestion not answered yet (`tool:<id>`), or null */
  function question(itemId) {
    const item = typeof itemId === 'string' && itemId.startsWith('tool:') ? tools.get(itemId.slice(5)) : null
    return item?.tool.question && item.tool.result === undefined && !item.tool.isError ? item.tool.question : null
  }

  return { feed, flush, question, beginOlder: turns.beginOlder, endOlder: turns.endOlder }
}

module.exports = { createClaudeParser, toolSummary, remember }
