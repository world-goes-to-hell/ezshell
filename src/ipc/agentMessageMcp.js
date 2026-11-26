// Each agent launches this MCP server with its own message service credentials.
const { McpServer, StdioServerTransport, z } = require('../mcp/sdkStdio.js')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { rpc } = require('./agentMessageCli.js')
const { getProcessTree } = require('./agentProcessParents.js')
const { validEscalationReason } = require('./agentInspection.js')

// Sent to every agent that connects, on every turn: keep it short.
// Details go in the tool descriptions. A Claude skill would reach Claude only and need files in ~/.claude.
const notifiedArrival = 'When ezShell says a message arrived, call read_inbox: the sender sees that you have read it.'
const notifiedReply = 'Read the result when ezShell notifies you of new mail.'
const instructions = [
  'Use these tools to collaborate with agents opened in ezShell.',
  'send_message takes an agent ID. When asked to message an agent by role (for example "the reviewer"), call list_agents and use the ID whose role matches; if none or several match, ask the user.',
  'The recipient cannot see your conversation. Write each request so it stands alone: the goal, the files involved, what you already checked, and the answer you expect back.',
  notifiedArrival,
  'Handle the request within your delegated task and tool permissions, then send the result with reply_to_message, leading with the outcome.',
  'Use acknowledge_message for notes that need no reply.',
  'After sending a request, continue other work or finish your turn.',
  notifiedReply,
  'Use check_sent to see whether the recipient has read and answered. A busy agent reads mail when its current task ends, so unread can be normal for a while.',
  'Before sending again, call inspect_agent: resend only if it is idle and the message is still unread, use escalate if it waits for a human decision, otherwise wait or tell the user.',
  'When several agents work together, set your role with set_role so others can find you.',
  'In your answers, write local file paths as inline code (for example `src/app.js:12`): the ezShell chat view turns them into links.'
].join(' ')
const asideInstructions = instructions
  .replace(notifiedArrival, 'Check read_inbox at the start of a task and periodically while working. Aside does not receive new-mail notifications from ezShell.')
  .replace(notifiedReply, 'Check read_inbox for replies when you resume work.')
const text = z.string().trim().min(1).max(8000)
const id = z.string().min(1).max(100)
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000]
const RECONNECTING = 'ezShell과 다시 연결하는 중입니다.'

function readBridge(file) {
  try {
    const [executable, , pipe, token] = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    return executable && pipe && token ? { executable, pipe, token } : null
  } catch { return null }
}

function runningBridges(file) {
  const directory = path.dirname(file)
  const prefix = `${path.basename(file)}.`
  const instances = new Map()
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
      const suffix = entry.name.slice(prefix.length)
      const pid = Number(suffix)
      if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(pid)) continue
      try { process.kill(pid, 0) } catch { continue }
      const bridge = readBridge(path.join(directory, entry.name))
      if (bridge) instances.set(pid, bridge)
    }
  } catch { /* The shared bridge can still be read directly. */ }
  return instances
}

async function connectionOptions(env = process.env, processTree = getProcessTree, pid = process.pid) {
  const { EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: token, EZSHELL_AGENT_BRIDGE_FILE: bridgeFile,
    EZSHELL_AGENT_BRIDGE_KIND: kind, EZSHELL_AGENT_WAKE_KIND: wakeKind, EZSHELL_AGENT_SHELL_KIND: shellKind,
    EZSHELL_SHELL_TOKEN: shellToken } = env
  // A managed agent's token identifies that shell in its owning app. The shared bridge
  // cannot prove its identity in a new app, so retries keep using its scoped credentials.
  if (Object.hasOwn(env, 'EZSHELL_AGENT_TOKEN')) {
    if (!pipe || !token || kind === 'aside') throw new Error('ezShell 전용 메시지 MCP 설정을 확인해 주세요.')
    return { pipe, token }
  }
  if (Object.hasOwn(env, 'EZSHELL_AGENT_WAKE_KIND')) {
    if (!pipe || !shellToken || kind === 'aside' || !['codex', 'claude'].includes(wakeKind)) throw new Error('ezShell 깨우기 연결 설정을 확인해 주세요.')
    return { pipe, wakeToken: shellToken, kind: wakeKind }
  }
  if (Object.hasOwn(env, 'EZSHELL_AGENT_SHELL_KIND')) {
    if (!pipe || !shellToken || kind === 'aside' || shellKind !== 'claude') throw new Error('ezShell 로컬 터미널 연결 설정을 확인해 주세요.')
    return { pipe, shellToken, kind: shellKind }
  }
  if (!bridgeFile || !['codex', 'claude', 'aside'].includes(kind)) throw new Error('ezShell 메시지 MCP 설정을 확인해 주세요.')
  const shared = readBridge(bridgeFile)
  const instances = runningBridges(bridgeFile)
  const available = [...instances.values()]
  const inherited = pipe && available.find(bridge => bridge.pipe === pipe)
  let selected = inherited || shared
  if (!inherited && available.some(bridge => bridge.pipe !== shared?.pipe)) {
    const processes = await processTree().catch(() => null)
    const visited = new Set()
    for (let parent = processes?.get(pid)?.parent; parent > 0 && !visited.has(parent); parent = processes.get(parent)?.parent) {
      visited.add(parent)
      const instance = instances.get(parent)
      const name = processes.get(parent)?.name
      if (instance && name && path.basename(name).toLowerCase() === path.basename(instance.executable).toLowerCase()) {
        selected = instance
        break
      }
    }
  }
  if (!selected) throw new Error('ezShell 앱을 실행한 뒤 다시 연결해 주세요.')
  return { pipe: selected.pipe, token: selected.token, kind }
}

function openLease({ pipe, token, kind, wakeToken, shellToken }, reconnectToken, signal) {
  return new Promise((resolve, reject) => {
    const offline = () => new Error('ezShell 앱을 실행한 뒤 메시지 MCP를 다시 연결해 주세요.')
    const socket = net.createConnection({ path: pipe, signal })
    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => socket.destroy(offline()))
    socket.on('error', () => reject(offline()))
    socket.once('close', () => reject(offline()))
    socket.on('connect', () => socket.write(JSON.stringify({
      method: 'watch-mcp', token, kind, wakeToken, shellToken, reconnectToken, cwd: process.cwd(), pid: process.pid
    }) + '\n'))
    let response = ''
    const receive = chunk => {
      response += chunk
      const end = response.indexOf('\n')
      if (end < 0) return
      socket.off('data', receive)
      try {
        const reply = JSON.parse(response.slice(0, end))
        if (!reply.success || typeof reply.token !== 'string') throw Error(reply.error)
        socket.setTimeout(0)
        resolve({ pipe, token: reply.token, reconnectToken: reply.reconnectToken, socket })
      } catch (error) {
        socket.destroy()
        reject(error)
      }
    }
    socket.on('data', receive)
  })
}

async function main() {
  const lifetime = new AbortController()
  let lease = null
  let reconnect = null
  let retryTimer = null
  let retryStep = 0
  let initialized = false
  const aside = process.env.EZSHELL_AGENT_BRIDGE_KIND === 'aside'
  const server = new McpServer({ name: 'ezshell-cli-mcp', version: '1.0.0' }, { instructions: aside ? asideInstructions : instructions })
  const retry = () => {
    if (lifetime.signal.aborted) return
    const delay = RETRY_DELAYS[retryStep]
    retryStep = Math.min(retryStep + 1, RETRY_DELAYS.length - 1)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void register()
    }, delay)
  }
  async function register() {
    try {
      const options = await connectionOptions()
      if (lifetime.signal.aborted) return
      const reconnectToken = reconnect?.pipe === options.pipe ? reconnect.token : undefined
      const connection = await openLease(options, reconnectToken, lifetime.signal)
      if (typeof connection.reconnectToken === 'string') reconnect = { pipe: options.pipe, token: connection.reconnectToken }
      if (connection.socket.destroyed || connection.socket.readableEnded || lifetime.signal.aborted) {
        connection.socket.destroy()
        retry()
        return
      }
      lease = connection
      retryStep = 0
      connection.socket.once('close', () => {
        lease = null
        retry()
      })
    } catch {
      retry()
    }
  }
  const call = async (request, signal) => {
    const current = lease
    try {
      if (!current || current.socket.destroyed || current.socket.readableEnded) throw new Error(RECONNECTING)
      const { success, ...result } = await rpc(request, { ...current, signal })
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(success ? {} : { isError: true }) }
    } catch (error) {
      return { content: [{ type: 'text', text: current === lease ? error.message : RECONNECTING }], isError: true }
    }
  }
  server.registerTool('list_agents', { description: 'List connected ezShell agents with their IDs and roles, along with your own agent ID. Use it to find the ID of an agent named by its role.' },
    () => call({ method: 'list' }))
  server.registerTool('inspect_agent', {
    description: 'Inspect an ezShell agent by ID. Returns status, source, what is blocking it, unread count, idle milliseconds and exit code.',
    inputSchema: { id }
  }, ({ id }) => call({ method: 'inspect-agent', id }))
  server.registerTool('escalate', {
    description: 'Alert the user once when an ezShell agent is waiting for a human decision.',
    inputSchema: { id, reason: z.string().refine(validEscalationReason, 'Use one line of 1–200 characters.') }
  }, ({ id, reason }) => call({ method: 'escalate', id, reason }))
  server.registerTool('set_role', {
    description: 'Set the short role shown for your own ezShell agent in this app session. A user-assigned role takes priority.',
    inputSchema: { role: z.string().describe('A visible label of up to 20 characters. Agent ID and reserved-name lookalikes are rejected, as are labels beginning with 나 or 사용자. An empty string clears your role.') }
  }, ({ role }) => call({ method: 'set-role', role }))
  server.registerTool('send_message', {
    description: 'Send a task or note to another ezShell agent by ID (list_agents shows IDs and roles). The recipient cannot see your conversation, so include the context it needs. After sending a task, continue other work or finish your turn. ' + (aside ? 'Check read_inbox for replies.' : 'ezShell notifies you when the result arrives.'),
    inputSchema: { to: id, text, request_id: id.optional().describe('Reuse this ID when retrying the same send.') }
  }, ({ to, text, request_id }) => call({ method: 'send', to, text, requestId: request_id }))
  server.registerTool('read_inbox', {
    description: 'Read messages sent to you. Returns messages you have not answered yet by default. Reading marks them read for the sender. Reply with the result (or acknowledge) after handling.',
    inputSchema: { unread_only: z.boolean().default(true) }
  }, ({ unread_only }) => call({ method: 'inbox', unread: unread_only }))
  server.registerTool('check_sent', {
    description: 'Check the messages you sent: status is unread (not read yet), read (read, no answer yet; readAt is when) or answered (replied or acknowledged). Without message_ids, your last 20.',
    inputSchema: { message_ids: z.array(id).max(20).optional() }
  }, ({ message_ids }) => call({ method: 'sent', ...(message_ids ? { ids: message_ids } : {}) }))
  server.registerTool('reply_to_message', {
    description: 'Reply to the sender with the result. For a browser element request, include the task status. If a deferred task is finished later, reply to the original message again with completed.',
    inputSchema: {
      message_id: id, text, request_id: id.optional(),
      status: z.enum(['completed', 'deferred']).optional().describe('Use completed when the requested change is finished. Use deferred when the change is postponed or blocked and explain why in the reply.')
    }
  }, ({ message_id, text, request_id, status }) => call({ method: 'send', replyTo: message_id, text, requestId: request_id, replyStatus: status }))
  server.registerTool('acknowledge_message', {
    description: 'Mark a message as handled when it needs no reply.',
    inputSchema: { message_id: id }
  }, ({ message_id }) => call({ method: 'ack', id: message_id }))

  const runName = z.string().trim().min(1).max(40)
  server.registerTool('run_list', { description: 'List the project presets and their status in your local shell’s worktree, including presets with agent control off.' },
    (_args, extra) => call({ method: 'run-list' }, extra?.signal))
  for (const action of ['start', 'restart', 'stop']) {
    server.registerTool(`run_${action}`, { description: `${action[0].toUpperCase() + action.slice(1)} a project preset by name in your worktree. Requires agentControl.`, inputSchema: { name: runName } },
      ({ name }, extra) => call({ method: `run-${action}`, name }, extra?.signal))
  }
  server.registerTool('run_wait', {
    description: 'Wait up to 300 seconds for readiness or the next hot reload result in your worktree. Works with agent control off.',
    inputSchema: { name: runName, seconds: z.number().int().min(1).max(300).optional(), until: z.enum(['ready', 'reload']).optional() }
  }, ({ name, seconds, until }, extra) => call({ method: 'run-wait', name, seconds, until }, extra?.signal))
  server.registerTool('run_log', {
    description: 'Read recent output or, with errors: true, error groups, current diagnosis suggestions and the status of your proposals for a preset in your worktree. Works with agent control off.',
    inputSchema: { name: runName, lines: z.number().int().min(1).max(400).optional(), errors: z.literal(true).optional() }
  }, ({ name, lines, errors }, extra) => call({ method: 'run-log', name, lines, errors }, extra?.signal))
  server.registerTool('run_propose', {
    description: 'Ask the user to review one current diagnosis from run_log with errors: true. Works with agent control off. The user approves edits in the app.',
    inputSchema: {
      name: runName,
      suggestion: z.string().regex(/^[a-f0-9]{64}$/).describe('The suggestion value from run_log for the current diagnosis.'),
      url: z.string().max(2048).optional().describe('For mavenMirror, a replacement HTTPS or local file:/// URL.'),
      jar: z.string().min(1).max(4096).optional().describe('For tomcatJar, a project-relative path or a unique dependency coordinate shown by run_log.'),
      note: z.string().trim().min(1).max(1000).describe('Explain briefly what the user should review.')
    }
  }, ({ name, suggestion, url, jar, note }, extra) => call({ method: 'run-propose', name, suggestion, url, jar, note }, extra?.signal))

  server.server.oninitialized = () => {
    if (initialized || lifetime.signal.aborted) return
    initialized = true
    void register()
  }
  const onInputEnd = () => { void server.close().catch(() => {}) }
  process.stdin.once('end', onInputEnd)
  server.server.onclose = () => {
    process.stdin.off('end', onInputEnd)
    clearTimeout(retryTimer)
    lifetime.abort()
  }
  await server.connect(new StdioServerTransport())
}

function run() {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

if (require.main === module) run()
module.exports = { run, connectionOptions, instructions }
