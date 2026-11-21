const { createTurnUsage } = require('./turnUsage.js')
const { codexUsageFromTokenCount } = require('../ipc/agentUsage.js')
const { LIMITS, clip, oneLine, timeOf, text, inputText, blocksText, diffFromText, addedLines, clipLines, readableOutput, readableValue } = require('./items.js')

// Codex's `rollout-*.jsonl`. Since `item_completed` events (Codex 0.1xx), each finished thing is one
// item there: UserMessage, AgentMessage, CommandExecution, FileChange, McpToolCall, Plan... The
// `response_item` lines repeat them with injected context mixed into user messages, so only the items
// are read. Older Codex without these events shows nothing yet (stage 1).

const joinText = (content, types) => (Array.isArray(content)
  ? content.filter(block => types.includes(block?.type) && typeof block.text === 'string').map(block => block.text).join('\n').trim()
  : '')

/** Some Codex delegation fields contain an opaque encrypted token instead of display text. */
function visibleCodexText(value) {
  const content = text(value).trim()
  return /^gAAAA[A-Za-z0-9_-]{65,}={0,2}$/.test(content) ? '' : content
}

/** The command Codex ran: its argv is often [shell, -Command/-lc, script], so the script is what matters */
function commandText(command) {
  if (typeof command === 'string') return command
  if (!Array.isArray(command)) return ''
  const parts = command.filter(part => typeof part === 'string')
  return parts.length >= 3 && /^-(?:c|lc|Command)$/i.test(parts[parts.length - 2]) ? parts[parts.length - 1] : parts.join(' ')
}

/** FileChange.changes: { [path]: { type: 'add' | 'update' | 'delete', content?, unified_diff? } } */
function fileChange(changes) {
  if (!changes || typeof changes !== 'object') return { paths: [], diff: undefined }
  const entries = Array.isArray(changes)
    ? changes.map(change => [text(change?.path), change])
    : Object.entries(changes)
  const lines = []
  for (const [file, change] of entries) {
    lines.push(`*** ${change?.type === 'add' ? '새 파일' : change?.type === 'delete' ? '삭제' : '수정'}: ${file}`)
    if (typeof change?.unified_diff === 'string') lines.push(...diffFromText(change.unified_diff))
    else if (change?.type === 'add' && typeof change.content === 'string') lines.push(...addedLines(change.content))
    if (lines.length > LIMITS.diffLines) break
  }
  return { paths: entries.map(([file]) => file), diff: lines.length ? clipLines(lines) : undefined }
}

function createCodexParser() {
  const turns = createTurnUsage()

  function feed(line, { older = false } = {}) {
    const out = []
    if (!line || typeof line !== 'object') return { items: out }
    const time = timeOf(line.timestamp)
    const payload = line.payload
    if (line.type === 'event_msg' && payload?.type === 'turn_aborted') {
      out.push({ id: `notice:${payload.turn_id ?? time}`, kind: 'notice', time, text: '중지했습니다' })
    }
    // What a model call cost: `last_token_usage`, keyed by the running total (an event can come twice)
    if (line.type === 'event_msg' && payload?.type === 'token_count' && payload.info?.last_token_usage) {
      const last = payload.info.last_token_usage
      const key = payload.info.total_token_usage?.total_tokens ?? `${time}:${last.total_tokens}`
      // The account's windows after this call (its 5-hour and weekly percent)
      turns.limits(codexUsageFromTokenCount(payload), { older })
      const owner = turns.add(key, { input: last.input_tokens, cached: last.cached_input_tokens, output: last.output_tokens }, { older, at: time })
      if (owner) out.push(owner)
      return { items: out }
    }
    if (line.type === 'event_msg' && payload?.type === 'task_complete') {
      const owner = turns.duration(payload.duration_ms, { older })
      if (owner) out.push(owner)
      return { items: out }
    }
    if (line.type !== 'event_msg' || payload?.type !== 'item_completed' || !payload.item) return { items: out }
    const item = payload.item
    const id = `${item.type}:${text(item.id) || time}`
    switch (item.type) {
      case 'UserMessage': {
        const said = joinText(item.content, ['text'])
        if (said) {
          const user = { id, kind: 'user', time, text: clip(said, LIMITS.text) }
          turns.start(user, { older })
          out.push(user)
        }
        break
      }
      case 'AgentMessage': {
        const said = joinText(item.content, ['Text', 'text'])
        if (said) out.push({ id, kind: 'assistant', time, text: clip(said, LIMITS.text) })
        break
      }
      case 'Plan':
        if (text(item.text).trim()) out.push({ id, kind: 'assistant', time, text: clip(item.text, LIMITS.text) })
        break
      case 'CommandExecution': {
        const command = commandText(item.command)
        out.push({
          id, kind: 'tool', time,
          tool: {
            name: '명령',
            summary: oneLine(command),
            input: clip(command, LIMITS.input),
            result: clip(text(item.aggregated_output), LIMITS.result),
            ...(typeof item.exit_code === 'number' && item.exit_code !== 0 ? { isError: true } : {})
          }
        })
        break
      }
      case 'FileChange': {
        const { paths, diff } = fileChange(item.changes)
        out.push({
          id, kind: 'tool', time,
          tool: {
            name: '파일 수정',
            summary: oneLine(paths.join(', ')),
            input: '',
            ...(diff ? { diff } : {}),
            ...(item.status && item.status !== 'completed' ? { isError: true, result: clip(text(item.stderr), LIMITS.result) } : {})
          }
        })
        break
      }
      case 'McpToolCall': {
        const name = [text(item.server), text(item.tool)].filter(Boolean).join('.') || 'MCP'
        out.push({
          id, kind: 'tool', time,
          tool: {
            name,
            summary: oneLine(Object.values(item.arguments ?? {}).find(value => typeof value === 'string') ?? ''),
            // MCP arguments and answers are JSON: shown as an outline with the texts' own lines
            input: clip(readableValue(item.arguments ?? {}), LIMITS.input),
            result: clip(readableOutput(blocksText(item.result?.content)), LIMITS.result),
            ...(item.status && item.status !== 'completed' ? { isError: true } : {})
          }
        })
        break
      }
      case 'ContextCompaction':
        out.push({ id, kind: 'notice', time, text: '이전 대화를 요약했습니다' })
        break
      default:
        break
    }
    return { items: out }
  }

  return { feed, beginOlder: turns.beginOlder, endOlder: turns.endOlder }
}

module.exports = { createCodexParser, commandText, fileChange, visibleCodexText }
