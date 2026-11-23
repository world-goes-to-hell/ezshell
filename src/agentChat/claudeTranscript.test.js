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
  // As chats.js does after reading: a notice still held (the lines end at a boundary) comes out
  items.push(...parser.flush(0))
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
      user('u2', '<local-command-stdout>injected</local-command-stdout>', { isMeta: true }),
      { ...assistant('a1', 'm1', { type: 'text', text: 'inside a sub-agent' }), isSidechain: true },
      { type: 'attachment', attachment: { type: 'x' } },
      { type: 'api-request', id: 'r1' },
      { type: 'file-history-snapshot', snapshot: {} }
    ])
    expect(items).toEqual([])
  })

  // A message typed while Claude works: enqueued first, then absorbed into the running turn as an
  // attachment line (this PC's transcripts, 2026-11-22). Only the absorbed line means Claude read it.
  it('shows a message Claude read in the middle of a turn, once, when it read it', () => {
    const queued = (uuid, prompt, origin, extra = {}) => ({
      type: 'attachment', uuid, timestamp: '2026-11-19T10:00:05Z',
      attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin, humanTurn: true, ...extra }
    })
    const { items } = feedAll(createClaudeParser(), [
      user('u1', '배포해 줘'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-19T10:00:02Z', content: 'IP 도 열어 줘' },
      { type: 'queue-operation', operation: 'remove', timestamp: '2026-11-19T10:00:05Z', content: 'IP 도 열어 줘', reason: 'absorbed_mid_turn' },
      queued('q1', 'IP 도 열어 줘', { kind: 'human' }),
      queued('q2', '<task-notification>done</task-notification>', { kind: 'task-notification' }, { commandMode: 'task-notification' }),
      queued('q3', 'peer report', { kind: 'peer', name: 'code-reviewer' })
    ])
    expect(items.map(item => [item.kind, item.text])).toEqual([['user', '배포해 줘'], ['user', 'IP 도 열어 줘']])
    expect(items[1]).toMatchObject({ id: 'user:q1', time: Date.parse('2026-11-19T10:00:05Z') })
  })

  it('marks an absorbed ezShell inbox note like a typed one', () => {
    const { items } = feedAll(createClaudeParser(), [{
      type: 'attachment', uuid: 'q1', timestamp: '2026-11-19T10:00:05Z',
      attachment: { type: 'queued_command', prompt: 'New ezShell message while you are busy: read it now with read_inbox; handle it after your current task.', commandMode: 'prompt', origin: { kind: 'human' } }
    }])
    expect(items).toHaveLength(1)
    expect(items[0].inboxNotice).toBe(true)
  })

  it('reads the text and image presence from an absorbed multimodal prompt', () => {
    const parser = createClaudeParser()
    const timestamp = '2026-11-19T10:00:05Z'
    const text = '[Image #7] [Image #8]이 버튼을 눌러 봤어\r\n두 번째 사진을 봐 줘'
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const attachment = { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true }
    expect(parser.feed({ type: 'queue-operation', operation: 'enqueue', timestamp, content: text }).items).toEqual([])
    expect(parser.feed({ type: 'queue-operation', operation: 'remove', timestamp }).items).toEqual([])
    expect(parser.feed({
      type: 'attachment', uuid: 'q-images', timestamp,
      attachment: { ...attachment, prompt: [{ type: 'text', text }, image, image], imagePasteIds: [7, 8] }
    }).items).toEqual([{
      id: 'user:q-images', kind: 'user', time: Date.parse(timestamp), hasImage: true,
      text: '[Image #7] [Image #8]이 버튼을 눌러 봤어\n두 번째 사진을 봐 줘'
    }])
    expect(parser.feed({
      type: 'attachment', uuid: 'q-image-only', timestamp, attachment: { ...attachment, prompt: [image] }
    }).items).toEqual([{ id: 'user:q-image-only', kind: 'user', time: Date.parse(timestamp), hasImage: true }])
  })

  it('shows an interruption and a compaction as notices', () => {
    const { items } = feedAll(createClaudeParser(), [
      user('u1', '[Request interrupted by user]'),
      { type: 'system', subtype: 'compact_boundary', uuid: 's1' }
    ])
    expect(items.map(item => [item.kind, item.text])).toEqual([['notice', '중지했습니다'], ['notice', '이전 대화를 요약했습니다']])
  })

  it('shows /compact once: the boundary\'s notice, not again for the summary that follows it', () => {
    const { items } = feedAll(createClaudeParser(), [
      { type: 'system', subtype: 'compact_boundary', uuid: 's1' },
      user('u1', 'This session is being continued from a previous conversation...', { isCompactSummary: true })
    ])
    expect(items.map(item => [item.kind, item.text])).toEqual([['notice', '이전 대화를 요약했습니다']])
  })

  it('puts the compaction notice after the /compact that asked for it (Claude writes the command last)', () => {
    const { items } = feedAll(createClaudeParser(), [
      user('u0', '찾아봐줘'),
      { type: 'system', subtype: 'compact_boundary', uuid: 's1' },
      user('u1', 'summary', { isCompactSummary: true }),
      user('u2', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
      user('u3', '<local-command-stdout>Compacted</local-command-stdout>')
    ])
    expect(items.map(item => [item.kind, item.text])).toEqual([['user', '찾아봐줘'], ['user', '/compact'], ['notice', '이전 대화를 요약했습니다']])
  })

  it('after an automatic compaction the notice goes before what comes next', () => {
    const { items } = feedAll(createClaudeParser(), [
      { type: 'system', subtype: 'compact_boundary', uuid: 's1' },
      user('u1', 'summary', { isCompactSummary: true }),
      assistant('a1', 'm1', { type: 'text', text: '이어서 하겠습니다' })
    ])
    expect(items.map(item => [item.kind, item.text])).toEqual([['notice', '이전 대화를 요약했습니다'], ['assistant', '이어서 하겠습니다']])
  })

  it('shows a slash command the user ran as the user typed it, then what it printed (not /compact\'s report)', () => {
    const { items } = feedAll(createClaudeParser(), [
      user('u1', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'),
      user('u2', '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'),
      user('u3', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>'),
      user('u4', '<local-command-stdout>Set model to `Sonnet 5.5`\r\n\u001b[1mdone\u001b[22m</local-command-stdout>'),
      user('u5', '<command-name>/mcp</command-name>\n<command-message>mcp</command-message>\n<command-args></command-args>'),
      user('u6', '<local-command-stderr>Failed to reconnect to x</local-command-stderr>'),
      user('u7', '<local-command-stdout>  </local-command-stdout>')
    ])
    expect(items.map(item => [item.kind, item.text, item.isError])).toEqual([
      ['user', '/compact', undefined],
      ['user', '/model sonnet', undefined],
      ['output', 'Set model to `Sonnet 5.5`\ndone', undefined],
      ['user', '/mcp', undefined],
      ['output', 'Failed to reconnect to x', true]
    ])
  })

  it('shows an MCP tool\'s JSON arguments and answer as outlines, and leaves other tools\' output alone', () => {
    const answer = JSON.stringify({ messages: [{ from: 'user', text: '첫 줄\n둘째 줄' }] })
    const { items } = feedAll(createClaudeParser(), [
      assistant('a1', 'm1', { type: 'tool_use', id: 't1', name: 'mcp__ezshell-cli-mcp__read_inbox', input: { box: 'me' } }),
      user('u1', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: answer }] }]),
      assistant('a2', 'm2', { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cat a.json' } }),
      user('u2', [{ type: 'tool_result', tool_use_id: 't2', content: answer }])
    ])
    const mcp = items.filter(item => item.id === 'tool:t1').at(-1).tool
    expect(mcp.input).toBe('box: me')
    expect(mcp.result).toBe('messages:\n  - from: user\n    text: |\n      첫 줄\n      둘째 줄')
    expect(items.filter(item => item.id === 'tool:t2').at(-1).tool.result).toBe(answer)
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
