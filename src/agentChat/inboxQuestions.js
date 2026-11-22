const { blocksText, clip, timeOf, text: stringOf } = require('./items.js')

const servers = ['ezshell-cli-mcp', 'ezshell_agent']
const isClaudeInboxTool = name => servers.some(server => name === `mcp__${server}__read_inbox`)
const isCodexInboxTool = (server, tool) => tool === 'read_inbox' && servers.includes(server)
const senderId = /^(codex|claude)-\d+$/

function inboxMessages(content) {
  let data
  try { data = JSON.parse(blocksText(content)) } catch { return [] }
  if (!Array.isArray(data?.messages)) return []
  return data.messages.flatMap(message => {
    const { id, from, text, replyTo, receipt } = message ?? {}
    if (typeof id !== 'string' || !id || id.length > 140 || typeof from !== 'string' || !senderId.test(from)
      || receipt === true || typeof text !== 'string' || !text.trim()) return []
    return [{ id: `inbox:${id}`, text: clip(text, 8000), sender: from, ...(replyTo ? { isReply: true } : {}) }]
  })
}

/** Match Claude's split calls and results while the question index scans the transcript. */
function createInboxQuestionReader(kind) {
  const calls = new Map()
  return (line, offset, bytes) => {
    const time = timeOf(line.timestamp)
    if (kind === 'codex') {
      const item = line.type === 'event_msg' && line.payload?.type === 'item_completed' ? line.payload.item : null
      if (item?.type !== 'McpToolCall' || !isCodexInboxTool(item.server, item.tool)
        || item.result?.isError || (item.status && item.status !== 'completed')) return []
      const itemId = `McpToolCall:${stringOf(item.id) || time}`
      return inboxMessages(item.result?.content).map(message => ({ ...message, time, itemId }))
    }
    const blocks = line.message?.content
    if (line.isSidechain || !Array.isArray(blocks)) return []
    if (line.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type === 'tool_use' && typeof block.id === 'string' && isClaudeInboxTool(block.name)) {
          calls.set(block.id, { offset, bytes })
          if (calls.size > 5000) calls.delete(calls.keys().next().value)
        }
      }
    }
    if (line.type !== 'user') return []
    return blocks.flatMap(block => {
      if (block?.type !== 'tool_result' || block.is_error) return []
      const call = calls.get(block.tool_use_id)
      if (!call) return []
      return inboxMessages(block.content).map(message => ({ ...message, time, itemId: `tool:${block.tool_use_id}`, call }))
    })
  }
}

module.exports = { createInboxQuestionReader, isClaudeInboxTool, isCodexInboxTool }
