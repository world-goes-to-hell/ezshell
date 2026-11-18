const net = require('net')
const { randomUUID } = require('crypto')
const fs = require('fs')
const { tmpdir } = require('os')
const path = require('path')

const MAX_REQUEST = 64 * 1024
const MAX_MESSAGES = 500
const MAX_TEXT = 8000
const INBOX_WAIT_MS = 30000
const USER = 'user'

function createAgentMessages({ notify, isLocked, onInboxChanged = () => {}, bindLocalAgent, bridgeFile, platform = process.platform }) {
  const agents = new Map()
  const tokens = new Map()
  const mcpReady = new Map()
  const bridgeToken = randomUUID()
  const leases = new Map()
  const receivedByAgent = new Set()
  const messages = []
  const sockets = new Set()
  const inboxWaits = new Map()
  let serial = 0
  let revision = 0
  let runtime
  let server
  let directory
  let pipe

  const publicMessage = ({ requestId, ...message }) => message
  const inbox = (id, unread) => messages.filter(message => message.to === id && (!unread || !message.read)).map(publicMessage)
  function readInbox(id, unread) {
    const result = inbox(id, unread)
    for (const message of result) if (!message.read) receivedByAgent.add(message.id)
    return result
  }
  function snapshot() {
    const waiting = new Set(Array.from(inboxWaits.values(), wait => wait.agentId))
    return {
      revision,
      agents: Array.from(agents.values(), agent => ({
        ...agent,
        waitingForReply: waiting.has(agent.id),
        mcpConnected: mcpReady.has(agent.id)
      })),
      messages: messages.map(publicMessage)
    }
  }
  function changed(delivery) {
    revision++
    notify('agent-messages-state', snapshot())
    if (delivery) notify('agent-message-delivered', delivery)
  }

  function deliver(from, request) {
    const { text, replyTo, requestId } = request
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('메시지를 1~8000자로 입력해 주세요.')
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 100)) throw new Error('요청 ID가 올바르지 않습니다.')
    const original = replyTo === undefined ? null : messages.find(item => item.id === replyTo && item.to === from)
    if (replyTo !== undefined && !original) throw new Error('답장할 메시지를 찾을 수 없습니다.')
    const to = original ? original.from : request.to
    const existing = requestId && messages.find(item => item.from === from && item.requestId === requestId)
    if (existing) {
      if (existing.to !== to || existing.text !== text || existing.replyTo !== replyTo) throw new Error('같은 요청 ID에 다른 내용이 있습니다.')
      return { id: existing.id }
    }
    if (from === to || (to !== USER && !isConnected(to))) throw new Error('메시지를 받을 실행 중인 에이전트를 찾을 수 없습니다.')
    if (messages.length >= MAX_MESSAGES) throw new Error('이번 실행의 메시지 한도에 도달했습니다.')
    const message = { id: randomUUID(), from, to, text, replyTo, requestId, sentAt: Date.now(), read: false }
    messages.push(message)
    if (original) original.read = true
    let deliveredToWaiter = false
    for (const [socket, wait] of inboxWaits) {
      if (wait.agentId !== to || socket.destroyed) continue
      finishWait(socket, { success: true, messages: readInbox(to, true) })
      deliveredToWaiter = true
    }
    changed({ id: message.id, from, to, toShell: agents.get(to)?.shellId })
    const recipient = agents.get(to)?.shellId
    if (recipient && !deliveredToWaiter) onInboxChanged(recipient)
    return { id: message.id }
  }

  function acknowledge(id, recipient) {
    const message = messages.find(item => item.id === id && (recipient === undefined || item.to === recipient))
    if (!message) throw new Error('메시지를 찾을 수 없습니다.')
    if (!message.read) {
      message.read = true
      changed()
    }
    return { id }
  }

  function respond(request, socket) {
    const from = tokens.get(request?.token)
    if (!from) throw new Error('활성 ezShell 에이전트 세션에서 실행해 주세요.')
    if (isLocked()) throw new Error('먼저 앱 잠금을 해제해 주세요.')
    switch (request.method) {
      case 'list': return { agents: [...agents.values()].filter(agent => isConnected(agent.id)).map(({ id, kind, cwd }) => ({ id, kind, cwd })), self: from }
      case 'inbox': return { messages: readInbox(from, request.unread) }
      case 'wait-inbox': {
        const unread = readInbox(from, true)
        if (unread.length) return { messages: unread }
        waitForInbox(socket, from)
        return null
      }
      case 'ack': return acknowledge(request.id, from)
      case 'send': return deliver(from, request)
      default: throw new Error('지원하지 않는 명령입니다.')
    }
  }

  function isConnected(id) {
    const lease = mcpReady.get(id)
    return agents.get(id)?.active === true && lease != null && !lease.destroyed
  }

  function archiveExternal(id, token) {
    tokens.delete(token)
    const agent = agents.get(id)
    if (messages.some(message => message.from === id || message.to === id)) {
      agents.set(id, { ...agent, shellId: '', active: false, status: 'ended' })
    } else {
      agents.delete(id)
    }
    for (const [socket, wait] of inboxWaits) {
      if (wait.agentId === id) finishWait(socket, inactiveError())
    }
  }

  function setStatus(id, status) {
    const agent = agents.get(id)
    if (!agent?.active || agent.status === status) return
    agents.set(id, { ...agent, status })
    changed()
  }

  async function watchMcp(request, socket) {
    let token = request.token
    let id = tokens.get(token)
    const external = id === undefined
    let binding
    if (external) {
      if (!bridgeFile || token !== bridgeToken || !['codex', 'claude'].includes(request.kind)
        || typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd) || request.cwd.length > 4096) {
        throw new Error('ezShell에 등록된 에이전트가 아닙니다.')
      }
      if (mcpReady.size >= 40) throw new Error('실행 중인 메시지 MCP 연결이 너무 많습니다.')
      id = `${request.kind}-${++serial}`
      if (Number.isSafeInteger(request.pid) && request.pid > 0) {
        binding = await bindLocalAgent?.({
          pid: request.pid, kind: request.kind,
          setStatus: status => setStatus(id, status),
          disconnect: () => socket.destroy()
        })
      }
      if (socket.destroyed || mcpReady.size >= 40) {
        binding?.close()
        if (socket.destroyed) return
        throw new Error('실행 중인 메시지 MCP 연결이 너무 많습니다.')
      }
      token = randomUUID()
      tokens.set(token, id)
      agents.set(id, { id, shellId: binding?.shellId ?? '', kind: request.kind, cwd: request.cwd, active: true, status: binding?.status ?? 'unknown' })
    }
    const previous = mcpReady.get(id)
    mcpReady.set(id, socket)
    leases.set(socket, { id, token, external, binding })
    socket.setTimeout(0)
    socket.write(JSON.stringify({ success: true, token }) + '\n')
    previous?.destroy()
    changed()
    const shellId = agents.get(id)?.shellId
    if (shellId) onInboxChanged(shellId)
  }

  const answer = (socket, result) => socket.end(JSON.stringify(result) + '\n')
  const inactiveError = () => ({ success: false, error: '활성 ezShell 에이전트 세션에서 실행해 주세요.' })

  function removeWait(socket) {
    const wait = inboxWaits.get(socket)
    if (!wait) return false
    clearTimeout(wait.timer)
    inboxWaits.delete(socket)
    return true
  }

  function finishWait(socket, result) {
    removeWait(socket)
    if (!socket.destroyed) answer(socket, result)
  }

  function waitForInbox(socket, agentId) {
    socket.setTimeout(0)
    const timer = setTimeout(() => {
      finishWait(socket, isLocked() ? inactiveError() : { success: true, messages: [] })
      changed()
    }, INBOX_WAIT_MS)
    inboxWaits.set(socket, { timer, agentId })
    changed()
  }

  function connect(socket) {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      const lease = leases.get(socket)
      if (lease) {
        leases.delete(socket)
        if (mcpReady.get(lease.id) === socket) {
          mcpReady.delete(lease.id)
          lease.binding?.close()
          if (lease.external) archiveExternal(lease.id, lease.token)
          changed()
        }
      }
      if (removeWait(socket)) changed()
    })
    socket.on('error', () => socket.destroy())
    socket.setTimeout(5000, () => socket.destroy())
    socket.setEncoding('utf8')
    let pending = ''
    socket.on('data', async chunk => {
      pending += chunk
      if (Buffer.byteLength(pending) > MAX_REQUEST) return socket.destroy()
      const end = pending.indexOf('\n')
      if (end < 0) return
      socket.removeAllListeners('data')
      try {
        const request = JSON.parse(pending.slice(0, end))
        if (request?.method === 'watch-mcp') {
          await watchMcp(request, socket)
          return
        }
        const result = respond(request, socket)
        if (result) answer(socket, { success: true, ...result })
      } catch (error) {
        answer(socket, { success: false, error: error.message })
      }
    })
  }

  function stop() {
    for (const socket of inboxWaits.keys()) removeWait(socket)
    for (const socket of sockets) socket.destroy()
    server?.close()
    server = undefined
    if (directory) {
      try { fs.unlinkSync(path.join(directory, platform === 'win32' ? 'ezshell.cmd' : 'ezshell')) } catch {}
      try { fs.unlinkSync(path.join(directory, 'agent-mcp.json')) } catch {}
      try { fs.unlinkSync(path.join(directory, 'messages.sock')) } catch {}
      try { fs.rmdirSync(directory) } catch {}
      directory = undefined
    }
  }

  async function start() {
    directory = fs.mkdtempSync(path.join(tmpdir(), 'ezshell-agent-'))
    pipe = platform === 'win32' ? '\\\\.\\pipe\\ezshell-' + randomUUID() : path.join(directory, 'messages.sock')
    const command = platform === 'win32'
      ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%EZSHELL_CLI_EXE%" "%EZSHELL_CLI_SCRIPT%" %*\r\n'
      : '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$EZSHELL_CLI_EXE" "$EZSHELL_CLI_SCRIPT" "$@"\n'
    fs.writeFileSync(path.join(directory, platform === 'win32' ? 'ezshell.cmd' : 'ezshell'), command, { mode: 0o700 })
    fs.writeFileSync(path.join(directory, 'agent-mcp.json'), JSON.stringify({
      mcpServers: {
        'ezshell-cli-mcp': {
          command: '${EZSHELL_CLI_EXE}',
          args: ['${EZSHELL_AGENT_MCP_SCRIPT}'],
          env: { ELECTRON_RUN_AS_NODE: '1', EZSHELL_AGENT_PIPE: '${EZSHELL_AGENT_PIPE}', EZSHELL_AGENT_TOKEN: '${EZSHELL_AGENT_TOKEN}' }
        }
      }
    }), { mode: 0o600 })
    server = net.createServer(connect)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipe, () => { server.off('error', reject); resolve() })
    })
  }

  function ready() {
    runtime ??= start().catch(error => {
      stop()
      runtime = undefined
      throw error
    })
    return runtime
  }

  async function enableExternalBridge() {
    if (!bridgeFile) throw new Error('메시지 MCP 설정 경로가 없습니다.')
    await ready()
    const fields = [process.execPath, path.join(__dirname, 'agentMessageMcp.js'), pipe, bridgeToken]
    if (fields.some(field => /[\r\n]/.test(field))) throw new Error('메시지 MCP 파일 경로에 줄바꿈이 있습니다.')
    const temporary = bridgeFile + '.' + randomUUID()
    try {
      fs.writeFileSync(temporary, fields.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, bridgeFile)
    } finally {
      try { fs.unlinkSync(temporary) } catch {}
    }
  }

  function register(kind, shellId, cwd, shellEnv) {
    const id = `${kind}-${++serial}`
    const token = randomUUID()
    agents.set(id, { id, shellId, kind, cwd, active: true, status: 'unknown' })
    tokens.set(token, id)
    changed()
    const key = Object.keys(shellEnv).find(name => platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH') ?? 'PATH'
    const env = {
      ...shellEnv,
      [key]: directory + (shellEnv[key] ? path.delimiter + shellEnv[key] : ''),
      EZSHELL_AGENT_ID: id,
      EZSHELL_AGENT_PIPE: pipe,
      EZSHELL_AGENT_TOKEN: token,
      EZSHELL_CLI_EXE: process.execPath,
      EZSHELL_CLI_SCRIPT: path.join(__dirname, 'agentMessageCli.js'),
      EZSHELL_AGENT_MCP_SCRIPT: path.join(__dirname, 'agentMessageMcp.js'),
      EZSHELL_AGENT_MCP_CONFIG: path.join(directory, 'agent-mcp.json')
    }
    const stopReceiving = () => {
      tokens.delete(token)
      const lease = mcpReady.get(id)
      mcpReady.delete(id)
      lease?.destroy()
      for (const [socket, wait] of inboxWaits) {
        if (wait.agentId === id) finishWait(socket, inactiveError())
      }
    }
    return {
      env,
      setStatus: status => setStatus(id, status),
      finish(exitCode) {
        const agent = agents.get(id)
        if (!agent?.active) return
        stopReceiving()
        const status = agent.status === 'error' || (exitCode && exitCode !== 130) ? 'error' : 'ended'
        agents.set(id, { ...agent, active: false, status, exitCode })
        changed()
      },
      close() {
        const agent = agents.get(id)
        if (!agent) return
        stopReceiving()
        if (messages.some(message => message.from === id || message.to === id)) {
          if (!agent.active) return
          agents.set(id, { ...agent, active: false, status: 'ended' })
        } else agents.delete(id)
        changed()
      }
    }
  }

  function unreadFor(shellId) {
    if (isLocked()) return []
    const agent = [...agents.values()].find(candidate => candidate.shellId === shellId && isConnected(candidate.id))
    return agent ? messages.filter(message =>
      message.to === agent.id && !message.read && !receivedByAgent.has(message.id)
    ).map(message => message.id) : []
  }

  return { ready, enableExternalBridge, register, stop, snapshot, sendAsUser: request => deliver(USER, request), acknowledge, unreadFor }
}

module.exports = { createAgentMessages }
