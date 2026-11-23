import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentChats, claudeFolderName, findClaudeFile } from './chats.js'
import { PROMPT, BUSY_PROMPT } from '../ipc/agentInboxPrompts.js'

const SESSION = '0f3a8d40-5ff7-4d63-967c-90f524623f87'
const CWD = process.platform === 'win32' ? 'C:\\work\\my-app' : '/work/my-app'
const prompt = (uuid, text) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } }) + '\n'
const answer = (uuid, text) => JSON.stringify({ type: 'assistant', uuid, message: { id: uuid, content: [{ type: 'text', text }] } }) + '\n'

let root
let file
let frames
let target
let gone
let chats

function setup() {
  frames = []
  chats = createAgentChats({
    claudeRoot: root,
    tickMs: 60_000,
    send: (channel, frame) => frames.push({ channel, ...frame }),
    resolve: async () => target,
    isGone: () => gone
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-'))
  const folder = path.join(root, 'projects', claudeFolderName(CWD))
  fs.mkdirSync(folder, { recursive: true })
  file = path.join(folder, `${SESSION}.jsonl`)
  target = { kind: 'claude', sessionId: SESSION, cwd: CWD }
  gone = false
  setup()
})

afterEach(() => {
  chats.closeAll()
  fs.rmSync(root, { recursive: true, force: true })
})

const texts = frame => frame.items.map(item => item.text)

describe('following a chat view\'s transcript', () => {
  it('names Claude\'s project folder after the working directory', () => {
    expect(claudeFolderName('C:\\DEV\\WORKSPACE\\JAVA\\ezshell')).toBe('C--DEV-WORKSPACE-JAVA-ezshell')
    expect(claudeFolderName('/home/me/a.b')).toBe('-home-me-a-b')
  })

  it('finds the session file in another project folder when the working directory moved', async () => {
    const other = path.join(root, 'projects', 'elsewhere')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, `${SESSION}.jsonl`), '')
    fs.rmSync(file, { force: true })
    expect(await findClaudeFile(root, CWD, SESSION)).toBe(path.join(other, `${SESSION}.jsonl`))
    expect(await findClaudeFile(root, CWD, '../../etc/passwd')).toBeNull()
  })

  it('reads the conversation so far, then what is appended, holding back a line still being written', async () => {
    fs.writeFileSync(file, prompt('u1', '안녕') + answer('a1', '안녕하세요'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    const first = frames.find(frame => frame.reset)
    expect(first).toMatchObject({ shellId: 'local:1', state: 'live', kind: 'claude', hasOlder: false })
    expect(texts(first)).toEqual(['안녕', '안녕하세요'])

    const half = prompt('u2', '다음')
    fs.appendFileSync(file, half.slice(0, 10))
    chats.tick()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(frames.filter(frame => frame.items && !frame.reset)).toEqual([])
    fs.appendFileSync(file, half.slice(10))
    chats.tick()
    await vi.waitFor(() => expect(frames.filter(frame => frame.items && !frame.reset).flatMap(texts)).toEqual(['다음']))
  })

  it('starts over when the file shrank (rewritten)', async () => {
    fs.writeFileSync(file, prompt('u1', '하나') + prompt('u2', '둘'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.filter(frame => frame.reset)).toHaveLength(1))
    fs.writeFileSync(file, prompt('u3', '셋'))
    chats.tick()
    await vi.waitFor(() => expect(frames.filter(frame => frame.reset)).toHaveLength(2))
    expect(texts(frames.filter(frame => frame.reset)[1])).toEqual(['셋'])
  })

  it('reads a large file from its end and the part before it on request', async () => {
    const filler = JSON.stringify({ type: 'attachment', attachment: { text: 'x'.repeat(1000) } }) + '\n'
    fs.writeFileSync(file, prompt('u0', '맨 처음') + filler.repeat(2200) + prompt('u1', '마지막'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    const first = frames.find(frame => frame.reset)
    expect(texts(first)).toEqual(['마지막'])
    expect(first.hasOlder).toBe(true)
    fs.appendFileSync(file, answer('a1', '방금 기록된 답변') + '{"type":')
    const snapshot = await chats.transcriptForCopy('local:1')
    expect(snapshot.ok).toBe(true)
    expect(texts(snapshot)).toEqual(['맨 처음', '마지막', '방금 기록된 답변'])
    expect(frames).toHaveLength(1)
    await chats.older('local:1')
    const older = frames.find(frame => frame.older)
    expect(texts(older)).toEqual(['맨 처음'])
    expect(older.hasOlder).toBe(false)
  })

  it('recovers a delegation that started before the visible chat page', async () => {
    const call = JSON.stringify({ type: 'assistant', uuid: 'delegate', message: {
      content: [{ type: 'tool_use', name: 'Agent', id: 'toolu_delegate', input: { subagent_type: 'Explore', description: 'Find the fixtures' } }]
    } }) + '\n'
    const filler = JSON.stringify({ type: 'attachment', attachment: { text: 'x'.repeat(1000) } }) + '\n'
    fs.writeFileSync(file, call + filler.repeat(2200) + prompt('u1', '마지막'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.find(frame => frame.reset)).toMatchObject({
      subagents: [{ id: 'toolu_delegate', name: 'Explore', status: 'running', task: 'Find the fixtures' }]
    }))
    expect(texts(frames.find(frame => frame.reset))).toEqual(['마지막'])
    fs.appendFileSync(file, prompt('finished', '<task-notification><tool-use-id>toolu_delegate</tool-use-id><status>completed</status><result>Fixtures found</result></task-notification>'))
    chats.tick()
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ subagents: [{ status: 'completed', result: 'Fixtures found' }] }))
    expect(frames.at(-1)).not.toHaveProperty('items')
  })

  it('waits for a session that has written nothing yet, and says when the agent ended', async () => {
    target = { kind: 'claude', sessionId: null, cwd: CWD }
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ state: 'waiting' }))
    target = null
    chats.tick()
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ state: 'ended' }))
  })

  it('shows a Shell count from the footer before a transcript can be opened', async () => {
    target = { kind: 'claude', backgroundShellCount: 1 }
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.find(frame => frame.backgroundShells)).toMatchObject({
      backgroundShells: { count: 1, jobs: [] }
    }))
    target.backgroundShellCount = 0
    chats.tick()
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ backgroundShells: null }))
  })

  it('follows a running shell from the transcript without treating its launch result as completion', async () => {
    const record = value => JSON.stringify(value) + '\n'
    const call = record({ type: 'assistant', uuid: 'launch', message: { content: [{
      type: 'tool_use', name: 'Bash', id: 'toolu_server',
      input: { command: 'npm run dev', description: '로컬 서버 시작', run_in_background: true }
    }] } })
    const result = record({ type: 'user', uuid: 'background', toolUseResult: { backgroundTaskId: 'task-server' }, message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_server', content: 'Command running in background' }]
    } })
    const filler = record({ type: 'attachment', attachment: { text: 'x'.repeat(1000) } })
    fs.writeFileSync(file, call + result + filler.repeat(2200) + answer('a1', '서버를 시작했습니다'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({
      backgroundShells: { count: 1, jobs: [{ id: 'task-server', command: 'npm run dev', description: '로컬 서버 시작' }] }
    }))
    expect(texts(frames.find(frame => frame.reset))).toEqual(['서버를 시작했습니다'])
    fs.appendFileSync(file, record({
      type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'task-notification' },
        prompt: '<task-notification><task-id>task-server</task-id><status>completed</status></task-notification>' }
    }))
    chats.tick()
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ backgroundShells: null }))
    await chats.older('local:1')
    expect(frames.at(-1)).toMatchObject({ older: true })
    expect(frames.at(-1)).not.toHaveProperty('backgroundShells')
  })

  it('indexes earlier questions by identity and reads their context without replacing the live view', async () => {
    const filler = JSON.stringify({ type: 'attachment', attachment: { text: '한글'.repeat(1600) } }) + '\n'
    fs.writeFileSync(file, filler.repeat(33) + prompt('old', '같은 질문') + answer('old-a', '먼저 받은 답변')
      + filler.repeat(260) + prompt('new', '같은 질문') + answer('new-a', '나중에 받은 답변'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    expect(texts(frames.find(frame => frame.reset))).toEqual(['같은 질문', '나중에 받은 답변'])
    const index = await chats.questions('local:1')
    expect(index).toMatchObject({
      ok: true,
      questions: [{ id: 'user:new', text: '같은 질문' }, { id: 'user:old', text: '같은 질문' }]
    })
    expect((await chats.questionContext('local:1', 'another-session', 'user:old')).ok).toBe(false)
    expect((await chats.questionContext('local:1', index.scope, 'user:missing')).ok).toBe(false)
    const context = await chats.questionContext('local:1', index.scope, 'user:old')
    expect(context.ok).toBe(true)
    expect(texts(context)).toEqual(['같은 질문', '먼저 받은 답변'])
    expect(frames).toHaveLength(1)
  })

  it('indexes Claude’s received tasks and replies once and recovers the tool card when its result is far away', async () => {
    const line = value => JSON.stringify(value) + '\n'
    const call = (id, server = 'ezshell-cli-mcp') => line({ type: 'assistant', uuid: id, message: {
      content: [{ type: 'tool_use', id, name: `mcp__${server}__read_inbox`, input: {} }]
    } })
    const result = (id, messages) => line({ type: 'user', message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify({ messages }) }] }]
    } })
    const task = { id: 'message-1', from: 'codex-1', text: '배포 로그를 확인해 줘.\n오류가 있으면 알려줘.' }
    const reply = { id: 'message-2', from: 'codex-1', replyTo: 'sent', text: '잘 끝났습니다.' }
    const filler = line({ type: 'attachment', attachment: { text: '한글'.repeat(1600) } })
    fs.writeFileSync(file, prompt('notice', PROMPT) + call('first') + filler.repeat(40) + result('first', [task, reply,
      { id: 'message-3', from: 'user', text: '브라우저에서 보낸 내용' },
      { id: 'message-4', from: 'codex-1', replyTo: 'sent', receipt: true, text: '수신 확인' }
    ]) + answer('old-answer', '로그를 확인했습니다.') + filler.repeat(300) + call('repeat', 'ezshell_agent') + result('repeat', [task, reply])
      + call('other', 'another-tool') + result('other', [{ ...task, id: 'unrelated' }]) + prompt('new', '다음 질문'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    const index = await chats.questions('local:1')
    expect(index).toMatchObject({ ok: true, questions: [
      { id: 'user:new', text: '다음 질문' },
      { id: 'inbox:message-2', itemId: 'tool:first', sender: reply.from, text: reply.text, isReply: true },
      { id: 'inbox:message-1', itemId: 'tool:first', sender: task.from, text: task.text }
    ] })
    const context = await chats.questionContext('local:1', index.scope, 'inbox:message-2')
    expect(context).toMatchObject({ ok: true, items: [
      { id: 'tool:first', kind: 'tool', tool: { isInbox: true, result: expect.stringContaining(reply.text) } },
      { id: 'old-answer:0', text: '로그를 확인했습니다.' }
    ] })
    expect(frames).toHaveLength(1)
  })

  it('indexes Codex’s inbox results alongside human prompts and refreshes after an appended read', async () => {
    target = { kind: 'codex', file, cwd: CWD }
    const completed = item => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } }) + '\n'
    const request = (id, text) => completed({ type: 'UserMessage', id, content: [{ type: 'text', text }] })
    const read = (id, message, status = 'completed') => completed({ type: 'McpToolCall', id, server: 'ezshell-cli-mcp',
      tool: 'read_inbox', status, result: { content: [{ type: 'text', text: JSON.stringify({ messages: [message] }) }] }
    })
    const reply = { id: 'reply-1', from: 'claude-4', replyTo: 'sent', text: '검색 결과를 정리했습니다.' }
    fs.writeFileSync(file, request('real', '내가 적은 질문') + request('wake', BUSY_PROMPT) + read('failed', reply, 'failed'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    expect((await chats.questions('local:1')).questions).toMatchObject([{ id: 'UserMessage:real' }])
    fs.appendFileSync(file, read('first', reply) + read('again', reply))
    chats.tick()
    await vi.waitFor(() => expect(frames.at(-1).items).toContainEqual(expect.objectContaining({ id: 'McpToolCall:again' })))
    const index = await chats.questions('local:1')
    expect(index.questions).toMatchObject([
      { id: 'inbox:reply-1', itemId: 'McpToolCall:first', text: reply.text, sender: reply.from, isReply: true },
      { id: 'UserMessage:real', text: '내가 적은 질문' }
    ])
    expect((await chats.questionContext('local:1', index.scope, 'inbox:reply-1')).ok).toBe(true)
  })

  it('drops the view when its shell was closed', async () => {
    fs.writeFileSync(file, prompt('u1', '안녕'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    gone = true
    chats.tick()
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ gone: true }))
    expect(chats.count()).toBe(0)
  })

  it('remembers the links of the answers it sent, and only those', async () => {
    fs.writeFileSync(file, prompt('u1', '[가짜](C:/from/the/user.txt)') + answer('a1', '설정은 [mcp.json](C:/Users/me/mcp.json) 와 https://example.com/docs 에 있습니다'))
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    if (process.platform === 'win32') expect(chats.knowsLink('local:1', 'c:\\users\\me\\mcp.json')).toBe(true)
    expect(chats.knowsLink('local:1', 'https://example.com/docs')).toBe(true)
    // A link the user typed is not an answer's
    expect(chats.knowsLink('local:1', 'c:\\from\\the\\user.txt')).toBe(false)
    expect(chats.knowsLink('local:2', 'https://example.com/docs')).toBe(false)
  })

  it('sends nothing after the views were closed (the app was locked)', async () => {
    fs.writeFileSync(file, prompt('u1', '안녕'))
    chats.open('local:1')
    chats.closeAll()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(frames).toEqual([])
  })
})

describe('the windows a Claude question took', () => {
  it('adds them from the status line readings and sends the question again when a later reading changes them', async () => {
    let used = { fiveHour: 1 }
    const asked = []
    frames = []
    chats.closeAll()
    chats = createAgentChats({
      claudeRoot: root,
      tickMs: 60_000,
      send: (channel, frame) => frames.push({ channel, ...frame }),
      resolve: async () => target,
      claudeLimits: (from, to) => { asked.push([from, to]); return used },
      now: () => Date.parse('2026-11-21T10:00:30.000Z')
    })
    const at = '2026-11-21T10:00:00.000Z'
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', timestamp: at, message: { role: 'user', content: '해 줘' } }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-21T10:00:05.000Z', message: { id: 'm1', content: [{ type: 'text', text: '했습니다' }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n')
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.some(frame => frame.reset)).toBe(true))
    const question = frames.find(frame => frame.reset).items.find(item => item.id === 'user:u1')
    // The time it was worked out from stays in main
    expect(question.usage).toEqual({ input: 10, cached: 0, output: 5, limits: { fiveHour: 1 } })
    expect(asked[0]).toEqual([Date.parse(at), Date.parse('2026-11-21T10:00:15.000Z')])

    // The report of the last answer came after it was read: the question goes again, once
    const sent = frames.length
    chats.tick()
    await new Promise(done => setTimeout(done, 100))
    expect(frames.length).toBe(sent)
    used = { fiveHour: 2 }
    chats.tick()
    await vi.waitFor(() => expect(frames.length).toBe(sent + 1))
    expect(frames.at(-1).items).toEqual([expect.objectContaining({ id: 'user:u1', usage: { input: 10, cached: 0, output: 5, limits: { fiveHour: 2 } } })])
    chats.tick()
    await new Promise(done => setTimeout(done, 100))
    expect(frames.length).toBe(sent + 1)
  })
})
