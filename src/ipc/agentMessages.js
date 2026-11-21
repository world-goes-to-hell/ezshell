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
const { sanitizeUsage, sameUsage } = require('./agentUsage.js')

function createAgentMessages({ notify, isLocked, onInboxChanged = () => {}, bindLocalAgent, bridgeFile, platform = process.platform }) {
  const agents = new Map()
  const tokens = new Map()
  const mcpReady = new Map()
  const bridgeToken = randomUUID()
  const leases = new Map()
  // agent id → latest usage (agentUsage.js shape)
  const usages = new Map()
  // Every local shell's token → its id, for the status line of a Claude typed into it (registerShell)
  const shellTokens = new Map()
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
  // `read`: handled (answered or acknowledged). `seenAt`: when the recipient took it from its inbox, the
  // "읽음" the sender and the messages panel see (check_sent). Receipts were removed on 2026-11-20.
  function readInbox(id, unread) {
    const taken = messages.filter(message => message.to === id && (!unread || !message.read))
    const now = Date.now()
    let seen = false
    for (const message of taken) {
      if (message.seenAt) continue
      message.seenAt = now
      seen = true
    }
    if (seen) changed()
    return taken.map(publicMessage)
  }

  const PREVIEW_CHARS = 200
  const SENT_LIMIT = 20
  /** The sender's view of what it sent: unread / read (taken, no answer yet) / answered */
  function sentStatus(from, ids) {
    const mine = messages.filter(message => message.from === from && (!ids || ids.includes(message.id)))
    return mine.slice(ids ? 0 : -SENT_LIMIT).map(message => {
      const reply = messages.find(item => item.replyTo === message.id && item.from === message.to)
      const status = message.read || reply ? 'answered' : message.seenAt ? 'read' : 'unread'
      return {
        id: message.id,
        to: message.to,
        text: message.text.length > PREVIEW_CHARS ? message.text.slice(0, PREVIEW_CHARS) + '…' : message.text,
        sentAt: message.sentAt,
        status,
        readAt: message.seenAt ?? null,
        ...(status === 'answered' ? { answer: reply ? { kind: 'reply', id: reply.id } : { kind: 'acknowledged' } } : {})
      }
    })
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
    // An agent started before the update still has send_receipt: taken as a reply it would close the
    // request without its result, so it is refused with what to do instead
    if (request.receipt === true) throw new Error('수신 확인은 없어졌습니다. 상대는 읽음 여부를 check_sent 로 봅니다. 결과는 reply_to_message 로 보내 주세요.')
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
    const message = { id: randomUUID(), from, to, text, replyTo, requestId, sentAt: Date.now(), read: false, seenAt: null }
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
    const message = messages.find(item => item.id === id && item.to === recipient)
    if (!message) throw new Error('메시지를 찾을 수 없습니다.')
    if (!message.read) {
      message.read = true
      changed()
    }
    return { id }
  }

  function respond(request, socket) {
    // The status line of a Claude typed into a local shell has no agent token, only its shell's
    if (request?.method === 'usage' && typeof request.shellToken === 'string') {
      const shellId = shellTokens.get(request.shellToken)
      if (!shellId) throw new Error('ezShell 로컬 터미널에서 실행해 주세요.')
      if (isLocked()) throw new Error('먼저 앱 잠금을 해제해 주세요.')
      const agent = [...agents.values()].find(candidate => candidate.shellId === shellId && candidate.active && candidate.kind === 'claude')
      return { stored: agent ? setUsage(agent.id, request.usage) : false }
    }
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
      case 'sent': {
        const ids = request.ids
        if (ids !== undefined && (!Array.isArray(ids) || ids.length > SENT_LIMIT || ids.some(value => typeof value !== 'string' || value.length > 100))) {
          throw new Error('메시지 ID 목록이 올바르지 않습니다.')
        }
        return { messages: sentStatus(from, ids) }
      }
      // From the status line command of a Claude ezShell launched: saved as this agent's usage only
      case 'usage': return { stored: setUsage(from, request.usage) }
      case 'send': return deliver(from, request)
      default: throw new Error('지원하지 않는 명령입니다.')
    }
  }

  // A sleeping agent (agentIdle.js: its CLI was closed to save memory, it comes back on its next message)
  // still takes messages: they wait in its inbox and wake it
  function isConnected(id) {
    const agent = agents.get(id)
    if (agent?.active === true && agent.sleeping) return true
    const lease = mcpReady.get(id)
    return agent?.active === true && lease != null && !lease.destroyed
  }

  function stopWaiting(id) {
    for (const [socket, wait] of inboxWaits) {
      if (wait.agentId === id) finishWait(socket, inactiveError())
    }
  }

  function archiveExternal(id) {
    const agent = agents.get(id)
    if (!agent) return
    // Asleep: its CLI and MCP went away on purpose; it is kept (with its usage and session id) to be resumed
    if (agent.sleeping) {
      stopWaiting(id)
      return
    }
    clearUsage(id)
    if (messages.some(message => message.from === id || message.to === id)) {
      agents.set(id, { ...agent, shellId: '', active: false, status: 'ended' })
    } else {
      agents.delete(id)
    }
    stopWaiting(id)
  }

  function endExternal(id) {
    const socket = mcpReady.get(id)
    const lease = leases.get(socket)
    if (lease?.external) {
      tokens.delete(lease.token)
      mcpReady.delete(id)
      socket.destroy()
    }
    // Put to sleep on purpose: kept, under the same id, for the CLI resumed in its shell (archiveExternal)
    archiveExternal(id)
    changed()
  }

  /** The agent's CLI is being closed to save memory: it stays listed and takes messages (session id to resume) */
  function sleep(id, sessionId) {
    const agent = agents.get(id)
    if (!agent?.active) return false
    agents.set(id, { ...agent, sleeping: true, status: 'sleeping', ...(sessionId ? { resumeId: sessionId } : {}) })
    changed()
    return true
  }

  /** Not resuming after all (closing failed, the shell was closed, the user kept the terminal) */
  function cancelSleep(id, { ended }) {
    const agent = agents.get(id)
    if (!agent?.sleeping) return
    const { sleeping, ...rest } = agent
    agents.set(id, { ...rest, status: 'idle' })
    if (ended) archiveExternal(id)
    changed()
  }

  function setStatus(id, status) {
    const agent = agents.get(id)
    if (!agent?.active || agent.sleeping || agent.status === status) return
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
      const attach = Number.isSafeInteger(request.pid) && request.pid > 0
        ? await bindLocalAgent?.({ pid: request.pid, kind: request.kind })
        : undefined
      if (socket.destroyed) return
      if (mcpReady.size >= 40) throw new Error('실행 중인 메시지 MCP 연결이 너무 많습니다.')
      id = `${request.kind}-${++serial}`
      binding = attach?.({ agentId: id, setStatus: status => setStatus(id, status), onExit: endExternal })
      id = binding?.agentId ?? id
      token = randomUUID()
      tokens.set(token, id)
      // startedAt: its MCP connects a little after the CLI started (and wrote its Codex session file)
      const before = agents.get(id)
      const startedAt = before?.startedAt ?? Date.now() - 30_000
      // Woken from sleep (same id): the resumed session's file is found by its id
      const resumed = before?.sleeping && before.resumeId ? { resumeId: before.resumeId } : {}
      agents.set(id, { id, shellId: binding?.shellId ?? '', kind: request.kind, cwd: request.cwd, active: true, status: binding?.status ?? 'unknown', startedAt, ...resumed })
    }
    const previous = mcpReady.get(id)
    mcpReady.set(id, socket)
    leases.set(socket, { id, token, external, binding })
    socket.setTimeout(0)
    socket.write(JSON.stringify({ success: true, token }) + '\n')
    if (external && previous) tokens.delete(leases.get(previous)?.token)
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
        if (lease.external) tokens.delete(lease.token)
        if (mcpReady.get(lease.id) === socket) {
          mcpReady.delete(lease.id)
          if (lease.external) {
            if (lease.binding?.detach()) stopWaiting(lease.id)
            else archiveExternal(lease.id)
          }
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
      try { fs.unlinkSync(path.join(directory, 'agent-settings.json')) } catch {}
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
    // Added with --settings to the Claude ezShell launches, for that run only (the user's own status
    // line stays in their settings). Claude runs it in Git Bash on Windows and sh elsewhere.
    fs.writeFileSync(path.join(directory, 'agent-settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_USAGE_SCRIPT"', padding: 0 }
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

  function register(kind, shellId, cwd, shellEnv, resumeId = null) {
    const id = `${kind}-${++serial}`
    const token = randomUUID()
    // startedAt: Codex usage is read from the session file it starts after this (codexUsageWatcher);
    // resumeId: a resumed session writes on in its old file, found by this id instead
    agents.set(id, { id, shellId, kind, cwd, active: true, status: 'unknown', startedAt: Date.now(), ...(resumeId ? { resumeId } : {}) })
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
      EZSHELL_AGENT_MCP_CONFIG: path.join(directory, 'agent-mcp.json'),
      // Claude only: its status line reports usage to the app instead of drawing rows (agentUsageReport.js)
      EZSHELL_AGENT_SETTINGS: path.join(directory, 'agent-settings.json'),
      EZSHELL_AGENT_USAGE_SCRIPT: path.join(__dirname, 'agentUsageReport.js')
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
        clearUsage(id)
        const status = agent.status === 'error' || (exitCode && exitCode !== 130) ? 'error' : 'ended'
        agents.set(id, { ...agent, active: false, status, exitCode })
        changed()
      },
      close() {
        const agent = agents.get(id)
        if (!agent) return
        stopReceiving()
        clearUsage(id)
        if (messages.some(message => message.from === id || message.to === id)) {
          if (!agent.active) return
          agents.set(id, { ...agent, active: false, status: 'ended' })
        } else agents.delete(id)
        changed()
      }
    }
  }

  const connectedAgentOf = shellId => [...agents.values()].find(candidate => candidate.shellId === shellId && isConnected(candidate.id))

  /** Messages for the agent in this shell that it has not read yet: the terminal wakes it for these */
  function unreadFor(shellId) {
    if (isLocked()) return []
    const agent = connectedAgentOf(shellId)
    return agent ? messages.filter(message =>
      message.to === agent.id && !message.read && !message.seenAt
    ).map(message => message.id) : []
  }

  /** Messages it has not answered or acknowledged yet, read or not: a request put off while busy stays here */
  function unhandledFor(shellId) {
    if (isLocked()) return []
    const agent = connectedAgentOf(shellId)
    return agent ? messages.filter(message => message.to === agent.id && !message.read).map(message => message.id) : []
  }

  /**
   * The latest usage of an agent (Claude's status line through the pipe, Codex's session file through
   * codexUsageWatcher). Only the window hears of it, and only when it changed.
   */
  function setUsage(agentId, value) {
    const agent = agents.get(agentId)
    if (!agent?.active) return false
    const clean = sanitizeUsage(value, agent.kind)
    if (!clean) return false
    const previous = usages.get(agentId)
    // A long Codex turn can push its settings out of the transcript tail while usage keeps arriving.
    if (agent.kind === 'codex' && previous && previous.sessionId === clean.sessionId) {
      clean.model ??= previous.model
      if (clean.model === previous.model) clean.effort ??= previous.effort
    }
    if (sameUsage(previous, clean)) return true
    usages.set(agentId, clean)
    notify('agent-usage', { agentId, shellId: agent.shellId ?? null, usage: clean })
    return true
  }

  /**
   * A model / effort the shell's agent just switched to (agentPicker.js read the CLI's confirmation): the
   * usage line shows it now, before the agent's own next report
   */
  function applyPicked(shellId, applied) {
    const agent = [...agents.values()].find(candidate => candidate.shellId === shellId && candidate.active)
    const usage = agent && usages.get(agent.id)
    if (!usage) return false
    return setUsage(agent.id, { ...usage, ...applied })
  }

  function clearUsage(agentId) {
    if (!usages.delete(agentId)) return
    notify('agent-usage', { agentId, shellId: agents.get(agentId)?.shellId ?? null, usage: null })
  }

  /**
   * What every local shell gets in its environment (needs `ready()`): its own token, so the usage
   * status line of a Claude typed into it can report for that shell's agent, and the status line's
   * settings for the shell's `claude` wrapper (localShell.js).
   */
  function registerShell(shellId) {
    if (!directory || !pipe) return {}
    forgetShell(shellId)
    const token = randomUUID()
    shellTokens.set(token, shellId)
    return {
      EZSHELL_SHELL_TOKEN: token,
      EZSHELL_AGENT_PIPE: pipe,
      EZSHELL_CLI_EXE: process.execPath,
      EZSHELL_AGENT_SETTINGS: path.join(directory, 'agent-settings.json'),
      EZSHELL_AGENT_USAGE_SCRIPT: path.join(__dirname, 'agentUsageReport.js')
    }
  }

  function forgetShell(shellId) {
    for (const [token, id] of shellTokens) if (id === shellId) shellTokens.delete(token)
  }

  /** For a window that starts (or reloads) after the reports came in */
  function usageSnapshot() {
    return [...usages].flatMap(([agentId, usage]) => {
      const agent = agents.get(agentId)
      return agent?.active ? [{ agentId, shellId: agent.shellId ?? null, usage }] : []
    })
  }

  return {
    ready, enableExternalBridge, register, stop, snapshot, unreadFor, unhandledFor,
    sendAsUser: request => deliver(USER, request),
    setUsage, applyPicked, usageSnapshot, registerShell, forgetShell, sleep, cancelSleep
  }
}

module.exports = { createAgentMessages }
