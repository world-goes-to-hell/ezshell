import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSubagentPreview } from './subagentPreview.js'

const lines = (...values) => values.map(value => JSON.stringify(value) + '\n').join('')
const assistant = (...content) => ({ type: 'assistant', message: { content } })
const codex = (type, payload, ordinal) => ({ type, ordinal, payload })
const reply = (text, ordinal) => codex('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }] } }, ordinal)
let root

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-subagent-preview-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('subagent preview', () => {
  it('follows a foreground Claude child linked by the parent tool call', async () => {
    const parent = path.join(root, 'session.jsonl')
    const dir = path.join(root, 'session', 'subagents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent-ab12.meta.json'), JSON.stringify({ toolUseId: 'toolu_child' }))
    const file = path.join(dir, 'agent-ab12.jsonl')
    fs.writeFileSync(file, lines(assistant(
      { type: 'thinking', thinking: 'Private reasoning' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'src/layout.ts' } }
    )))
    const preview = createSubagentPreview(parent, 'claude')
    const child = { id: 'toolu_child', keys: ['toolu_child'] }
    expect(await preview(child)).toEqual([{ label: 'Read', detail: 'src/layout.ts' }])
    fs.appendFileSync(file, lines(assistant({ type: 'text', text: 'The layout handles splits.' })))
    expect(await preview(child)).toEqual([
      { label: '응답', detail: 'The layout handles splits.' },
      { label: 'Read', detail: 'src/layout.ts' }
    ])
    expect(await preview.conversation(child)).toMatchObject([{ role: 'assistant', text: 'The layout handles splits.' }])
    expect(await preview({ id: 'toolu_other', keys: ['toolu_other'] })).toEqual([])
  })

  it('matches the Codex parent as well as the child path and skips copied history', async () => {
    const day = new Date(2026, 10, 21, 10)
    const dir = path.join(root, 'sessions', '2026', '11', '21')
    fs.mkdirSync(dir, { recursive: true })
    const parent = path.join(dir, 'rollout-parent.jsonl')
    const meta = { id: 'child', parent_thread_id: 'parent', thread_source: 'subagent', agent_path: '/root/review', forked_from_id: 'parent', subagent_history_start_ordinal: 3 }
    fs.writeFileSync(parent, lines(codex('session_meta', { id: 'parent' }, 0)))
    fs.writeFileSync(path.join(dir, 'rollout-z-other.jsonl'), lines(codex('session_meta', { ...meta, parent_thread_id: 'other' }, 0), reply('Other session', 5)))
    fs.writeFileSync(path.join(dir, 'rollout-child.jsonl'), lines(
      codex('session_meta', meta, 0),
      reply('Inherited output', 2),
      codex('event_msg', { type: 'item_completed', item: { type: 'Extension', kind: 'web.search', query: 'release notes' } }, 3),
      reply('gAAAA' + '1aQz_9'.repeat(20), 4),
      reply('Reviewed the release notes', 5)
    ))
    const preview = createSubagentPreview(parent, 'codex')
    const child = { id: '/root/review', keys: ['/root/review'], startedAt: day.getTime() }
    expect(await preview(child)).toEqual([
      { label: '응답', detail: 'Reviewed the release notes' },
      { label: '웹 검색', detail: 'release notes' }
    ])
    expect(await preview.conversation(child)).toMatchObject([{ role: 'assistant', text: 'Reviewed the release notes' }])
  })
})
