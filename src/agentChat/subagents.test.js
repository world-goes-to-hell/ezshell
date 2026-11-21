import { describe, expect, it } from 'vitest'
import { createSubagentTracker } from './subagents.js'

const timestamp = '2026-11-21T07:00:00Z'
const codex = (payload, type = 'response_item') => ({ type, timestamp, payload })
const output = (call_id, value) => codex({ type: 'function_call_output', call_id, output: JSON.stringify(value) })

describe('Codex subagents from a parent rollout', () => {
  it('reads durable spawn, wait and completion records without live app-server events', () => {
    const tracker = createSubagentTracker('codex')
    tracker.feed(codex({ type: 'function_call', call_id: 'spawn', name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: JSON.stringify({ agent_type: 'explorer', message: 'Inspect the chat store' }) }))
    tracker.feed(output('spawn', { agent_id: 'child', nickname: 'Ada' }))
    expect(tracker.snapshot()).toMatchObject([{ id: 'child', name: 'Ada', task: 'Inspect the chat store', status: 'running', startedAt: Date.parse(timestamp) }])

    tracker.feed(codex({ type: 'function_call', call_id: 'wait', name: 'wait_agent', arguments: '{"targets":["child"]}' }))
    tracker.feed(output('wait', { status: {}, timed_out: true }))
    expect(tracker.snapshot()).toBeUndefined()

    tracker.feed(codex({ content: '<subagent_notification>\n{"agent_path":"child","status":{"completed":"Store inspected"}}\n</subagent_notification>' }, 'inter_agent_communication'))
    expect(tracker.snapshot()).toMatchObject([{ id: 'child', status: 'completed', result: 'Store inspected' }])
    tracker.feed(codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<subagent_notification>{"agent_path":"other","status":"running"}</subagent_notification>' }] }))
    expect(tracker.snapshot()).toBeUndefined()
  })

  it('joins the v2 task path to its thread and preserves a recorded error', () => {
    const tracker = createSubagentTracker('codex')
    tracker.feed(codex({ type: 'function_call', call_id: 'spawn', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'review', message: 'Review the patch' }) }))
    tracker.feed(codex({ type: 'sub_agent_activity', kind: 'started', agent_thread_id: 'thread', agent_path: '/root/review' }, 'event_msg'))
    tracker.feed(output('spawn', { task_name: '/root/review' }))
    expect(tracker.snapshot()).toMatchObject([{ id: 'thread', name: 'review', task: 'Review the patch', status: 'running' }])
    tracker.feed(codex({ content: '<subagent_notification>{"agent_path":"/root/review","status":{"errored":"CLI error"}}</subagent_notification>' }, 'inter_agent_communication'))
    tracker.feed(codex({ type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'completed', agent_thread_id: 'thread', agent_path: '/root/review' } }, 'event_msg'))
    expect(tracker.snapshot()).toMatchObject([{ id: 'thread', status: 'error', result: 'CLI error' }])
  })
})

describe('Claude subagents from a parent transcript', () => {
  it('tracks agent calls, leaves a background acknowledgement running and ignores other tools', () => {
    const tracker = createSubagentTracker('claude')
    const tool = (id, name, sidechain = false) => ({ type: 'assistant', timestamp, isSidechain: sidechain, message: { content: [{ type: 'tool_use', id, name, input: { subagent_type: 'Explore', description: 'Inspect fixtures' } }] } })
    const result = (id, info, isError = false) => ({ type: 'user', timestamp, toolUseResult: info, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'Tool output' }] } })
    tracker.feed(tool('unrelated', 'Bash'))
    tracker.feed(tool('nested', 'Agent', true))
    tracker.feed(tool('background', 'Agent'))
    tracker.feed(result('background', { agentId: 'acf23', isAsync: true, status: 'async_launched' }))
    tracker.feed(tool('failed', 'Task'))
    tracker.feed(result('failed', {}, true))
    expect(tracker.snapshot()).toMatchObject([
      { id: 'failed', status: 'error', result: 'Tool output' },
      { id: 'background', name: 'Explore', task: 'Inspect fixtures', status: 'running', result: '' }
    ])
    tracker.feed({ type: 'user', timestamp, message: { content: '<task-notification><task-id>acf23</task-id><status>completed</status><summary>Finished</summary><result>Found 3 fixtures</result></task-notification>' } })
    expect(tracker.snapshot()?.[0]).toMatchObject({ id: 'background', status: 'completed', result: 'Found 3 fixtures' })
    expect(tracker.takeChildResults()).toEqual([])
  })
})
