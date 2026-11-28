import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentMessages, agentRuntimePaths, validEndpoint } from './agentMessages.js'
import { saveAgentHandoff, readHandoffEndpoint, takeAgentHandoff } from './agentHandoff.js'
import { rpc } from './agentMessageCli.js'

const PASSWORD = 'correct horse battery staple'
let root
let files
const apps = []
const leftover = []

function app(options = {}) {
  const messages = createAgentMessages({ notify: () => {}, isLocked: () => false, roleFile: path.join(root, 'roles.json'), ...options })
  apps.push(messages)
  return messages
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-handoff-test-'))
  files = { file: path.join(root, 'agent-handoff.json'), endpointFile: path.join(root, 'agent-handoff-endpoint.json') }
})

afterEach(() => {
  for (const messages of apps.splice(0)) messages.stop()
  for (const directory of leftover.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

describe('agent runtime paths', () => {
  it('uses the session host copy outside the install folder when there is one', () => {
    const appRoot = path.resolve('/copy/app')
    expect(agentRuntimePaths({ exe: path.resolve('/copy/ezShell-sessions.exe'), appRoot }, '/install/ezShell.exe', '/install/ipc')).toMatchObject({
      exe: path.resolve('/copy/ezShell-sessions.exe'), copied: true,
      mcp: path.join(appRoot, 'agent-runtime', 'agentMessageMcp.js'),
      hook: path.join(appRoot, 'agent-runtime', 'agentHookReport.js'),
      usage: path.join(appRoot, 'agent-runtime', 'agentUsageReport.js'),
      cli: path.join(appRoot, 'agent-runtime', 'agentMessageCli.js'),
      antigravity: path.join(appRoot, 'agent-runtime', 'antigravityStatusReport.js')
    })
  })

  it('falls back to this app’s files without a copy, or with a malformed one', () => {
    for (const runtime of [null, { exe: 'relative.exe', appRoot: '/x' }, { exe: path.resolve('/x.exe') }]) {
      expect(agentRuntimePaths(runtime, '/install/ezShell.exe', '/install/ipc')).toMatchObject({ exe: '/install/ezShell.exe', copied: false })
    }
  })

  it('gives agents and shells the copy in their environment', async () => {
    const appRoot = path.join(root, 'copy')
    const messages = app({ agentRuntime: () => ({ exe: path.join(root, 'ezShell-sessions.exe'), appRoot }) })
    await messages.ready()
    const { env } = messages.register('claude', 'local:1', root, {})
    expect(env.EZSHELL_CLI_EXE).toBe(path.join(root, 'ezShell-sessions.exe'))
    expect(env.EZSHELL_AGENT_MCP_SCRIPT).toBe(path.join(appRoot, 'agent-runtime', 'agentMessageMcp.js'))
    expect(env.EZSHELL_AGENT_HOOK_SCRIPT).toBe(path.join(appRoot, 'agent-runtime', 'agentHookReport.js'))
    const shell = messages.registerShell('local:1')
    expect(shell.EZSHELL_CLI_EXE).toBe(path.join(root, 'ezShell-sessions.exe'))
    expect(shell.EZSHELL_AGENT_USAGE_SCRIPT).toBe(path.join(appRoot, 'agent-runtime', 'agentUsageReport.js'))
  })
})

// The agent's message MCP lease: messages go only to a connected agent
function lease(pipe, token) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe)
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ method: 'watch-mcp', token, cwd: root, pid: process.pid }) + '\n'))
    socket.once('data', data => (JSON.parse(data).success ? resolve(socket) : reject(new Error(data))))
  })
}

describe('handing agents over to the app after an update', () => {
  async function before() {
    const old = app()
    await old.ready()
    const { env } = old.register('claude', 'local:3', root, {})
    const shell = old.registerShell('local:3')
    await lease(env.EZSHELL_AGENT_PIPE, env.EZSHELL_AGENT_TOKEN)
    old.sendAsUser({ to: env.EZSHELL_AGENT_ID, text: '업데이트 뒤에도 남아 있어야 하는 메시지' })
    const record = old.exportHandoff()
    expect(saveAgentHandoff({ ...files, record, masterPassword: PASSWORD })).toBe(true)
    old.stop({ handOver: true })
    leftover.push(record.endpoint.directory)
    return { env, shell, record }
  }

  it('keeps the pipe, folder, inbox and credentials, and never writes a raw token', async () => {
    const { env, shell, record } = await before()
    expect(fs.existsSync(path.join(record.endpoint.directory, 'agent-settings.json'))).toBe(true)
    const stored = fs.readFileSync(files.file, 'utf8') + fs.readFileSync(files.endpointFile, 'utf8')
    expect(stored).not.toContain(env.EZSHELL_AGENT_TOKEN)
    expect(JSON.stringify(record)).not.toContain(env.EZSHELL_AGENT_TOKEN)
    expect(JSON.stringify(record)).not.toContain(shell.EZSHELL_SHELL_TOKEN)

    const endpoint = readHandoffEndpoint(files)
    expect(endpoint).toEqual(record.endpoint)
    const next = app({ handoffEndpoint: endpoint })
    expect(next.awaitingHandoff()).toBe(true)
    await next.ready()
    // Before the unlock opens the record, the old token is held back instead of taken for a new agent
    const held = await rpc({ method: 'inbox', unread: true }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
    expect(held).toMatchObject({ success: false, error: 'ezShell이 다시 시작하는 중입니다.' })

    expect(next.importHandoff(takeAgentHandoff({ ...files, masterPassword: PASSWORD }))).toBe(true)
    expect(fs.existsSync(files.file)).toBe(false)
    const inbox = await rpc({ method: 'inbox', unread: true }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
    expect(inbox.success).toBe(true)
    expect(inbox.messages.map(message => message.text)).toEqual(['업데이트 뒤에도 남아 있어야 하는 메시지'])
    const usage = await rpc({ method: 'usage', usage: {} }, { pipe: shell.EZSHELL_AGENT_PIPE, token: 'shell' }).catch(error => error)
    expect(usage.success).toBe(false)
    const shellReport = await rpc({ method: 'usage', shellToken: shell.EZSHELL_SHELL_TOKEN, usage: {} }, { pipe: shell.EZSHELL_AGENT_PIPE, token: 'shell' })
    expect(shellReport.success).toBe(true)
    expect(next.agentsOfShell('local:3')).toEqual([env.EZSHELL_AGENT_ID])
  })

  // The unlock can open the record before the bridge starts (the session host is still coming up). The app then
  // still listens on the handed-over pipe: on a new one the CLIs still running never reached it (2026-11-28)
  it('listens on the handed-over pipe even when the record is opened before it starts, and takes it once', async () => {
    const { env } = await before()
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    const record = takeAgentHandoff({ ...files, masterPassword: PASSWORD })
    expect(next.importHandoff(record)).toBe(true)
    await next.ready()
    const inbox = await rpc({ method: 'inbox', unread: true }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
    expect(inbox.success).toBe(true)
    expect(inbox.messages.map(message => message.text)).toEqual(['업데이트 뒤에도 남아 있어야 하는 메시지'])
    expect(next.importHandoff(record)).toBe(false)
  })

  it('stops taking a handed-over token once the agent’s CLI ends', async () => {
    const { env } = await before()
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    await next.ready()
    next.importHandoff(takeAgentHandoff({ ...files, masterPassword: PASSWORD }))
    next.adoptAgent(env.EZSHELL_AGENT_ID).finish(0)
    const after = await rpc({ method: 'inbox', unread: true }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
    expect(after.success).toBe(false)
  })

  it('gives a kept shell its agent handle before the unlock and applies its calls once the record opens', async () => {
    const { env } = await before()
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    await next.ready()
    // The session host brings the shell back at start, while the record is still sealed
    const handle = next.adopt('claude', 'local:3')
    expect(next.adoptShell('local:3')).toBe(true)
    expect(next.adopt('claude', 'not-a-shell')).toBe(null)
    handle.setStatus('working', 'hook')
    handle.finish(0)
    next.importHandoff(takeAgentHandoff({ ...files, masterPassword: PASSWORD }))
    // The CLI ended before the unlock: its handed-over token is revoked when the record opens
    const after = await rpc({ method: 'inbox', unread: true }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
    expect(after.success).toBe(false)
    expect(next.agentsOfShell('local:3')).toEqual([])
  })

  // 2026-11-27 user report: the update handed the agents over but the session host started anew, so no
  // shell came back. The new shells were numbered from local:1 again and the old agents showed on them twice.
  it('retires the agents whose shells the session host did not bring back', async () => {
    const { env } = await before()
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    await next.ready()
    next.importHandoff(takeAgentHandoff({ ...files, masterPassword: PASSWORD }))
    next.retireLostShells([])
    const old = next.snapshot().agents.find(agent => agent.id === env.EZSHELL_AGENT_ID)
    // Kept for its messages, but on no shell: a new local:3 does not take it
    expect(old).toMatchObject({ active: false, status: 'ended', shellId: '' })
    expect(next.agentsOfShell('local:3')).toEqual([])
    const after = await rpc({ method: 'inbox', unread: true }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
    expect(after.success).toBe(false)
  })

  it('forgets a lost shell’s agent without messages and keeps the agent of a shell that came back', async () => {
    const old = app()
    await old.ready()
    const lost = old.register('codex', 'local:4', root, {}).env.EZSHELL_AGENT_ID
    const kept = old.register('claude', 'local:5', root, {}).env.EZSHELL_AGENT_ID
    const record = old.exportHandoff()
    saveAgentHandoff({ ...files, record, masterPassword: PASSWORD })
    old.stop({ handOver: true })
    leftover.push(record.endpoint.directory)
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    await next.ready()
    next.importHandoff(takeAgentHandoff({ ...files, masterPassword: PASSWORD }))
    next.retireLostShells(['local:5'])
    const ids = next.snapshot().agents.map(agent => agent.id)
    expect(ids).not.toContain(lost)
    expect(next.agentsOfShell('local:5')).toEqual([kept])
    // Only the handed-over agents: one this app runs is never retired
    const own = next.register('claude', 'local:1', root, {}).env.EZSHELL_AGENT_ID
    next.retireLostShells([])
    expect(next.agentsOfShell('local:1')).toEqual([own])
    expect(next.agentsOfShell('local:5')).toEqual([kept])
  })

  it('leaves the handle of a kept shell empty when there is nothing to take', async () => {
    await before()
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    await next.ready()
    const handle = next.adopt('codex', 'local:3')
    next.discardHandoff()
    expect(() => { handle.setStatus('idle'); handle.close() }).not.toThrow()
    expect(app().adopt('claude', 'local:3')).toBe(null)
  })

  it('takes requests again but no old credential when the record is wrong or missing', async () => {
    const { env } = await before()
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    await next.ready()
    expect(takeAgentHandoff({ ...files, masterPassword: 'wrong password' })).toBe(null)
    expect(fs.existsSync(files.file) || fs.existsSync(files.endpointFile)).toBe(false)
    expect(next.importHandoff(null)).toBe(false)
    expect(next.awaitingHandoff()).toBe(false)
    const result = await rpc({ method: 'inbox', unread: true }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
    expect(result).toMatchObject({ success: false, error: '활성 ezShell 에이전트 세션에서 실행해 주세요.' })
  })

  it('refuses a record for another pipe or folder than the one it listens on', async () => {
    const { record } = await before()
    const next = app({ handoffEndpoint: readHandoffEndpoint(files) })
    await next.ready()
    const other = { ...record, endpoint: { ...record.endpoint, pipe: record.endpoint.pipe.replace(/.$/, c => (c === 'a' ? 'b' : 'a')) } }
    expect(next.importHandoff(other)).toBe(false)
  })

  it('forgets an old or tampered endpoint file', () => {
    const now = Date.now()
    fs.writeFileSync(files.file, '{}')
    fs.writeFileSync(files.endpointFile, JSON.stringify({ format: 'ezshell-agent-handoff-file', savedAt: now - 25 * 60 * 60 * 1000, pipe: 'p', directory: 'd' }))
    expect(readHandoffEndpoint({ ...files, now })).toBe(null)
    expect(fs.existsSync(files.file) || fs.existsSync(files.endpointFile)).toBe(false)
  })

  it('checks the endpoint shape before listening on it', () => {
    const directory = path.join(os.tmpdir(), 'ezshell-agent-Ab12Cd')
    expect(validEndpoint({ pipe: '\\\\.\\pipe\\ezshell-12345678-1234-1234-1234-123456789abc', directory }, 'win32')).toBeTruthy()
    expect(validEndpoint({ pipe: '\\\\.\\pipe\\other', directory }, 'win32')).toBe(null)
    expect(validEndpoint({ pipe: '\\\\.\\pipe\\ezshell-12345678-1234-1234-1234-123456789abc', directory: 'C:\\Windows\\ezshell-agent-Ab12Cd' }, 'win32')).toBe(null)
    expect(validEndpoint({ pipe: path.join(directory, 'messages.sock'), directory }, 'linux')).toBeTruthy()
  })
})
