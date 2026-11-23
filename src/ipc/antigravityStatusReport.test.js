import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { antigravityStatusFromInput, antigravityStatusSettings, runStatusReporter } from './antigravityStatusReport.js'

const id = 'c718ff33-8123-4022-9d6b-a5378ef4b2e0'
const cwd = process.platform === 'win32' ? 'C:\\work' : '/work'
const status = { product: 'antigravity', cwd, agent_state: 'idle' }

describe('Antigravity status line', () => {
  it('normalizes a verified session identity and accepts startup before the first turn', () => {
    expect(antigravityStatusFromInput({ ...status, cwd: 'C:/work', session_id: '', conversation_id: '', agent_state: 'authenticating' }, 'win32'))
      .toEqual({ cwd: 'C:\\work', sessionId: null, status: 'starting' })
    expect(antigravityStatusFromInput({ ...status, session_id: id, conversation_id: id.toUpperCase(), tool_confirmation_pending: true,
      transcript_path: 'fake.jsonl', quota: { remaining_fraction: 0.5 }, account: 'synthetic' }))
      .toEqual({ cwd, sessionId: id, status: 'blocked' })
    expect(antigravityStatusFromInput({ ...status, agent_state: ['idle'] })?.status).toBe('unknown')
    expect(antigravityStatusFromInput({ ...status, agent_state: 'tool_use' })?.status).toBe('working')
  })

  it('rejects another product, non-local directories, and invalid or conflicting IDs', () => {
    for (const fields of [{ product: 'gemini' }, { cwd: 'relative' }, { cwd: cwd + '\n' },
      { session_id: '../escape' }, { session_id: id, conversation_id: '12345678-1234-1234-1234-123456789abc' }]) {
      expect(antigravityStatusFromInput({ ...status, ...fields })).toBeNull()
    }
    expect(antigravityStatusFromInput({ ...status, cwd: '\\\\host\\share' }, 'win32')).toBeNull()
  })

  it('retains the user settings and uses the existing status command in the temporary override', () => {
    const home = mkdtempSync(join(tmpdir(), 'ezshell-agy-status-'))
    try {
      const config = join(home, '.gemini', 'antigravity-cli')
      mkdirSync(config, { recursive: true })
      const file = join(config, 'settings.json')
      const original = JSON.stringify({ statusLine: { type: 'command', command: 'echo configured', padding: 3 } })
      writeFileSync(file, original)
      const settings = antigravityStatusSettings(home, 'win32')
      expect(settings).toMatchObject({ forward: 'echo configured', statusLine: { type: 'command', padding: 3, stack_with_default: false } })
      expect(settings.statusLine.command).toBe('%EZSHELL_ANTIGRAVITY_STATUS_COMMAND%')
      expect(readFileSync(file, 'utf8')).toBe(original)
      writeFileSync(file, JSON.stringify({ statusLine: { command: 'echo disabled', enabled: false } }))
      expect(antigravityStatusSettings(home, 'linux')).toMatchObject({ forward: '', statusLine: { stack_with_default: true } })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports only the identity and state fields through the shell token and displays the existing command', async () => {
    const request = vi.fn(async () => { throw new Error('closed pipe') })
    let output = ''
    const env = { ...process.env, EZSHELL_AGENT_PIPE: 'test-pipe', EZSHELL_SHELL_TOKEN: 'shell-token',
      EZSHELL_ANTIGRAVITY_STATUS_FORWARD: 'echo configured' }
    const input = { ...status, conversation_id: id, transcript_path: 'untrusted', account: 'synthetic' }
    await runStatusReporter({ stdin: Readable.from([JSON.stringify(input)]), stdout: { write: chunk => { output += chunk } }, env, request })
    expect(request).toHaveBeenCalledOnce()
    const [report, options] = request.mock.calls[0]
    expect(report).toMatchObject({ method: 'antigravity-status', pid: process.pid, value: status })
    expect(JSON.parse(JSON.stringify(report.value))).toEqual({ ...status, conversation_id: id })
    expect(options).toEqual({ pipe: 'test-pipe', token: 'shell-token' })
    expect(output.trim()).toBe('configured')
  })
})
