// Launch the real Electron app for the agent history spec (local-agent-history): fake Claude Code and
// Codex transcripts in the test profile, and local shells that record how they were asked to start
// (so "이어서 실행" never runs a real agent CLI of this PC).
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const pty = require('node-pty')
// pty.spawn is replaced below: shells must open in this process, not in the session host
process.env.EZSHELL_TEST_NO_SESSION_HOST = '1'

const profile = app.commandLine.getSwitchValue('user-data-dir')
const work = path.join(profile, 'work app')
const other = path.join(profile, 'other folder')
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(other, { recursive: true })

const CLAUDE_ID = 'abcdef12-1111-4222-8333-444455556666'
const EMPTY_ID = 'abcdef12-1111-4222-8333-777788889999'
const CODEX_ID = '01a1ec18-9b8a-71c1-839d-2e31c010300f'
const jsonl = lines => lines.map(line => JSON.stringify(line)).join('\n') + '\n'

const usedAt = Date.now()
fs.writeFileSync(path.join(profile, 'agent-roles.json'), JSON.stringify({
  [`claude:${CLAUDE_ID}`]: { user: '개발 B', agent: '검토 담당', usedAt },
  [`codex:${CODEX_ID}`]: { user: '개발 D', usedAt }
}))

const claudeHome = path.join(profile, 'claude-config')
const claudeProject = path.join(claudeHome, 'projects', 'work-app')
fs.mkdirSync(claudeProject, { recursive: true })
fs.writeFileSync(path.join(claudeProject, `${CLAUDE_ID}.jsonl`), jsonl([
  { type: 'user', message: { content: '실시간 보기에서 오류 이동을 고쳐 줘' }, cwd: work, gitBranch: 'feat/log', timestamp: '2026-11-18T01:00:00Z', sessionId: CLAUDE_ID },
  { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: '오류 이동을 고쳤습니다.' }] }, cwd: work, sessionId: CLAUDE_ID },
  { type: 'agent-name', agentName: '로그 화면 개선', sessionId: CLAUDE_ID }
]))
fs.writeFileSync(path.join(claudeProject, `${EMPTY_ID}.jsonl`), jsonl([{ type: 'mode', mode: 'default', sessionId: EMPTY_ID, cwd: work }]))

const codexHome = path.join(profile, 'codex-home')
const codexDay = path.join(codexHome, 'sessions', '2026', '11', '17')
fs.mkdirSync(codexDay, { recursive: true })
fs.writeFileSync(path.join(codexDay, `rollout-2026-11-17T09-00-00-${CODEX_ID}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(jsonl([
  { type: 'session_meta', payload: { id: CODEX_ID, cwd: other, timestamp: '2026-11-17T00:00:00Z', git: { branch: 'main' } } },
  { type: 'turn_context', payload: { model: 'gpt-6' } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '사이드바 검색칸을 만들어 줘' }] } } },
  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: '검색칸을 넣었습니다.' }] } } }
]))))
// The Codex file is older than the Claude one
const old = new Date('2026-11-17T09:00:00Z')
fs.utimesSync(path.join(codexDay, `rollout-2026-11-17T09-00-00-${CODEX_ID}.jsonl.zst`), old, old)

process.env.CLAUDE_CONFIG_DIR = claudeHome
process.env.CODEX_HOME = codexHome

const spawn = pty.spawn
pty.spawn = (file, args, options) => {
  fs.appendFileSync(path.join(profile, 'spawned.jsonl'), JSON.stringify({ file, args, cwd: options.cwd }) + '\n')
  // A plain shell in its place: the tab gets a live terminal, no agent CLI runs
  return spawn(file, process.platform === 'win32' ? ['-NoLogo'] : ['-l'], options)
}

require('../../out/main/index.js')
