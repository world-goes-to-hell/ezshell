import { describe, expect, it } from 'vitest'
import { createClaudeParser, toolSummary } from './claudeTranscript.js'

// Lines shaped like Claude Code's transcript (this PC's files, contents replaced)
const assistant = (uuid, messageId, block) => ({ type: 'assistant', uuid, timestamp: '2026-11-19T10:00:00Z', message: { id: messageId, role: 'assistant', content: [block] } })
const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, timestamp: '2026-11-19T10:00:01Z', message: { role: 'user', content }, ...extra })

function feedAll(parser, lines) {
  const items = []
  let title
  for (const line of lines) {
    const result = parser.feed(line)
    items.push(...result.items)
    title = result.title ?? title
  }
  return { items, title }
}

describe('Claude transcript lines to chat items', () => {
  it('turns prompts, answers, thinking and tools into items and pairs a result with its call', () => {
    const { items } = feedAll(createClaudeParser(), [
      user('u1', '폴더를 정리해 줘'),
      assistant('a1', 'm1', { type: 'thinking', thinking: '먼저 목록을 본다' }),
      assistant('a2', 'm1', { type: 'text', text: '목록을 보겠습니다.' }),
      assistant('a3', 'm1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la\nwc -l', description: '목록' } }),
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }])
    ])
    const tool = items.filter(item => item.id === 'tool:toolu_1').at(-1)
    expect(items.map(item => item.kind)).toEqual(['user', 'thinking', 'assistant', 'tool', 'tool'])
    expect(items[0].text).toBe('폴더를 정리해 줘')
    expect(tool.tool).toMatchObject({ name: 'Bash', summary: 'ls -la wc -l', input: 'ls -la\nwc -l', result: 'a.txt\nb.txt' })
  })

  it('leaves out injected input, sub-agent lines and kinds it does not know', () => {
    const { items } = feedAll(createClaudeParser(), [
      user('u1', 'context', { isMeta: true }),
      user('u2', '<command-name>/clear</command-name>'),
      { ...assistant('a1', 'm1', { type: 'text', text: 'inside a sub-agent' }), isSidechain: true },
      { type: 'attachment', attachment: { type: 'x' } },
      { type: 'api-request', id: 'r1' },
      { type: 'file-history-snapshot', snapshot: {} }
    ])
    expect(items).toEqual([])
  })

  it('shows an interruption and a compaction as notices', () => {
    const { items } = feedAll(createClaudeParser(), [
      user('u1', '[Request interrupted by user]'),
      { type: 'system', subtype: 'compact_boundary', uuid: 's1' }
    ])
    expect(items.map(item => [item.kind, item.text])).toEqual([['notice', '중지했습니다'], ['notice', '이전 대화를 요약했습니다']])
  })

  it('draws an edit as diff lines and marks a failed tool', () => {
    const { items } = feedAll(createClaudeParser(), [
      assistant('a1', 'm1', { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/a.js', old_string: 'x', new_string: 'y' } }),
      user('u1', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }], {
        toolUseResult: { filePath: '/p/a.js', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-x', '+y'] }] }
      }),
      assistant('a2', 'm2', { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/p/missing' } }),
      user('u2', [{ type: 'tool_result', tool_use_id: 't2', content: 'no such file', is_error: true }])
    ])
    const edit = items.filter(item => item.id === 'tool:t1').at(-1).tool
    const read = items.filter(item => item.id === 'tool:t2').at(-1).tool
    expect(edit.summary).toBe('/p/a.js')
    expect(edit.diff).toEqual(['@@ -3,1 +3,1 @@', '-x', '+y'])
    expect(read.isError).toBe(true)
  })

  it('attaches a result read before its call (reading an earlier part of the file)', () => {
    const parser = createClaudeParser()
    expect(parser.feed(user('u1', [{ type: 'tool_result', tool_use_id: 't9', content: 'done' }])).items).toEqual([])
    const [item] = parser.feed(assistant('a1', 'm1', { type: 'tool_use', id: 't9', name: 'Grep', input: { pattern: 'TODO' } }), { older: true }).items
    expect(item.tool).toMatchObject({ summary: 'TODO', result: 'done' })
  })

  it('names the conversation by the user\'s name over the automatic title, the latest one', () => {
    const parser = createClaudeParser()
    expect(parser.feed({ type: 'ai-title', aiTitle: '자동 제목' }).title).toBe('자동 제목')
    expect(parser.feed({ type: 'agent-name', agentName: '내 이름' }).title).toBe('내 이름')
    expect(parser.feed({ type: 'ai-title', aiTitle: '새 자동 제목' }).title).toBe('내 이름')
    // A line from before what was read does not rename it
    expect(parser.feed({ type: 'agent-name', agentName: '옛 이름' }, { older: true }).title).toBe('내 이름')
  })

  it('keeps a to-do list as items, not as input text', () => {
    const [item] = createClaudeParser().feed(assistant('a1', 'm1', {
      type: 'tool_use', id: 't1', name: 'TodoWrite',
      input: { todos: [{ content: '읽기', status: 'completed' }, { content: '고치기', status: 'in_progress' }, { content: '', status: 'pending' }] }
    })).items
    expect(item.tool.todos).toEqual([{ text: '읽기', status: 'completed' }, { text: '고치기', status: 'in_progress' }])
    expect(item.tool.input).toBe('')
  })

  it('sums up a tool by its main argument', () => {
    expect(toolSummary('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
    expect(toolSummary('Task', { description: '조사', prompt: '...' })).toBe('조사')
    expect(toolSummary('mcp__x__y', { query: '찾기', limit: 3 })).toBe('찾기')
  })
})
