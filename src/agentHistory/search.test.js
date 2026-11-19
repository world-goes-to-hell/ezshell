import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { searchWords, searchFile, excerpt } from './search.js'

const jsonl = lines => lines.map(line => JSON.stringify(line)).join('\n') + '\n'
let dir
let claudeFile
let codexFile

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-search-'))
  claudeFile = path.join(dir, 'claude.jsonl')
  fs.writeFileSync(claudeFile, jsonl([
    { type: 'user', message: { content: '실시간 보기에서 오류 이동을 고쳐 줘' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET_TOKEN=abc' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'F8 키로 다음 오류에 가도록 logView.ts 를 고쳤습니다.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep hidden-word' } }] } }
  ]))
  codexFile = path.join(dir, 'rollout.jsonl.zst')
  fs.writeFileSync(codexFile, zlib.zstdCompressSync(Buffer.from(jsonl([
    { type: 'session_meta', payload: { id: 'x', cwd: dir } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '사이드바 검색칸을 만들어 줘' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Sidebar.tsx 에 검색칸을 넣었습니다.' }] } } }
  ]))))
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('searchWords', () => {
  it('splits at whitespace, without case, each word once, at most ten', () => {
    expect(searchWords('  F8  logView f8 ')).toEqual(['f8', 'logview'])
    expect(searchWords(Array.from({ length: 15 }, (_, i) => `w${i}`).join(' '))).toHaveLength(10)
    expect(searchWords(42)).toEqual([])
  })
})

describe('searchFile', () => {
  it('finds words spread over a question and an answer, with an excerpt around the first hit', async () => {
    const hit = await searchFile('claude', claudeFile, searchWords('오류 logview'))
    expect(hit).not.toBeNull()
    expect(hit.snippet).toContain('오류')
  })

  it('needs every word', async () => {
    expect(await searchFile('claude', claudeFile, searchWords('오류 없는낱말'))).toBeNull()
  })

  it('does not look at tool results or tool calls', async () => {
    expect(await searchFile('claude', claudeFile, searchWords('secret_token'))).toBeNull()
    expect(await searchFile('claude', claudeFile, searchWords('hidden-word'))).toBeNull()
  })

  it('reads compressed Codex sessions', async () => {
    const hit = await searchFile('codex', codexFile, searchWords('sidebar.tsx 검색칸'))
    expect(hit?.snippet).toContain('검색칸')
  })

  it('gives nothing once cancelled', async () => {
    expect(await searchFile('claude', claudeFile, searchWords('오류'), () => true)).toBeNull()
  })
})

describe('excerpt', () => {
  it('is one line around the hit, marked where it was cut', () => {
    const text = `${'가'.repeat(100)}\n찾는 말 ${'나'.repeat(300)}`
    const at = text.indexOf('찾는')
    const cut = excerpt(text, at, 2)
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).toContain('찾는 말')
    expect(cut).not.toContain('\n')
  })
})
