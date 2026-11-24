import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { HOOK_COMMANDS } from './agentHookReport.js'
import { PROMPT } from './ipc/agentInboxPrompts.js'

const SCRIPT = fileURLToPath(new URL('./agentHookReport.js', import.meta.url))
const ID = '550e8400-e29b-41d4-a716-446655440000'
let listener

async function receive(decide = () => ({ success: true, stored: true })) {
  const id = 'ezshell-hook-test-' + randomUUID()
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\' + id : path.join(os.tmpdir(), id + '.sock')
  const requests = []
  listener = net.createServer(socket => {
    let data = ''
    socket.on('error', () => {})
    socket.on('data', chunk => {
      data += chunk
      if (!data.endsWith('\n')) return
      const request = JSON.parse(data)
      requests.push(request)
      const response = decide(request)
      if (response) socket.end(JSON.stringify(response) + '\n')
    })
  }).listen(pipe)
  await once(listener, 'listening')
  return { pipe, requests }
}

function run(kind, input, { pipe, token, shellToken, end = true, onInputError = () => {} } = {}) {
  const child = spawn(process.execPath, [SCRIPT, kind], { env: { ...process.env,
    EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: token, EZSHELL_SHELL_TOKEN: shellToken
  } })
  let out = ''
  let err = ''
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { err += data })
  child.stdin.on('error', onInputError)
  if (end) child.stdin.end(input)
  else child.stdin.write(input)
  return once(child, 'close').then(([code]) => ({ code, out, err }))
}

afterEach(async () => {
  if (!listener) return
  await new Promise(resolve => listener.close(resolve))
  listener = null
})

it('uses fixed commands containing only environment references and a provider name', () => {
  expect(HOOK_COMMANDS.claude).toBe('ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_HOOK_SCRIPT" claude')
  expect(HOOK_COMMANDS.codex).toBe('ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_HOOK_SCRIPT" codex')
  expect(HOOK_COMMANDS.codexWindows).toBe("$env:ELECTRON_RUN_AS_NODE='1'; & $env:EZSHELL_CLI_EXE $env:EZSHELL_AGENT_HOOK_SCRIPT codex")
})

it('reports only allowlisted fields and prints the fixed block reason for an authenticated Stop', async () => {
  const { pipe, requests } = await receive(request => request.method === 'stop-check'
    ? { success: true, block: PROMPT } : { success: true, stored: true })
  const input = JSON.stringify({
    last_assistant_message: 'sensitive answer '.repeat(200000),
    prompt: 'sensitive input', cwd: '/secret', transcript_path: '/secret/transcript.json',
    hook_event_name: 'Stop', session_id: ID, prompt_id: ID, tool_use_id: 'toolu_x', stop_hook_active: false
  })
  const inputErrors = []
  const result = await run('claude', input, { pipe, token: 'agent', onInputError: error => inputErrors.push(error.code) })
  expect(result).toEqual({ code: 0, out: JSON.stringify({ decision: 'block', reason: PROMPT }) + '\n', err: '' })
  const event = { kind: 'claude', token: 'agent', event: 'Stop', sessionId: ID, promptId: ID,
    toolUseId: 'toolu_x', stopHookActive: false, startedAt: expect.any(Number) }
  expect(requests).toEqual([{ method: 'agent-event', ...event, checkStop: true }, { method: 'stop-check', ...event }])
  expect(inputErrors).toEqual([])
})

it('reports a Codex turn with the shell token and sends no output for other events', async () => {
  const { pipe, requests } = await receive()
  const input = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: ID,
    turn_id: 'turn-1', tool_use_id: 'call_2', tool_name: 'Shell', tool_input: 'sensitive' })
  expect(await run('codex', input, { pipe, shellToken: 'local' })).toEqual({ code: 0, out: '', err: '' })
  expect(requests).toEqual([{ method: 'agent-event', kind: 'codex', token: 'shell', shellToken: 'local',
    event: 'PermissionRequest', sessionId: ID, promptId: 'turn-1', toolUseId: 'call_2', startedAt: expect.any(Number) }])
})

it('only relays a subagent’s dialog metadata and omits its identity', async () => {
  const { pipe, requests } = await receive()
  const options = { pipe, token: 'agent' }
  expect(await run('claude', '{"hook_event_name":"Stop","agent_id":"subagent-private"}', options)).toEqual({ code: 0, out: '', err: '' })
  expect(await run('claude', JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: 'subagent-private',
    tool_name: 'AskUserQuestion', tool_use_id: 'toolu_question', tool_input: 'private' }), options)).toEqual({ code: 0, out: '', err: '' })
  expect(requests).toEqual([{ method: 'agent-event', kind: 'claude', token: 'agent', event: 'PreToolUse',
    tool: 'AskUserQuestion', toolUseId: 'toolu_question', subagent: true, startedAt: expect.any(Number) }])
})

it('ignores invalid input, absent pipes, and arbitrary block text', async () => {
  const { pipe, requests } = await receive(request => request.method === 'stop-check'
    ? { success: true, block: 'arbitrary instructions' } : { success: true, stored: true })
  const valid = '{"hook_event_name":"Stop"}'
  expect(await run('claude', valid)).toEqual({ code: 0, out: '', err: '' })
  expect(await run('claude', '{"hook_event_name":"Stop",}', { pipe, token: 'agent' })).toEqual({ code: 0, out: '', err: '' })
  expect(requests).toEqual([])
  expect(await run('claude', valid, { pipe, token: 'agent' })).toEqual({ code: 0, out: '', err: '' })
  expect(requests.map(request => request.method)).toEqual(['agent-event', 'stop-check'])
})

it('leaves a stalled pipe and incomplete stdin silently within the deadline', async () => {
  const { pipe, requests } = await receive(() => null)
  const opts = { pipe, token: 'agent', end: false }
  const start = Date.now()
  expect(await run('claude', '{"hook_event_name":"Stop","prompt":"', opts)).toEqual({ code: 0, out: '', err: '' })
  expect(Date.now() - start).toBeLessThan(3000)
  expect(requests.map(request => request.method)).toEqual(['agent-event'])
})
