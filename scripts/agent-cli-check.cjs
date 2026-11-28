#!/usr/bin/env node
// Does the app still read the installed Claude Code / Codex? (docs/plan/2026-11-28-agent-cli-check.md)
// Starts the real CLI in a ConPTY and feeds its output to the app's own screen code (src/ipc/agentInboxWake.js,
// src/ipc/agentTitleStatus.js), then plays the scenes the app depends on: the composer is found, an inbox
// notice is pasted and submitted (while starting and while idle), a chat line goes out, Esc stops a turn.
//
//   npm run check:agent-cli                 both CLIs, every scene (asks the model a few one-word questions)
//   npm run check:agent-cli -- codex        one CLI
//   npm run check:agent-cli -- --no-model   screen only: Enter is not passed on, nothing reaches the model
//
// It runs under Electron as node (node-pty is built for Electron). The screen path only: no hooks, no MCP.
// The CLIs run in a fixed folder under the temp folder (trusted once, then reused), read-only.
'use strict'
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'))
  const run = childProcess.spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  process.exit(run.status ?? 1)
}

const pty = require(path.join(ROOT, 'node_modules', 'node-pty'))
const { createAgentInboxWake } = require(path.join(ROOT, 'src', 'ipc', 'agentInboxWake.js'))
const { titleStatusOf } = require(path.join(ROOT, 'src', 'ipc', 'agentTitleStatus.js'))

const COLS = 120
const ROWS = 32
const OUT = path.join(ROOT, 'e2e', '.out', 'agent-cli-check')
const WORK = path.join(os.tmpdir(), 'ezshell-agent-cli-check')
const ANSWER = 'Reply with the single word OK. Do not use any tools.'
const LONG = 'Count from 1 to 400, one number per line. Do not use any tools.'
const args = process.argv.slice(2)
const useModel = !args.includes('--no-model')
const kinds = args.filter(arg => arg === 'claude' || arg === 'codex')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// The settings an ezShell agent shell clears too (docs/architecture/agent-hooks.md)
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:EZSHELL_|CLAUDE_CODE_)/i.test(name) && !/^(?:CLAUDECODE|NO_COLOR|ELECTRON_RUN_AS_NODE)$/i.test(name)))

function cliVersion(kind) {
  try {
    const text = childProcess.execSync(`${kind} --version`, { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanEnv() })
    return text.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? text.trim()
  } catch {
    return null
  }
}

function workFolder() {
  fs.mkdirSync(WORK, { recursive: true })
  if (!fs.existsSync(path.join(WORK, '.git'))) {
    childProcess.execFileSync('git', ['init', '-q'], { cwd: WORK, windowsHide: true })
    fs.writeFileSync(path.join(WORK, 'README.md'), 'ezShell CLI check folder. Nothing here needs changing.\n')
  }
  fs.writeFileSync(path.join(WORK, 'no-mcp.json'), '{"mcpServers":{}}\n')
  return WORK
}

function cliArgs(kind) {
  return kind === 'codex'
    ? ['-c', 'mcp_servers.ezshell-cli-mcp.enabled=false', '-s', 'read-only', '-a', 'never']
    : ['--strict-mcp-config', '--mcp-config', 'no-mcp.json', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit']
}

/**
 * One CLI process with the app's screen reader on it. `mail` is the unread inbox the reader sees;
 * Enter is passed on only when `forwardEnter` (else it is counted and dropped: nothing reaches the model).
 */
function session(kind, { mail = [], forwardEnter = useModel } = {}) {
  const cwd = workFolder()
  const command = process.platform === 'win32' ? 'cmd.exe' : kind
  const commandArgs = process.platform === 'win32' ? ['/c', kind, ...cliArgs(kind)] : cliArgs(kind)
  const proc = pty.spawn(command, commandArgs, { cols: COLS, rows: ROWS, cwd, env: cleanEnv(), name: 'xterm-256color' })
  const startedAt = Date.now()
  const state = { title: 'unknown', submitted: false, enters: 0, pastes: 0, titles: [], raw: [], exited: null, mail }
  // Like localShell.agentStatus on the screen path: a Codex spinner before its first submission is its start-up
  const status = () => (kind === 'codex' && state.title === 'working' && !state.submitted ? 'starting' : state.title)
  const write = data => {
    if (data === '\r') {
      state.enters++
      if (!forwardEnter) return true
      state.submitted = true
    }
    if (data.includes('\x1b[200~')) state.pastes++
    proc.write(data)
    return true
  }
  const wake = createAgentInboxWake({
    kind, cols: COLS, rows: ROWS,
    pendingMessages: () => state.mail,
    isWorking: () => status() !== 'idle',
    isRunningTask: () => status() === 'working',
    isStarting: () => status() === 'starting',
    isUnknown: () => status() === 'unknown',
    write,
    // Answers to the CLI's own questions (folder trust) always go through: they never reach the model
    rawWrite: data => { proc.write(data); return true }
  })
  proc.onData(data => {
    state.raw.push(data)
    for (const match of data.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      const next = titleStatusOf(match[1])
      if (!next) continue
      if (next !== state.title) state.titles.push({ at: Date.now() - startedAt, status: next, title: match[1].trim().slice(0, 60) })
      state.title = next
    }
    wake.writeOutput(data)
  })
  proc.onExit(({ exitCode }) => { state.exited = exitCode })
  const kick = setInterval(() => wake.kick(), 250)
  return {
    kind, wake, state, status, startedAt,
    elapsed: () => Date.now() - startedAt,
    type: data => proc.write(data),
    screen: () => (wake.commandRows?.().lines ?? []).join('\n'),
    async waitFor(test, timeout, step = 100) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (state.exited !== null) return false
        if (test()) return true
        await sleep(step)
      }
      return Boolean(test())
    },
    close() {
      clearInterval(kick)
      wake.close()
      try { proc.kill() } catch { /* Already gone */ }
    }
  }
}

/** The first screen: the composer, after a folder trust question if the CLI asks one */
async function reachComposer(run, notes) {
  const ready = () => run.wake.composerState() === 'empty' && run.status() === 'idle'
  const end = Date.now() + 90_000
  while (Date.now() < end) {
    if (await run.waitFor(ready, 1000)) return true
    const prompt = run.wake.approvalPrompt()
    if (prompt?.terminalOnly === 'folder-trust') {
      // The app leaves Claude's folder trust to the user's terminal. Here: move to "Yes, I trust this folder".
      notes.push('Claude 폴더 신뢰 질문을 읽음 (앱은 터미널로 맡김) → Yes')
      const rows = run.screen().split('\n')
      const yes = rows.findIndex(row => /Yes, I trust this folder/.test(row))
      const no = rows.findIndex(row => /No, exit/.test(row))
      run.type(no >= 0 && no < yes && /❯/.test(rows[no]) ? '\x1b[B' : '')
      await sleep(300)
      run.type('\r')
      await sleep(1500)
      continue
    }
    if (prompt?.options?.length) {
      notes.push(`질문을 읽음: ${prompt.question ?? '(제목 없음)'} → ${prompt.options[0].key}`)
      const answer = await run.wake.answerApproval(prompt.options[0].key, prompt.signature)
      if (!answer.ok) notes.push(`답하지 못함: ${answer.reason}`)
    }
    if (run.state.exited !== null) return false
  }
  return false
}

const SCENES = {
  async start(kind, report) {
    const run = session(kind)
    try {
      const notes = []
      const ok = await reachComposer(run, notes)
      report('start', ok, `${ok ? '입력칸을 찾음' : '입력칸을 찾지 못함'} (${(run.elapsed() / 1000).toFixed(1)}초)`, notes, run)
    } finally { run.close() }
  },

  // 2026-11-28 fix: a notice that lands while Codex connects its MCP servers is still submitted
  async noticeWhileStarting(kind, report) {
    const run = session(kind, { mail: ['m1'], forwardEnter: false })
    try {
      const ok = await run.waitFor(() => run.state.enters > 0, 60_000)
      const pastedAt = run.state.pastes ? '' : ' (붙여 넣지 않음)'
      report('noticeWhileStarting', ok, ok ? `시작 중 알림을 제출함 (${(run.elapsed() / 1000).toFixed(1)}초)` : `시작 중 알림을 제출하지 않음${pastedAt}`, [], run)
    } finally { run.close() }
  },

  async noticeWhileIdle(kind, report) {
    const run = session(kind)
    try {
      if (!await reachComposer(run, [])) return report('noticeWhileIdle', false, '입력칸을 찾지 못함', [], run)
      run.state.mail = ['m2']
      const pasted = await run.waitFor(() => run.state.pastes > 0 && run.wake.composerState() === 'draft', 15_000)
      const entered = pasted && await run.waitFor(() => run.state.enters > 0, 15_000)
      if (!entered) return report('noticeWhileIdle', false, pasted ? '알림을 붙였으나 제출하지 않음' : '알림을 붙이지 않음', [], run)
      if (!useModel) return report('noticeWhileIdle', true, '알림을 붙이고 Enter (모델에는 넘기지 않음)', [], run)
      run.state.mail = []
      const turned = await run.waitFor(() => run.status() === 'working', 20_000) && await run.waitFor(() => run.status() === 'idle', 180_000)
      report('noticeWhileIdle', turned, turned ? '알림이 차례를 돌리고 쉼으로 돌아옴' : '제출 뒤 차례가 돌지 않거나 끝나지 않음', [], run)
    } finally { run.close() }
  },

  async chatLine(kind, report) {
    if (!useModel) return report('chatLine', null, '건너뜀 (--no-model)')
    const run = session(kind)
    try {
      if (!await reachComposer(run, [])) return report('chatLine', false, '입력칸을 찾지 못함', [], run)
      const sent = await run.wake.submitText(ANSWER)
      if (!sent.ok) return report('chatLine', false, `채팅 보내기 실패: ${sent.reason}`, [], run)
      run.state.submitted = true
      const done = await run.waitFor(() => run.status() === 'working', 20_000) && await run.waitFor(() => run.status() === 'idle', 180_000)
      report('chatLine', done, done ? '채팅 한 줄이 차례를 돌림' : '보낸 뒤 차례가 돌지 않거나 끝나지 않음', [], run)
    } finally { run.close() }
  },

  async escStops(kind, report) {
    if (!useModel) return report('escStops', null, '건너뜀 (--no-model)')
    const run = session(kind)
    try {
      if (!await reachComposer(run, [])) return report('escStops', false, '입력칸을 찾지 못함', [], run)
      const sent = await run.wake.submitText(LONG)
      if (!sent.ok) return report('escStops', false, `채팅 보내기 실패: ${sent.reason}`, [], run)
      run.state.submitted = true
      if (!await run.waitFor(() => run.status() === 'working', 20_000)) return report('escStops', false, '차례가 돌지 않음', [], run)
      await sleep(1500)
      const pressed = Date.now()
      run.type('\x1b')
      const stopped = await run.waitFor(() => run.status() === 'idle', 8000, 50)
      if (stopped) return report('escStops', true, `Esc 뒤 ${Date.now() - pressed}ms 에 쉬는 제목`, [], run)
      // Codex 0.170 stops (its composer comes back) but leaves a spinner in the title: the app learns it from
      // the Interrupt hook instead (docs/architecture/agent-hooks.md). Worth knowing, not a failure of the app.
      const back = run.wake.composerState() === 'empty'
      report('escStops', back ? 'warn' : false, back
        ? 'Esc 로 멈추고 입력칸은 돌아왔으나 창 제목은 8초 동안 작업 중으로 남음 (화면만으로는 작업 중, 훅이 있어야 앎)'
        : 'Esc 뒤 8초 안에 쉬지 않음', [], run)
    } finally { run.close() }
  }
}
// The start-up notice scene is about Codex's MCP start-up; Claude takes no Enter while it starts
const SCENES_OF = { codex: Object.keys(SCENES), claude: Object.keys(SCENES).filter(name => name !== 'noticeWhileStarting') }

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  let failed = 0
  for (const kind of kinds.length ? kinds : ['claude', 'codex']) {
    const version = cliVersion(kind)
    console.log(`\n=== ${kind} ${version ?? '(찾지 못함)'} ${useModel ? '' : '(--no-model)'}`)
    if (!version) { failed++; continue }
    for (const scene of SCENES_OF[kind]) {
      await SCENES[scene](kind, (name, ok, summary, notes = [], run = null) => {
        const mark = ok === null ? 'SKIP' : ok === 'warn' ? 'WARN' : ok ? 'PASS' : 'FAIL'
        console.log(`${mark}  ${name}  ${summary}`)
        for (const note of notes) console.log(`      ${note}`)
        if (ok === false || ok === 'warn') {
          if (ok === false) failed++
          if (run) {
            const file = path.join(OUT, `${kind}-${version}-${name}`)
            fs.writeFileSync(file + '.screen.txt', run.screen())
            fs.writeFileSync(file + '.titles.json', JSON.stringify(run.state.titles, null, 1))
            fs.writeFileSync(file + '.raw.txt', run.state.raw.join(''))
            console.log(`      화면과 출력: ${file}.*`)
          }
        }
      })
    }
  }
  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과')
  process.exit(failed ? 1 : 0)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
