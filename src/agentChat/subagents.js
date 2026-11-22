const { blocksText, clip, oneLine, text, timeOf } = require('./items.js')
const { visibleCodexText } = require('./codexTranscript.js')

const MAX_AGENTS = 64
const MAX_CALLS = 128
const MAX_RESULT = 6000
const CLAUDE_STATUS = new Map([
  ['completed', 'completed'], ['failed', 'error'], ['error', 'error'], ['stopped', 'stopped']
])
const CODEX_STATUS = new Map([
  ['pending_init', 'starting'], ['running', 'running'], ['completed', 'completed'],
  ['errored', 'error'], ['interrupted', 'stopped'], ['shutdown', 'stopped'], ['not_found', 'unknown']
])

function remember(map, id, value, limit) {
  map.delete(id)
  map.set(id, value)
  if (map.size > limit) map.delete(map.keys().next().value)
}

function parseObject(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function codexStatus(value) {
  const [key, result] = typeof value === 'string' ? [value] : Object.entries(value ?? {})[0] ?? []
  return { status: CODEX_STATUS.get(key), result: visibleCodexText(result) }
}

const tag = (body, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? ''
const active = status => status === 'starting' || status === 'running'

// A tracker belongs to one parent transcript. Only tool calls and provider lifecycle records
// can create/update rows. Child transcript paths and raw tool arguments stay in the main process.
function createSubagentTracker(kind) {
  const agents = new Map()
  const calls = new Map()
  const aliases = new Map()
  const childResults = new Map()
  let dirty = false

  const idOf = id => aliases.get(id) ?? id
  const alias = (key, id) => {
    if (key && key !== id) remember(aliases, key, id, MAX_CALLS)
  }

  function update(id, time, { name, task, status, result } = {}) {
    if (!id) return
    const previous = agents.get(id)
    const changedTurn = active(status) && previous && !active(previous.status)
    const next = {
      id,
      name: oneLine(name, 80) || previous?.name || '',
      task: clip(text(task).trim(), 2400) || previous?.task || '',
      status: status ?? previous?.status ?? 'unknown',
      startedAt: changedTurn ? time : previous?.startedAt ?? (active(status) ? time : null),
      finishedAt: active(status) ? null : status && status !== previous?.status ? time : previous?.finishedAt ?? null,
      result: clip(text(result).trim(), MAX_RESULT) || (changedTurn ? '' : previous?.result ?? '')
    }
    if (previous && Object.keys(next).every(key => next[key] === previous[key])) return
    remember(agents, id, next, MAX_AGENTS)
    dirty = true
  }

  function claude(line, time) {
    if (line.isSidechain) return
    const content = line.message?.content
    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || (block.name !== 'Agent' && block.name !== 'Task') || !text(block.id)) continue
        const { input } = block
        if (!agents.has(block.id)) update(block.id, time, {
          name: text(input?.name) || text(input?.subagent_type),
          task: text(input?.description) || text(input?.prompt), status: 'running'
        })
      }
      return
    }
    if (line.type !== 'user') return
    if (Array.isArray(content)) {
      for (const block of content) {
        const id = block?.tool_use_id
        if (block?.type !== 'tool_result' || !agents.has(id)) continue
        const info = line.toolUseResult
        alias(text(info?.agentId), id)
        alias(text(info?.taskId), id)
        if (info?.isAsync === true || info?.status === 'async_launched') continue
        const status = block.is_error ? 'error' : CLAUDE_STATUS.get(info?.status) ?? 'completed'
        update(id, time, { status, result: blocksText(info?.content) || blocksText(block.content) })
      }
      return
    }
    if (typeof content !== 'string' || !content.trimStart().startsWith('<task-notification>')) return
    const body = tag(content, 'task-notification')
    const childId = tag(body, 'task-id')
    const id = tag(body, 'tool-use-id') || idOf(childId)
    const status = CLAUDE_STATUS.get(tag(body, 'status'))
    if (!agents.has(id) || !status) return
    const result = tag(body, 'result')
    update(id, time, { status, result: result || tag(body, 'summary') })
    // Some Claude versions write only a completion notice in the parent. Resolve the result
    // in the parent's own subagents directory using the recorded child ID, never output-file.
    if (status === 'completed' && !result && aliases.get(childId) === id && /^[a-z0-9-]{1,80}$/i.test(childId)) {
      remember(childResults, id, childId, MAX_AGENTS)
    }
  }

  function codexCommunication(content, time) {
    const match = /^\s*<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>\s*$/.exec(content)
    const payload = match && parseObject(match[1])
    const id = idOf(text(payload?.agent_path) || text(payload?.agent_id))
    const outcome = codexStatus(payload?.status)
    if (agents.has(id) && outcome.status) update(id, time, outcome)
  }

  function codexToolOutput(event, time) {
    const call = calls.get(event.call_id)
    if (!call) return
    const raw = typeof event.output === 'string' ? event.output : blocksText(event.output)
    const output = parseObject(raw)
    if (call.name === 'spawn_agent') {
      const key = text(output?.agent_id) || text(output?.task_name)
      if (!key) return
      const id = call.agentId || idOf(key)
      call.agentId = id
      alias(key, id)
      const previous = agents.get(id)
      update(id, time, {
        name: text(output.nickname) || call.label || text(output.task_name).split('/').filter(Boolean).at(-1),
        task: call.task, status: !previous || previous.status === 'starting' ? 'running' : undefined
      })
    } else if (call.name === 'wait_agent') {
      for (const [key, value] of Object.entries(output?.status ?? {})) {
        const id = idOf(key)
        const outcome = codexStatus(value)
        if (agents.has(id) && outcome.status && outcome.status !== 'unknown') update(id, time, outcome)
      }
    }
  }

  function codexActivity(event, time) {
    const key = text(event.agent_path)
    const thread = text(event.agent_thread_id)
    const id = aliases.get(thread) || aliases.get(key) || (agents.has(key) ? key : thread || key)
    if (!id) return
    alias(thread, id)
    alias(key, id)
    const name = key.split('/').filter(Boolean).at(-1)
    if (event.kind === 'started') update(id, time, { name, status: 'running' })
    if (event.kind === 'completed' && !['error', 'stopped'].includes(agents.get(id)?.status)) update(id, time, { name, status: 'completed' })
    if (event.kind === 'interrupted') update(id, time, { name, status: 'stopped' })
  }

  function codexCall(item, time) {
    const spawn = item.tool === 'spawn_agent'
    const call = calls.get(item.id)
    if (spawn && item.status === 'failed' && !item.receiver_thread_ids?.length) {
      update(`call:${item.id}`, time, { name: call?.label, task: visibleCodexText(item.prompt) || call?.task, status: 'error' })
      return
    }
    for (const thread of item.receiver_thread_ids ?? []) {
      const id = spawn && call?.agentId ? call.agentId : idOf(thread)
      const ref = item.receiver_agents?.find(agent => agent.thread_id === thread)
      const outcome = codexStatus(item.agents_states?.[thread])
      const previous = agents.get(id)
      if (spawn && call) {
        call.agentId = id
        alias(thread, id)
      }
      if (!spawn && !previous) continue
      if (item.tool === 'close_agent' && active(outcome.status)) outcome.status = 'stopped'
      if (spawn && active(outcome.status) && previous && previous.status !== 'starting') outcome.status = undefined
      if (item.tool === 'close_agent' && previous?.status === 'completed' && outcome.status === 'stopped') continue
      if (outcome.status !== 'unknown') update(id, time, {
        name: text(ref?.agent_nickname) || text(ref?.agent_role) || call?.label,
        task: spawn ? visibleCodexText(item.prompt) || call?.task : undefined,
        ...outcome
      })
    }
  }

  function codex(line, time) {
    const event = line.payload
    if (!event || typeof event !== 'object') return
    if (line.type === 'inter_agent_communication') {
      codexCommunication(text(event.content), time)
    } else if (line.type === 'response_item') {
      if (event.type === 'function_call' && text(event.call_id) && ['spawn_agent', 'wait_agent'].includes(event.name)) {
        const args = parseObject(event.arguments)
        remember(calls, event.call_id, { name: event.name, label: text(args?.task_name) || text(args?.agent_type), task: visibleCodexText(args?.message) }, MAX_CALLS)
      } else if (event.type === 'function_call_output') {
        codexToolOutput(event, time)
      } else if (event.type === 'message' && event.role === 'user') {
        codexCommunication(blocksText(event.content), time)
      }
    } else if (line.type === 'event_msg') {
      if (event.type === 'sub_agent_activity') codexActivity(event, time)
      if (event.type !== 'item_completed') return
      if (event.item?.type === 'SubAgentActivity') codexActivity(event.item, time)
      if (event.item?.type === 'CollabAgentToolCall') codexCall(event.item, time)
    }
  }

  return {
    childOf(id) {
      const agent = agents.get(id)
      if (!agent) return null
      const siblings = [...agents.values()].filter(other => other.id !== id)
      return { id, startedAt: agent.startedAt, name: agent.name, task: agent.task,
        uniqueTask: !siblings.some(other => other.task === agent.task),
        uniqueName: !siblings.some(other => other.name === agent.name),
        keys: [id, ...[...aliases].filter(([, associated]) => associated === id).map(([key]) => key)] }
    },
    feed(line) {
      if (kind === 'claude') claude(line, timeOf(line.timestamp))
      else codex(line, timeOf(line.timestamp))
    },
    snapshot(force = false) {
      if (!dirty && !force) return undefined
      dirty = false
      return [...agents.values()].reverse()
    },
    takeChildResults() {
      const pending = [...childResults]
      childResults.clear()
      return pending
    },
    setChildResult(id, result) {
      if (agents.get(id)?.status === 'completed') update(id, null, { result })
    }
  }
}

module.exports = { createSubagentTracker }
