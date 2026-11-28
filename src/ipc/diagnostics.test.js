import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createErrorLog } from './errorLog.js'
import { createDiagnostics } from './diagnostics.js'

// docs/plan/2026-11-28-diagnostics.md
let directory
let clock
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-diagnostics-test-'))
  clock = Date.UTC(2026, 10, 28, 5, 0, 0)
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

const newLog = () => createErrorLog({ directory: path.join(directory, 'logs'), now: () => clock })

describe('error log', () => {
  it('keeps main exceptions and rejections without taking over how Node handles them', () => {
    const log = newLog()
    const proc = new EventEmitter()
    log.watchProcess(proc)
    expect(proc.listenerCount('uncaughtException')).toBe(0)
    expect(proc.listenerCount('unhandledRejection')).toBe(0)
    proc.emit('uncaughtExceptionMonitor', new Error('thrown'), 'uncaughtException')
    const rejection = Object.assign(new Error('Error: rejected\n    at x.js:1'), { name: 'UnhandledPromiseRejectionWarning' })
    proc.emit('warning', rejection)
    proc.emit('warning', Object.assign(new Error('Unhandled promise rejection. This error originated either by…'), { name: 'UnhandledPromiseRejectionWarning' }))
    proc.emit('warning', Object.assign(new Error('deprecated'), { name: 'DeprecationWarning' }))
    const entries = log.recent()
    expect(entries.map(entry => entry.kind)).toEqual(['main-exception', 'main-rejection'])
    expect(entries[0]).toMatchObject({ at: clock, origin: 'uncaughtException' })
    expect(entries[0].message).toContain('Error: thrown')
    expect(entries[1].message).toContain('rejected')
  })

  it('keeps processes that died (not clean exits) and only the window\'s console errors', () => {
    const log = newLog()
    const app = new EventEmitter()
    log.watchApp(app)
    app.emit('render-process-gone', {}, { getURL: () => 'file:///C:/app/out/renderer/index.html' }, { reason: 'crashed', exitCode: 5 })
    app.emit('render-process-gone', {}, { getURL: () => 'file:///x' }, { reason: 'clean-exit', exitCode: 0 })
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'oom', exitCode: -1 })
    const contents = new EventEmitter()
    log.watchConsole(contents, '본창')
    contents.emit('console-message', { level: 'error', message: 'Uncaught TypeError: x', sourceId: 'file:///C:/app/out/renderer/assets/index.js', lineNumber: 12 })
    contents.emit('console-message', { level: 'warning', message: 'just a warning' })
    contents.emit('console-message', {}, 3, 'old style error', 4, 'file:///C:/app/a.js')
    expect(log.recent().map(({ kind, message, page, window, where }) => ({ kind, message, page, window, where }))).toEqual([
      { kind: 'renderer-gone', message: 'crashed (exit 5)', page: 'index.html', window: undefined, where: undefined },
      { kind: 'child-gone', message: 'GPU: oom (exit -1)', page: undefined, window: undefined, where: undefined },
      { kind: 'console-error', message: 'Uncaught TypeError: x', page: undefined, window: '본창', where: 'index.js:12' },
      { kind: 'console-error', message: 'old style error', page: undefined, window: '본창', where: 'a.js:4' }
    ])
  })

  it('moves a full file aside, keeps both in the recent list and stops a flood', () => {
    const log = newLog()
    const big = 'x'.repeat(1900)
    for (let minute = 0; minute < 15; minute++) {
      clock += 60_000
      for (let index = 0; index < 50; index++) log.record('main-exception', big + index)
    }
    expect(fs.existsSync(path.join(directory, 'logs', 'errors.1.log'))).toBe(true)
    expect(fs.statSync(path.join(directory, 'logs', 'errors.log')).size).toBeLessThanOrEqual(1024 * 1024)
    expect(log.recent(3).map(entry => entry.message.slice(-2))).toEqual(['47', '48', '49'])
    expect(log.record('main-exception', 'one too many')).toBe(false)
  })

  it('reads nothing when there is no log yet and skips a cut line', () => {
    const log = newLog()
    expect(log.recent()).toEqual([])
    fs.mkdirSync(path.join(directory, 'logs'))
    fs.writeFileSync(path.join(directory, 'logs', 'errors.log'), '{"at":1,"kind":"main-exception","message":"a"}\n{"at":2,"ki')
    expect(log.recent().map(entry => entry.message)).toEqual(['a'])
  })
})

describe('diagnostics report', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'Users', 'someone')
  function setup({ agents = [], exec } = {}) {
    const log = newLog()
    const run = exec ?? vi.fn((command, _options, done) => done(null, command.startsWith('claude') ? '2.1.3 (Claude Code)\n' : 'codex-cli 0.170.0\n'))
    const diagnostics = createDiagnostics({
      appVersion: '2.41.1', errorLog: log, agents: () => agents, codexHookMode: () => 'approved', shellCount: () => 3,
      home, exec: run, now: () => clock, platform: 'win32', versions: { electron: '45.3.3', chrome: '156', node: '24.1.0' }
    })
    return { log, diagnostics, run }
  }

  it('names the versions, the agents\' states and recent errors, with the home folder as ~', async () => {
    const { log, diagnostics } = setup({ agents: [
      { id: 'claude-2', kind: 'claude', role: '개발A', status: 'working', statusSource: 'hook', mcpConnected: true },
      { id: 'codex-5', kind: 'codex', status: 'idle', sleeping: true, mcpConnected: false }
    ] })
    log.record('main-exception', `Error: boom\n    at ${path.join(home, 'app', 'main.js')}:3`)
    const { text, errors } = await diagnostics.report()
    expect(errors).toBe(1)
    expect(text).toContain('- ezShell 2.41.1')
    expect(text).toContain('Electron 45.3.3')
    expect(text).toContain('Claude Code 2.1.3 · Codex 0.170.0')
    expect(text).toContain('로컬 셸 3개 · Codex 훅 승인 approved')
    expect(text).toContain('- claude-2 (개발A) claude working 출처 hook')
    expect(text).toContain('- codex-5 codex 잠듦 MCP 끊김')
    expect(text).toContain('main-exception: Error: boom')
    expect(text).toContain(`~${path.sep}app${path.sep}main.js:3`)
    expect(text).not.toContain(home)
  })

  it('leaves the agents out while locked and says when a CLI is missing', async () => {
    const log = newLog()
    const diagnostics = createDiagnostics({ appVersion: '2.41.1', errorLog: log, agents: () => null, home,
      exec: (_command, _options, done) => done(new Error('not found')), now: () => clock })
    const { text, errors } = await diagnostics.report()
    expect(errors).toBe(0)
    expect(text).toContain('- (잠금 중이라 뺌)')
    expect(text).toContain('Claude Code 찾지 못함 · Codex 찾지 못함')
  })

  it('asks each CLI for its version once in ten minutes, with a fixed command', async () => {
    const { diagnostics, run } = setup()
    await diagnostics.report()
    await diagnostics.summary()
    expect(run.mock.calls.map(call => call[0])).toEqual(['claude --version', 'codex --version'])
    clock += 11 * 60_000
    await diagnostics.report()
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('gives a short state for a capture request', async () => {
    const { log, diagnostics } = setup({ agents: [{ id: 'codex-5', kind: 'codex', role: '개발C', status: 'working', statusSource: 'screen' }] })
    log.record('console-error', 'Uncaught TypeError: x')
    const summary = await diagnostics.summary()
    expect(summary.split('\n')).toEqual([
      'ezShell 상태 (캡처 때 자동 첨부): ezShell 2.41.1, win32 ' + os.release() + ', Claude Code 2.1.3, Codex 0.170.0',
      '에이전트:',
      '- codex-5 (개발C) codex working 출처 screen',
      '최근 오류:',
      expect.stringMatching(/^- 2026-11-28 \d\d:00:00 console-error: Uncaught TypeError: x$/)
    ])
  })
})
