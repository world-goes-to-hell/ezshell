import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentChats, claudeFolderName, findClaudeFile } from './chats.js'

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
    await chats.older('local:1')
    const older = frames.find(frame => frame.older)
    expect(texts(older)).toEqual(['맨 처음'])
    expect(older.hasOlder).toBe(false)
  })

  it('waits for a session that has written nothing yet, and says when the agent ended', async () => {
    target = { kind: 'claude', sessionId: null, cwd: CWD }
    chats.open('local:1')
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ state: 'waiting' }))
    target = null
    chats.tick()
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ state: 'ended' }))
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
