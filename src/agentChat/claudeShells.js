const { remember } = require('./claudeTranscript.js')
const { clip, oneLine, text } = require('./items.js')

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell'])
const FINISHED = new Set(['completed', 'failed', 'error', 'stopped', 'killed', 'cancelled', 'canceled'])
const MAX_CALLS = 256
const MAX_SHELLS = 64
const tag = (body, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1].trim() ?? ''

function createClaudeShellTracker() {
  const calls = new Map()
  const running = new Map()
  const finished = new Map()

  function feed(line) {
    if (!line || line.isSidechain) return
    const content = line.message?.content
    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || !SHELL_TOOLS.has(block.name) || !text(block.id)) continue
        const command = clip(text(block.input?.command).trim(), 1400)
        const description = oneLine(text(block.input?.description), 140)
        if (command || description) remember(calls, block.id, { command, description }, MAX_CALLS)
      }
      return
    }
    if (line.type === 'user' && Array.isArray(content)) {
      const id = text(line.toolUseResult?.backgroundTaskId)
      if (!id || finished.has(id)) return
      for (const block of content) {
        if (block?.type !== 'tool_result' || block.is_error || finished.has(block.tool_use_id)) continue
        const call = calls.get(block.tool_use_id)
        if (call) {
          remember(running, id, { id, toolUseId: block.tool_use_id, ...call }, MAX_SHELLS)
          break
        }
      }
      return
    }
    const message = line.type === 'user' ? content
      : line.type === 'attachment' && line.attachment?.type === 'queued_command' ? line.attachment.prompt : null
    const body = /^\s*<task-notification>([\s\S]*?)<\/task-notification>/u.exec(text(message))?.[1]
    if (!body || !FINISHED.has(tag(body, 'status'))) return
    const id = tag(body, 'task-id')
    const toolUseId = tag(body, 'tool-use-id')
    if (id) {
      remember(finished, id, true, MAX_CALLS)
      running.delete(id)
    }
    if (toolUseId) {
      remember(finished, toolUseId, true, MAX_CALLS)
      for (const job of running.values()) {
        if (job.toolUseId === toolUseId) running.delete(job.id)
      }
    }
  }

  return { feed, running: () => [...running.values()].map(({ id, command, description }) => ({ id, command, description })) }
}

module.exports = { createClaudeShellTracker }
