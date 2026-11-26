import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { createAgentHistory, agentRoots } from './history.js'
import { readLinesFromStart } from './boundedRead.js'
import claude from './claude.js'
import { createClaudeProfiles } from '../agentChat/claudeProfiles.js'

const CLAUDE_ID = 'abcdef11-2222-4333-8444-555555555555'
const CODEX_ID = '01a1ec18-9b8a-71c1-839d-2e31c010300f'
const ZST_ID = '01a1ece7-97d8-7de3-9cd7-f01264b7871b'

const jsonl = lines => lines.map(line => JSON.stringify(line)).join('\n') + '\n'

let home
let work

function writeClaude(id, lines, folder = 'D--work') {
  const dir = path.join(home, '.claude', 'projects', folder)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, jsonl(lines))
  return file
}

function codexLines(id, prompt, extra = []) {
  return [
    { type: 'session_meta', payload: { id, cwd: work, timestamp: '2026-11-18T09:39:58Z', cli_version: '0.200.0', git: { branch: 'main' }, base_instructions: 'x'.repeat(5000) } },
    { type: 'turn_context', payload: { model: 'gpt-6' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: prompt }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'done' }] } } },
    ...extra
  ]
}

function writeCodex(id, lines, { compressed = false, day = '18' } = {}) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', day)
  fs.mkdirSync(dir, { recursive: true })
  const name = `rollout-2026-11-${day}T09-39-58-${id}.jsonl`
  const file = path.join(dir, compressed ? name + '.zst' : name)
  const body = Buffer.from(jsonl(lines))
  fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(body) : body)
  return file
}

const touch = (file, seconds) => fs.utimesSync(file, seconds, seconds)

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(work, { recursive: true, force: true })
})

describe('agentRoots', () => {
  it('uses CLAUDE_CONFIG_DIR and CODEX_HOME only when they are absolute', () => {
    const abs = path.join(home, 'elsewhere')
    expect(agentRoots({ CLAUDE_CONFIG_DIR: abs, CODEX_HOME: 'relative' }, home)).toEqual({
      claude: abs, codex: path.join(home, '.codex')
    })
  })
})

describe('Claude transcripts', () => {
  it('keeps the same session ID separate across the default and named account and resolves the correct resume target', async () => {
    const profiles = createClaudeProfiles(home)
    const [, named] = profiles.save({ name: '업무' })
    const root = profiles.rootFor(named.id, true)
    const folder = path.join(root, 'projects', 'work')
    fs.mkdirSync(folder, { recursive: true })
    const turn = text => ({ type: 'user', cwd: work, message: { content: text } })
    writeClaude(CLAUDE_ID, [turn('기본 대화')])
    fs.writeFileSync(path.join(folder, CLAUDE_ID + '.jsonl'), jsonl([turn('업무 대화')]))

    const persisted = createClaudeProfiles(home)
    expect(persisted.list()).toEqual([{ id: 'default', name: '기본 계정' }, named])
    expect(() => persisted.save({ name: '업무' })).toThrow(/같은 이름/)
    expect(persisted.rootFor('../outside', true)).toBeUndefined()
    const history = createAgentHistory({ env: {}, homeDir: home, claudeProfiles: persisted.roots })
    const { sessions } = await history.list()
    const key = `claude:${named.id}:${CLAUDE_ID}`
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key, title: '업무 대화', claudeProfileName: '업무' }),
      expect.objectContaining({ key: `claude:${CLAUDE_ID}`, title: '기본 대화' })
    ]))
    expect(history.target(key)).toEqual({ agent: 'claude', id: CLAUDE_ID, cwd: work, claudeProfileId: named.id })
    expect(await history.detail(key)).toMatchObject({ firstPrompt: '업무 대화' })
  })

  it('skips injected input and takes the latest name over the AI title', async () => {
    writeClaude(CLAUDE_ID, [
      { type: 'mode', mode: 'default', sessionId: CLAUDE_ID },
      { type: 'user', isMeta: true, message: { content: 'caveat' }, cwd: work, timestamp: '2026-11-18T01:00:00Z' },
      { type: 'user', message: { content: '<command-name>/model</command-name>' }, cwd: work },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] }, cwd: work },
      { type: 'user', message: { content: '<pasted_content id="1">로그 확인해 줘</pasted_content>' }, cwd: work, gitBranch: 'feat/a', version: '3.0.0', timestamp: '2026-11-18T01:01:00Z' },
      { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'thinking' }, { type: 'text', text: '확인했습니다' }] }, cwd: work },
      { type: 'ai-title', aiTitle: 'AI 제목', sessionId: CLAUDE_ID },
      { type: 'agent-name', agentName: '내가 붙인 이름', sessionId: CLAUDE_ID }
    ])
    const history = createAgentHistory({ env: {}, homeDir: home })
    const { sessions } = await history.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      key: `claude:${CLAUDE_ID}`, agent: 'claude', id: CLAUDE_ID, cwd: work, branch: 'feat/a',
      model: 'claude-opus-5-5', title: '내가 붙인 이름', preview: '로그 확인해 줘', hasPrompt: true
    })
    const detail = await history.detail(`claude:${CLAUDE_ID}`)
    expect(detail.firstPrompt).toBe('로그 확인해 줘')
    expect(detail.turns.map(turn => turn.role)).toEqual(['user', 'assistant'])
  })

  it('uses the latest prompt from the end when the start has none within the limit', async () => {
    const noise = Array.from({ length: 40 }, () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'z'.repeat(80 * 1024) }] }, cwd: work }))
    writeClaude(CLAUDE_ID, [...noise, { type: 'user', message: { content: '늦게 나온 질문' }, cwd: work }])
    const { sessions } = await createAgentHistory({ env: {}, homeDir: home }).list()
    expect(sessions[0]).toMatchObject({ preview: '늦게 나온 질문', title: '늦게 나온 질문', hasPrompt: true })
  })

  it('ignores sub-agent folders and files that are not session ids', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: 'hi' }, cwd: work }])
    const dir = path.join(home, '.claude', 'projects', 'D--work')
    fs.mkdirSync(path.join(dir, CLAUDE_ID, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(dir, CLAUDE_ID, 'subagents', 'agent-1.jsonl'), '{}\n')
    fs.writeFileSync(path.join(dir, 'notes.jsonl'), '{}\n')
    expect(await claude.listFiles(path.join(home, '.claude'))).toEqual([path.join(dir, `${CLAUDE_ID}.jsonl`)])
  })
})

describe('Codex transcripts', () => {
  it('reads plain and compressed rollouts and puts the index name over the prompt', async () => {
    touch(writeCodex(CODEX_ID, codexLines(CODEX_ID, '첫 질문')), 2000)
    touch(writeCodex(ZST_ID, codexLines(ZST_ID, '압축된 세션'), { compressed: true, day: '06' }), 1000)
    fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), jsonl([
      { id: CODEX_ID, thread_name: '옛 이름' }, { id: CODEX_ID, thread_name: '새 이름' }
    ]))
    const history = createAgentHistory({ env: {}, homeDir: home })
    const { sessions } = await history.list()
    expect(sessions.map(s => [s.id, s.title, s.preview, s.model, s.branch])).toEqual([
      [CODEX_ID, '새 이름', '첫 질문', 'gpt-6', 'main'],
      [ZST_ID, '압축된 세션', '압축된 세션', 'gpt-6', 'main']
    ])
    const detail = await history.detail(`codex:${ZST_ID}`)
    expect(detail.firstPrompt).toBe('압축된 세션')
    expect(detail.turns).toEqual([
      { role: 'user', text: '압축된 세션', time: null },
      { role: 'assistant', text: 'done', time: null }
    ])
  })

  it('reads the prompt of an older Codex from response items, without injected context', async () => {
    writeCodex(CODEX_ID, [
      { type: 'session_meta', payload: { id: CODEX_ID, cwd: work } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '# AGENTS.md instructions for x' },
        { type: 'input_text', text: '<environment_context>e</environment_context>' },
        { type: 'input_text', text: '옛 버전 질문' }
      ] } }
    ])
    const { sessions } = await createAgentHistory({ env: {}, homeDir: home }).list()
    expect(sessions[0]).toMatchObject({ preview: '옛 버전 질문', hasPrompt: true })
  })

  it('keeps one entry when the same session is in two files', async () => {
    touch(writeCodex(CODEX_ID, codexLines(CODEX_ID, '새 파일')), 2000)
    touch(writeCodex(CODEX_ID, codexLines(CODEX_ID, '옛 파일'), { compressed: true, day: '06' }), 1000)
    const { sessions } = await createAgentHistory({ env: {}, homeDir: home }).list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].preview).toBe('새 파일')
  })
})

describe('what leaves the main process', () => {
  it('sends no file paths', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: 'hi' }, cwd: work }])
    writeCodex(CODEX_ID, codexLines(CODEX_ID, 'hi'))
    const { sessions } = await createAgentHistory({ env: {}, homeDir: home }).list()
    expect(JSON.stringify(sessions)).not.toContain('.jsonl')
    expect(JSON.stringify(sessions)).not.toContain(path.join(home, '.claude'))
  })

  it('answers only keys from the latest list', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: 'hi' }, cwd: work }])
    const history = createAgentHistory({ env: {}, homeDir: home })
    expect(history.target(`claude:${CLAUDE_ID}`)).toBeNull()
    await history.list()
    expect(history.target(`claude:${CLAUDE_ID}`)).toEqual({ agent: 'claude', id: CLAUDE_ID, cwd: work })
    expect(history.target(`claude:${CLAUDE_ID.toUpperCase()}`)).toBeNull()
    expect(history.target('claude:../../etc')).toBeNull()
    expect(await history.detail('codex:nope')).toBeNull()
  })

  it('has no target for a network or device folder (Windows would send credentials to that host)', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: 'hi' }, cwd: '\\\\attacker\\share\\x' }])
    const history = createAgentHistory({ env: {}, homeDir: home })
    const { sessions } = await history.list()
    expect(sessions[0].cwd).toBe('\\\\attacker\\share\\x')
    expect(history.target(`claude:${CLAUDE_ID}`)).toBeNull()
  })

  it('has no target for a session without a folder', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: 'hi' } }])
    const history = createAgentHistory({ env: {}, homeDir: home })
    await history.list()
    expect(history.target(`claude:${CLAUDE_ID}`)).toBeNull()
  })

  it('forgets everything on clear, also from a scan that was running', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: 'hi' }, cwd: work }])
    const history = createAgentHistory({ env: {}, homeDir: home })
    const pending = history.list()
    history.clear()
    await pending
    expect(history.target(`claude:${CLAUDE_ID}`)).toBeNull()
  })

  it('reads a changed file again and an unchanged one from memory', async () => {
    const file = writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: '처음' }, cwd: work }])
    touch(file, 1000)
    const history = createAgentHistory({ env: {}, homeDir: home })
    expect((await history.list()).sessions[0].preview).toBe('처음')
    fs.writeFileSync(file, jsonl([{ type: 'user', message: { content: '바뀜' }, cwd: work }]))
    touch(file, 1000)
    // Same size and time: from memory
    expect((await history.list()).sessions[0].preview).toBe('처음')
    touch(file, 3000)
    expect((await history.list()).sessions[0].preview).toBe('바뀜')
  })
})

describe('content search', () => {
  it('finds sessions by words in their questions and answers, newest first, with keys and excerpts only', async () => {
    const older = writeClaude(CLAUDE_ID, [
      { type: 'user', message: { content: '로그 화면에서 오류 이동을 고쳐 줘' }, cwd: work },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'logView.ts 를 고쳤습니다' }] }, cwd: work }
    ])
    touch(older, 1000)
    const newer = writeCodex(CODEX_ID, codexLines(CODEX_ID, '오류 목록 패널도 고쳐 줘'))
    touch(newer, 2000)
    const history = createAgentHistory({ env: {}, homeDir: home })
    await history.list()
    const both = await history.search('오류')
    expect(both.matches.map(match => match.key)).toEqual([`codex:${CODEX_ID}`, `claude:${CLAUDE_ID}`])
    expect(JSON.stringify(both)).not.toContain('.jsonl')
    const one = await history.search('오류 logview')
    expect(one.matches).toEqual([{ key: `claude:${CLAUDE_ID}`, snippet: expect.stringContaining('오류') }])
    expect((await history.search('   ')).matches).toEqual([])
  })

  it('searches only the sessions of the latest list', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: '찾을 말' }, cwd: work }])
    const history = createAgentHistory({ env: {}, homeDir: home })
    expect((await history.search('찾을')).matches).toEqual([])
  })

  it('a newer search or clear() stops the one running', async () => {
    writeClaude(CLAUDE_ID, [{ type: 'user', message: { content: '찾을 말' }, cwd: work }])
    const history = createAgentHistory({ env: {}, homeDir: home })
    await history.list()
    const first = history.search('찾을')
    const second = history.search('말')
    expect(await first).toBeNull()
    expect((await second).matches).toHaveLength(1)
    const third = history.search('찾을')
    history.clear()
    expect(await third).toBeNull()
  })
})

describe('readLinesFromStart', () => {
  it('skips a line longer than the limit and stops at the byte limit', async () => {
    const file = path.join(home, 'long.jsonl')
    fs.writeFileSync(file, jsonl([{ n: 1 }, { big: 'y'.repeat(300 * 1024) }, { n: 2 }]))
    const seen = []
    await readLinesFromStart(file, line => { seen.push(line.n ?? 'big') }, { maxLine: 100 * 1024 })
    expect(seen).toEqual([1, 2])
    const early = []
    await readLinesFromStart(file, line => { early.push(line.n ?? 'big') }, { maxBytes: 10, maxLine: 100 * 1024 })
    expect(early.length).toBeLessThan(3)
  })
})
