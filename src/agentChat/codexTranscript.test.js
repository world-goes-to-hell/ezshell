import { describe, expect, it } from 'vitest'
import { createCodexParser, commandText, fileChange } from './codexTranscript.js'

// Lines shaped like Codex 0.170's rollout files (this PC's files, contents replaced)
const completed = item => ({ type: 'event_msg', timestamp: '2026-11-19T10:00:00Z', payload: { type: 'item_completed', item } })

describe('Codex transcript lines to chat items', () => {
  it('reads what was said and done from item_completed and skips the repeated response items', () => {
    const parser = createCodexParser()
    const items = [
      { type: 'session_meta', payload: { id: 'x', cwd: 'C:\\p' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }, { type: 'input_text', text: '고쳐 줘' }] } },
      completed({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '고쳐 줘' }] }),
      completed({ type: 'Reasoning', id: 'r1', summary_text: [], raw_content: [] }),
      completed({ type: 'CommandExecution', id: 'c1', command: ['powershell.exe', '-Command', 'Get-ChildItem'], aggregated_output: 'a.txt', exit_code: 0 }),
      completed({ type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: '고쳤습니다.' }] }),
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '고쳤습니다.' }] } }
    ].flatMap(line => parser.feed(line).items)
    expect(items.map(item => item.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(items[1].tool).toMatchObject({ name: '명령', summary: 'Get-ChildItem', result: 'a.txt' })
    expect(items[1].tool.isError).toBeUndefined()
    expect(items[2].text).toBe('고쳤습니다.')
  })

  it('marks a command that failed and shows an aborted turn', () => {
    const parser = createCodexParser()
    const [failed] = parser.feed(completed({ type: 'CommandExecution', id: 'c1', command: ['bash', '-lc', 'false'], aggregated_output: '', exit_code: 1 })).items
    const [aborted] = parser.feed({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1' } }).items
    expect(failed.tool.isError).toBe(true)
    expect(aborted).toMatchObject({ kind: 'notice', text: '중지했습니다' })
  })

  it('shows file changes as diff lines', () => {
    const { paths, diff } = fileChange({
      'C:\\p\\new.txt': { type: 'add', content: 'one\ntwo' },
      'C:\\p\\old.txt': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n' }
    })
    expect(paths).toEqual(['C:\\p\\new.txt', 'C:\\p\\old.txt'])
    expect(diff).toEqual(['*** 새 파일: C:\\p\\new.txt', '+one', '+two', '*** 수정: C:\\p\\old.txt', '@@ -1 +1 @@', '-a', '+b'])
  })

  it('takes the script out of a shell command line', () => {
    expect(commandText(['bash', '-lc', 'npm test'])).toBe('npm test')
    expect(commandText(['git', 'status'])).toBe('git status')
    expect(commandText('ls')).toBe('ls')
  })

  it('names an MCP call by its server and tool', () => {
    const [item] = createCodexParser().feed(completed({
      type: 'McpToolCall', id: 'm1', server: 'ezshell', tool: 'read_inbox', arguments: { box: 'me' }, status: 'completed', result: { content: [{ type: 'text', text: '없음' }] }
    })).items
    expect(item.tool).toMatchObject({ name: 'ezshell.read_inbox', summary: 'me', result: '없음' })
  })
})
