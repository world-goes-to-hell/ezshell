const fs = require('fs/promises')
const path = require('path')
const { readLinesFromEnd } = require('../agentHistory/boundedRead.js')
const { dayFolders, sessionMeta } = require('../ipc/codexUsageWatcher.js')
const { commandText, visibleCodexText } = require('./codexTranscript.js')
const { blocksText, oneLine, text } = require('./items.js')

const MAX_ACTIVITY = 6
const MAX_SOURCES = 64
const TAIL_BYTES = 512 * 1024
const CLAUDE_CHILD_ID = /^[a-z0-9-]{1,80}$/i
const ROLLOUT = /^rollout-.+\.jsonl$/
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const entries = dir => fs.readdir(dir, { withFileTypes: true }).catch(() => [])

async function claudeSource(parent, child) {
  const dir = path.join(parent.slice(0, -'.jsonl'.length), 'subagents')
  const files = (await entries(dir)).filter(entry => entry.isFile()).map(entry => entry.name)
  const fileOf = id => files.includes(`agent-${id}.jsonl`) ? { file: path.join(dir, `agent-${id}.jsonl`) } : null
  for (const key of child.keys) {
    if (CLAUDE_CHILD_ID.test(key) && fileOf(key)) return fileOf(key)
  }
  // A foreground agent writes its metadata before a tool_result assigns its ID in the parent.
  for (const name of files.filter(name => /^agent-[a-z0-9-]{1,80}\.meta\.json$/i.test(name)).slice(-256)) {
    const file = path.join(dir, name)
    try {
      if ((await fs.stat(file)).size > 32_768) continue
      const meta = JSON.parse(await fs.readFile(file, 'utf8'))
      if (meta?.toolUseId === child.id) return fileOf(name.slice(6, -'.meta.json'.length))
    } catch { /* file is still being written or was removed */ }
  }
  return null
}

async function codexSource(parent, parentMeta, child) {
  if (!parentMeta?.id) return null
  const parentDir = path.dirname(parent)
  const root = path.resolve(parentDir, '..', '..', '..')
  const started = child.startedAt ?? Date.now()
  const dirs = new Set([...dayFolders(started, started).reverse().map(parts => path.join(root, ...parts)), parentDir])
  const thread = child.keys.find(key => UUID.test(key))?.toLowerCase()
  for (const dir of dirs) {
    const files = (await entries(dir)).filter(entry => entry.isFile() && ROLLOUT.test(entry.name)).map(entry => entry.name).sort().reverse()
    const candidates = thread ? files.filter(name => name.toLowerCase().endsWith(`${thread}.jsonl`)) : files.slice(0, 128)
    for (const name of candidates) {
      const file = path.join(dir, name)
      if (file === parent) continue
      const meta = await sessionMeta(file).catch(() => null)
      const spawn = (meta?.source?.subagent ?? meta?.source?.sub_agent)?.thread_spawn
      if (!meta || (meta.thread_source !== 'subagent' && !spawn)) continue
      if ((meta.parent_thread_id ?? spawn?.parent_thread_id) !== parentMeta.id) continue
      if (!child.keys.includes(meta.id) && !child.keys.includes(meta.agent_path ?? spawn?.agent_path)) continue
      return { file, meta }
    }
  }
  return null
}

function action(label, detail = '') {
  return { label: oneLine(label, 80), detail: oneLine(detail, 240) }
}

function claudeActivity(line) {
  if (line.type !== 'assistant' || !Array.isArray(line.message?.content)) return []
  return line.message.content.flatMap(block => {
    if (block?.type === 'text' && text(block.text).trim()) return [action('응답', block.text)]
    if (block?.type !== 'tool_use' || !text(block.name)) return []
    const input = block.input ?? {}
    const detail = text(input.description) || text(input.file_path) || text(input.query) || text(input.pattern)
      || (block.name === 'Bash' ? text(input.command) : '')
    return [action(block.name, detail)]
  })
}

function codexActivity(line) {
  const event = line.payload
  if (line.type === 'event_msg' && event?.type === 'item_completed') {
    const item = event.item
    if (item?.type === 'AgentMessage') return codexReply(item.content)
    if (item?.type === 'CommandExecution') return [action('명령 실행', commandText(item.command))]
    if (item?.type === 'FileChange') return [action('파일 수정', Object.keys(item.changes ?? {}).join(', '))]
    if (item?.type === 'McpToolCall') return [action([item.server, item.tool].filter(Boolean).join('.') || 'MCP')]
    if (item?.type === 'Plan' && visibleCodexText(item.text)) return [action('계획', item.text)]
    if (item?.type === 'WebSearch' || (item?.type === 'Extension' && item.kind === 'web.search')) {
      return [action('웹 검색', visibleCodexText(item.query) || visibleCodexText(item.action?.query) || visibleCodexText(item.action?.url))]
    }
  }
  if (line.type !== 'response_item') return []
  if (event?.type === 'message' && event.role === 'assistant') return codexReply(event.content)
  if ((event?.type === 'function_call' || event?.type === 'custom_tool_call') && text(event.name) && event.name !== 'wait') {
    return [event.name === 'exec' ? action('도구 실행') : action([event.namespace, event.name].filter(Boolean).join('.'))]
  }
  return []
}

function codexReply(content) {
  const reply = visibleCodexText(blocksText(content))
  return reply ? [action('응답', reply)] : []
}

function activityOf(kind, lines, meta) {
  const start = meta?.subagent_history_start_ordinal
  // A fork may contain a physical copy of parent history. Only the child's own ordinals count.
  if (kind === 'codex' && meta?.forked_from_id && !Number.isInteger(start)) return []
  const activity = []
  for (let index = lines.length - 1; index >= 0 && activity.length < MAX_ACTIVITY; index--) {
    const line = lines[index]
    if (kind === 'codex' && Number.isInteger(start) && !(line.ordinal >= start)) continue
    const items = kind === 'claude' ? claudeActivity(line) : codexActivity(line)
    for (const item of items.reverse()) {
      if (activity.some(entry => entry.label === item.label && entry.detail === item.detail)) continue
      activity.push(item)
      if (activity.length === MAX_ACTIVITY) break
    }
  }
  return activity
}

/** Read bounded, displayable activity on demand from the identified child, never from renderer paths. */
function createSubagentPreview(parent, kind, now = Date.now) {
  const sources = new Map()
  let parentMeta
  return function preview(child) {
    let entry = sources.get(child.id)
    if (!entry) {
      entry = { source: null, retryAt: 0, stamp: '', activity: [], pending: null }
      sources.set(child.id, entry)
      if (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value)
    }
    entry.pending ??= (async () => {
      if (!entry.source) {
        if (entry.retryAt > now()) return []
        const source = kind === 'claude' ? await claudeSource(parent, child)
          : await codexSource(parent, await (parentMeta ??= sessionMeta(parent)), child)
        if (!source) { entry.retryAt = now() + 1200; return [] }
        entry.source = source
      }
      const { file, meta } = entry.source
      const stat = await fs.stat(file)
      const stamp = `${stat.size}:${stat.mtimeMs}`
      if (entry.stamp !== stamp) {
        entry.activity = activityOf(kind, await readLinesFromEnd(file, { maxBytes: TAIL_BYTES }) ?? [], meta)
        entry.stamp = stamp
      }
      return entry.activity
    })().catch(() => {
      entry.source = null
      entry.stamp = ''
      parentMeta = undefined
      return []
    }).finally(() => { entry.pending = null })
    return entry.pending
  }
}

module.exports = { createSubagentPreview }
