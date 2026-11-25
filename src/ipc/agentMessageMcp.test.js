import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import { connectionOptions } from './agentMessageMcp.js'
import { rpc } from './agentMessageCli.js'
import { createAgentMessages } from './agentMessages.js'

function startStdio(cwd, parentEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^EZSHELL_/i.test(name)))
  const child = spawn(process.execPath, [path.join(__dirname, 'agentMessageMcp.js')], {
    cwd, env: { ...env, ...parentEnv }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
  })
  const exited = once(child, 'exit')
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const request = async (method, params) => {
    send({ id: ++id, method, params })
    const reply = await replies.next()
    if (reply.done) throw new Error('Message MCP closed before responding')
    const response = JSON.parse(reply.value)
    if (response.error) throw new Error(response.error.message)
    return response.result
  }
  return {
    child, exited, request,
    async initialize() {
      const result = await request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'lease-test', version: '1' } })
      send({ method: 'notifications/initialized' })
      return result
    },
    listAgents: () => request('tools/call', { name: 'list_agents', arguments: {} })
  }
}

const reconnectError = { isError: true, content: [{ type: 'text', text: 'ezShell과 다시 연결하는 중입니다.' }] }

async function watch(pipe, request, sockets) {
  const socket = net.createConnection(pipe)
  sockets.push(socket)
  socket.setEncoding('utf8')
  const closed = new Promise(resolve => socket.once('close', resolve))
  socket.setTimeout(5000, () => socket.destroy())
  const reply = new Promise((resolve, reject) => {
    let buffer = ''
    socket.on('error', reject)
    socket.on('close', () => reject(new Error('No lease reply')))
    socket.on('data', chunk => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end >= 0) resolve(JSON.parse(buffer.slice(0, end)))
    })
  })
  socket.once('connect', () => socket.write(JSON.stringify({ method: 'watch-mcp', pid: process.pid, ...request }) + '\n'))
  const result = await reply
  if (result.success) socket.setTimeout(0)
  return { result, socket, closed }
}

describe('Aside on the shared message bridge', () => {
  it('registers through stdio without binding a shell and tells the client to check its inbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-aside-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const roleFile = path.join(root, 'agent-roles.json')
    const bindLocalAgent = vi.fn()
    const onInboxChanged = vi.fn()
    const messages = createAgentMessages({ bridgeFile, roleFile, home: root, bindLocalAgent, onInboxChanged, notify() {}, isLocked: () => false })
    let mcp
    try {
      await messages.enableExternalBridge()
      mcp = startStdio(root, { EZSHELL_AGENT_BRIDGE_FILE: bridgeFile, EZSHELL_AGENT_BRIDGE_KIND: 'aside' })
      const { instructions } = await mcp.initialize()
      expect(instructions).toContain('Check read_inbox at the start of a task and periodically')
      expect(instructions).not.toContain('when ezShell notifies you')
      expect(instructions.length).toBeLessThan(2000)
      await vi.waitFor(async () => {
        const listed = JSON.parse((await mcp.listAgents()).content[0].text)
        expect(listed).toMatchObject({ self: 'aside-1', agents: [{ id: 'aside-1', kind: 'aside', cwd: root }] })
      })
      expect(messages.snapshot().agents[0]).toMatchObject({ id: 'aside-1', kind: 'aside', shellId: '', mcpConnected: true })
      const role = await mcp.request('tools/call', { name: 'set_role', arguments: { role: '브라우저' } })
      expect(role.isError).not.toBe(true)
      expect(messages.snapshot().agents[0]).toMatchObject({ role: '브라우저' })
      expect(fs.existsSync(roleFile)).toBe(false)
      messages.sendAsUser({ to: 'aside-1', text: '확인할 메시지' })
      const inbox = await mcp.request('tools/call', { name: 'read_inbox', arguments: {} })
      expect(JSON.parse(inbox.content[0].text).messages[0].text).toBe('확인할 메시지')
      expect(bindLocalAgent).not.toHaveBeenCalled()
      expect(onInboxChanged).not.toHaveBeenCalled()
    } finally {
      if (mcp && mcp.child.exitCode === null && !mcp.child.signalCode) mcp.child.kill()
      await mcp?.exited
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects Aside on all scoped registrations and rejects unknown kinds on the shared bridge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-aside-scoped-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const bindLocalAgent = vi.fn()
    const messages = createAgentMessages({ bridgeFile, home: root, bindLocalAgent, notify() {}, isLocked: () => false })
    const sockets = []
    try {
      await messages.enableExternalBridge()
      const [, , pipe, token] = fs.readFileSync(bridgeFile, 'utf8').split(/\r?\n/)
      const { env } = messages.register('claude', 'local:managed', root, {})
      const { EZSHELL_SHELL_TOKEN: shellToken } = messages.registerShell('local:plain')
      const requests = [
        { token: env.EZSHELL_AGENT_TOKEN, kind: 'aside' },
        { wakeToken: shellToken, kind: 'aside' },
        { shellToken, kind: 'aside' },
        { token, kind: 'foo' }
      ]
      for (const request of requests) {
        const { result } = await watch(pipe, { ...request, cwd: root }, sockets)
        expect(result).toMatchObject({ success: false })
      }
      expect(bindLocalAgent).not.toHaveBeenCalled()
      expect(messages.snapshot().agents.map(({ kind }) => kind)).toEqual(['claude'])
      const shared = { EZSHELL_AGENT_BRIDGE_FILE: bridgeFile, EZSHELL_AGENT_BRIDGE_KIND: 'aside' }
      expect(await connectionOptions(shared)).toEqual({ pipe, token, kind: 'aside' })
      await expect(connectionOptions({ ...shared, EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: env.EZSHELL_AGENT_TOKEN })).rejects.toThrow(/전용/)
      await expect(connectionOptions({ EZSHELL_AGENT_PIPE: pipe, EZSHELL_SHELL_TOKEN: shellToken, EZSHELL_AGENT_WAKE_KIND: 'aside' })).rejects.toThrow(/깨우기/)
      await expect(connectionOptions({ EZSHELL_AGENT_PIPE: pipe, EZSHELL_SHELL_TOKEN: shellToken, EZSHELL_AGENT_SHELL_KIND: 'aside' })).rejects.toThrow(/로컬 터미널/)
      await expect(connectionOptions({ ...shared, EZSHELL_AGENT_BRIDGE_KIND: 'foo' })).rejects.toThrow(/설정/)
    } finally {
      for (const socket of sockets) socket.destroy()
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the MCP bridge for an agent started in a local terminal', () => {
  it('records Codex role launch evidence only when the shell binding confirms the requested folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-codex-role-bridge-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const sockets = []
    const startedAt = Date.now() - 1000
    const messages = createAgentMessages({
      bridgeFile, home: root, notify: () => {}, isLocked: () => false,
      bindLocalAgent: async ({ cwd, pid }) => ({ agentId }) => ({
        agentId, shellId: `local:${pid}`, detach: () => true,
        ...(cwd === root ? { codexRoleCwd: root, codexProcessStartedAt: startedAt } : {})
      })
    })
    try {
      await messages.enableExternalBridge()
      const [, , pipe, token] = fs.readFileSync(bridgeFile, 'utf8').split(/\r?\n/)
      const matching = await watch(pipe, { token, pid: 101, kind: 'codex', cwd: root }, sockets)
      const different = await watch(pipe, { token, pid: 102, kind: 'codex', cwd: os.tmpdir() }, sockets)
      expect(matching.result.success).toBe(true)
      expect(different.result.success).toBe(true)
      expect(messages.codexRoleContextOf('codex-1')).toEqual({ roleCwd: root, roleStartedAt: startedAt })
      expect(messages.codexRoleContextOf('codex-2')).toBeNull()
    } finally {
      for (const socket of sockets) socket.destroy()
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the ancestor app when a newer app has replaced the shared bridge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-bridge-test-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const instanceFile = `${bridgeFile}.${process.pid}`
    const messages = createAgentMessages({ bridgeFile, notify: () => {}, isLocked: () => false })
    try {
      await messages.enableExternalBridge()
      const installed = fs.readFileSync(instanceFile, 'utf8')
      expect(fs.readFileSync(bridgeFile, 'utf8')).toBe(installed)
      const [executable, script, pipe, token] = installed.split('\n')
      const newer = [executable, script, 'newer-pipe', 'newer-token', ''].join('\n')
      fs.writeFileSync(`${bridgeFile}.${process.ppid}`, newer)
      fs.writeFileSync(bridgeFile, newer)

      const helper = Math.max(process.pid, process.ppid) + 1
      const cli = helper + 1
      const runtime = path.basename(process.execPath)
      const tree = vi.fn(async () => new Map([
        [helper, { parent: cli, name: runtime }],
        [cli, { parent: process.pid, name: 'claude' }],
        [process.pid, { parent: process.ppid, name: runtime }]
      ]))
      const env = { EZSHELL_AGENT_BRIDGE_FILE: bridgeFile, EZSHELL_AGENT_BRIDGE_KIND: 'claude' }
      expect(await connectionOptions(env, tree, helper)).toEqual({ pipe, token, kind: 'claude' })
      expect(await connectionOptions(env, tree, cli + 1)).toEqual({ pipe: 'newer-pipe', token: 'newer-token', kind: 'claude' })

      tree.mockClear()
      expect(await connectionOptions({ ...env, EZSHELL_AGENT_PIPE: pipe }, tree, helper)).toEqual({ pipe, token, kind: 'claude' })
      expect(await connectionOptions({ ...env, EZSHELL_AGENT_PIPE: 'dedicated-pipe', EZSHELL_AGENT_TOKEN: 'dedicated-token' }, tree, helper))
        .toEqual({ pipe: 'dedicated-pipe', token: 'dedicated-token' })
      await expect(connectionOptions({ ...env, EZSHELL_AGENT_TOKEN: 'dedicated-token' }, tree, helper)).rejects.toThrow(/전용/)
      expect(tree).not.toHaveBeenCalled()

      messages.stop()
      expect(fs.existsSync(instanceFile)).toBe(false)
      expect(fs.readFileSync(bridgeFile, 'utf8')).toBe(newer)
    } finally {
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stdio open while offline and rereads the bridge after an app restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-bridge-reconnect-test-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const startApp = () => createAgentMessages({ bridgeFile, notify: () => {}, isLocked: () => false })
    let messages = startApp()
    let mcp
    try {
      await messages.enableExternalBridge()
      mcp = startStdio(root, { EZSHELL_AGENT_BRIDGE_FILE: bridgeFile, EZSHELL_AGENT_BRIDGE_KIND: 'codex' })
      await mcp.initialize()
      await vi.waitFor(async () => {
        const result = await mcp.listAgents()
        expect(result.isError).not.toBe(true)
        expect(JSON.parse(result.content[0].text).self).toBe('codex-1')
      })
      messages.stop()
      const started = Date.now()
      await vi.waitFor(async () => expect(await mcp.listAgents()).toEqual(reconnectError))
      expect(Date.now() - started).toBeLessThan(1000)
      expect(mcp.child.exitCode).toBeNull()
      expect((await mcp.request('tools/list')).tools.map(tool => tool.name)).toContain('list_agents')

      messages = startApp()
      await messages.enableExternalBridge()
      messages.register('claude', 'local:1', root, {}) // The restarted app has its own agent IDs.
      await vi.waitFor(async () => {
        const result = await mcp.listAgents()
        expect(result.isError).not.toBe(true)
        expect(JSON.parse(result.content[0].text).self).toBe('codex-2')
      }, { timeout: 5000 })

      mcp.child.stdin.end()
      expect(await mcp.exited).toEqual([0, null])
      await vi.waitFor(() => expect(messages.snapshot().agents.some(agent => agent.mcpConnected)).toBe(false))
    } finally {
      if (mcp && mcp.child.exitCode === null && !mcp.child.signalCode) mcp.child.kill()
      await mcp?.exited
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 12000)

  it('rotates an accepted reconnect credential and retires the previous lease and tool token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-reconnect-credential-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const sockets = []
    let at = Date.now()
    let id
    let unavailable = false
    let sameLiveCli = false
    const messages = createAgentMessages({
      bridgeFile, home: root, isLocked: () => false, notify: () => {}, now: () => at,
      bindLocalAgent: async () => {
        if (unavailable) throw new Error('Process lookup unavailable')
        return ({ agentId, authorizeBinding }) => {
          authorizeBinding(id, false, sameLiveCli)
          id ??= agentId
          return { agentId: id, shellId: 'local:1', detach: () => true }
        }
      }
    })
    try {
      await messages.enableExternalBridge()
      const [, , pipe, token] = fs.readFileSync(bridgeFile, 'utf8').split(/\r?\n/)
      const connect = reconnectToken => watch(pipe, { token, kind: 'claude', cwd: root, reconnectToken }, sockets)
      const original = await connect()
      expect(original.result).toMatchObject({ success: true, reconnectToken: expect.any(String) })
      sameLiveCli = true
      expect((await connect()).result.success).toBe(false)
      unavailable = true
      expect((await connect(original.result.reconnectToken)).result).toMatchObject({ success: false, error: 'Process lookup unavailable' })
      expect(messages.snapshot().agents).toMatchObject([{ id, mcpConnected: true }])

      unavailable = false
      const renewed = await connect(original.result.reconnectToken)
      expect(renewed.result.success).toBe(true)
      expect(renewed.result.reconnectToken).not.toBe(original.result.reconnectToken)
      await original.closed
      expect((await connect(original.result.reconnectToken)).result.success).toBe(false)
      expect((await rpc({ method: 'list' }, { pipe, token: original.result.token })).success).toBe(false)
      expect(await rpc({ method: 'list' }, { pipe, token: renewed.result.token })).toMatchObject({ success: true, self: id })

      renewed.socket.end()
      await renewed.closed
      await vi.waitFor(() => expect(messages.snapshot().agents[0].mcpConnected).toBe(false))
      at += 5 * 60 * 1000
      expect((await connect(renewed.result.reconnectToken)).result.success).toBe(false)
      expect(messages.snapshot().agents).toMatchObject([{ id, mcpConnected: false }])
      sameLiveCli = false
      expect((await connect()).result.success).toBe(false)
      sameLiveCli = true
      const restartedMcp = await connect()
      expect(await rpc({ method: 'list' }, { pipe, token: restartedMcp.result.token })).toMatchObject({ success: true, self: id })
    } finally {
      for (const socket of sockets) socket.destroy()
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires the sleeping shell to authorize its first wake lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-wake-credential-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const sockets = []
    let id
    let waking = false
    const messages = createAgentMessages({
      bridgeFile, home: root, isLocked: () => false, notify: () => {},
      bindLocalAgent: async () => ({ agentId, authorizeBinding }) => {
        authorizeBinding(id, waking)
        id ??= agentId
        return { agentId: id, shellId: 'local:1', detach: () => true }
      }
    })
    try {
      await messages.enableExternalBridge()
      const [, , pipe, token] = fs.readFileSync(bridgeFile, 'utf8').split(/\r?\n/)
      const shell = messages.registerShell('local:1')
      const connect = auth => watch(pipe, { kind: 'claude', cwd: root, ...auth }, sockets)
      const original = await connect({ token })
      expect(original.result.success).toBe(true)
      messages.sleep(id, '33c07864-8c95-4da7-8a7d-5b06b468a545')
      original.socket.end()
      await original.closed
      waking = true
      expect((await connect({ token })).result.success).toBe(false)
      const resumed = await connect({ wakeToken: shell.EZSHELL_SHELL_TOKEN })
      expect(resumed.result.success).toBe(true)
      waking = false
      expect(messages.snapshot().agents).toMatchObject([{ id, mcpConnected: true }])
      expect(messages.snapshot().agents[0]).not.toHaveProperty('sleeping')
      expect((await connect({ wakeToken: shell.EZSHELL_SHELL_TOKEN })).result.success).toBe(false)
    } finally {
      for (const socket of sockets) socket.destroy()
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('registers a typed Claude with its own shell token and no shared bridge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-shell-mcp-'))
    const sockets = []
    let mcp
    const messages = createAgentMessages({
      home: root, isLocked: () => false, notify: () => {},
      bindLocalAgent: async ({ pid, shellId }) => {
        if (pid === mcp?.child.pid && shellId === 'local:1') {
          return ({ agentId, authorizeBinding }) => {
            authorizeBinding(null)
            return { agentId, shellId, detach: () => true }
          }
        }
      }
    })
    try {
      await messages.ready()
      const shell = messages.registerShell('local:1')
      const otherShell = messages.registerShell('local:2')
      const pipe = shell.EZSHELL_AGENT_PIPE
      mcp = startStdio(root, { ...shell, EZSHELL_AGENT_SHELL_KIND: 'claude' })
      const request = { kind: 'claude', cwd: root, pid: mcp.child.pid }
      const watchShell = auth => watch(pipe, { ...request, ...auth }, sockets)
      expect((await watchShell({ shellToken: otherShell.EZSHELL_SHELL_TOKEN })).result.success).toBe(false)
      expect((await watchShell({ wakeToken: shell.EZSHELL_SHELL_TOKEN })).result.success).toBe(false)
      expect((await watchShell({ shellToken: shell.EZSHELL_SHELL_TOKEN, kind: 'codex' })).result.success).toBe(false)
      expect(messages.snapshot().agents).toEqual([])

      await mcp.initialize()
      await vi.waitFor(async () => {
        const result = await mcp.listAgents()
        expect(result.isError).not.toBe(true)
        const { self, agents } = JSON.parse(result.content[0].text)
        expect(agents).toMatchObject([{ id: self, kind: 'claude', cwd: root }])
        expect(messages.snapshot().agents).toMatchObject([{ id: self, shellId: 'local:1', mcpConnected: true }])
      })
    } finally {
      for (const socket of sockets) socket.destroy()
      mcp?.child.stdin.end()
      if (mcp) await mcp.exited
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries its latest credential across socket closure within the same stdio process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-reconnect-stdio-'))
    const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\' + path.basename(root) : path.join(root, 'messages.sock')
    const requests = []
    const sockets = []
    const server = net.createServer(socket => {
      sockets.push(socket)
      socket.on('error', () => {})
      let input = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        input += chunk
        if (!input.includes('\n')) return
        requests.push(JSON.parse(input.slice(0, input.indexOf('\n'))))
        socket.write(JSON.stringify({ success: true, token: 'fixture-tool', reconnectToken: 'fixture-' + requests.length }) + '\n')
      })
    })
    let mcp
    try {
      await new Promise(resolve => server.listen(pipe, resolve))
      mcp = startStdio(root, { EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: 'fixture-scope' })
      await mcp.initialize()
      for (let index = 0; index < 3; index++) {
        await vi.waitFor(() => expect(requests.length).toBe(index + 1), { timeout: 5000 })
        expect(requests[index].reconnectToken).toBe(index ? 'fixture-' + index : undefined)
        await new Promise(resolve => sockets[index].end(resolve))
      }
      mcp.child.stdin.end()
      expect(await mcp.exited).toEqual([0, null])
    } finally {
      if (mcp && mcp.child.exitCode === null && !mcp.child.signalCode) mcp.child.kill()
      await mcp?.exited
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 12000)

  it('preserves the first scoped lease and never converts its stale token into a bridge registration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-scoped-reconnect-test-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const startApp = () => createAgentMessages({ bridgeFile, notify: () => {}, isLocked: () => false })
    let messages = startApp()
    let mcp
    try {
      await messages.enableExternalBridge()
      const { env } = messages.register('codex', 'local:1', root, {})
      const pipe = env.EZSHELL_AGENT_PIPE
      const token = env.EZSHELL_AGENT_TOKEN
      mcp = startStdio(root, { EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: token,
        EZSHELL_AGENT_BRIDGE_FILE: bridgeFile, EZSHELL_AGENT_BRIDGE_KIND: 'codex' })
      await mcp.initialize()
      await vi.waitFor(() => expect(messages.snapshot().agents[0].mcpConnected).toBe(true))
      expect(await rpc({ method: 'watch-mcp' }, { pipe, token })).toMatchObject({ success: false, error: expect.stringContaining('이미 연결') })
      expect(JSON.parse((await mcp.listAgents()).content[0].text).self).toBe(env.EZSHELL_AGENT_ID)

      messages.stop()
      messages = startApp()
      await messages.enableExternalBridge()
      await sleep(1250)
      expect(await mcp.listAgents()).toEqual(reconnectError)
      expect(messages.snapshot().agents).toEqual([])

      mcp.child.stdin.end()
      expect(await mcp.exited).toEqual([0, null])
    } finally {
      if (mcp && mcp.child.exitCode === null && !mcp.child.signalCode) mcp.child.kill()
      await mcp?.exited
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 12000)
})

describe('pausing the shared bridge for an update', () => {
  it('stops the launcher from starting the app until the next start writes the bridge again', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-bridge-pause-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const messages = createAgentMessages({ bridgeFile, notify: () => {}, isLocked: () => false })
    try {
      await messages.enableExternalBridge()
      messages.pauseExternalBridge()
      // The Windows launcher needs four lines and the POSIX one two: a single line starts nothing
      expect(fs.readFileSync(bridgeFile, 'utf8').split(/\r?\n/).filter(Boolean)).toHaveLength(1)
      // No temporary file left behind
      expect(fs.readdirSync(root).filter(name => name.includes('.') && !/\.\d+$/.test(name))).toEqual([])

      await messages.enableExternalBridge()
      expect(fs.readFileSync(bridgeFile, 'utf8').split('\n').filter(Boolean)).toHaveLength(4)
    } finally {
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not create the bridge for a user who never set up the message MCP', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-bridge-pause-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const messages = createAgentMessages({ bridgeFile, notify: () => {}, isLocked: () => false })
    try {
      messages.pauseExternalBridge()
      expect(fs.existsSync(bridgeFile)).toBe(false)
    } finally {
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
