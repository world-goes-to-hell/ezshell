// Each agent launches this MCP server with its own message service credentials.
const { McpServer, z } = require('../mcp/sdk.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const fs = require('node:fs')
const net = require('node:net')
const { rpc } = require('./agentMessageCli.js')

const instructions = 'Use these tools to collaborate with agents opened in ezShell. When ezShell says a message arrived, call read_inbox and confirm each request at once with send_receipt, in the language of the message: if you are free, say you got it and are starting; if you are in the middle of other work, say what you are finishing first and that you will continue after it. Then handle the request within your delegated task and tool permissions, and send the result with reply_to_message. Use acknowledge_message for notes that need no reply. Never confirm or answer a receipt (receipt: true): it only says your message arrived, so keep waiting for the result.'
const text = z.string().trim().min(1).max(8000)
const id = z.string().min(1).max(100)

function connectionOptions() {
  const { EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: token, EZSHELL_AGENT_BRIDGE_FILE: bridgeFile,
    EZSHELL_AGENT_BRIDGE_KIND: kind } = process.env
  if (pipe && token) return { pipe, token }
  if (!bridgeFile || !['codex', 'claude'].includes(kind)) throw new Error('ezShell 메시지 MCP 설정을 확인해 주세요.')
  let fields
  try { fields = fs.readFileSync(bridgeFile, 'utf8').split(/\r?\n/) }
  catch { throw new Error('ezShell 앱을 실행한 뒤 다시 연결해 주세요.') }
  return { pipe: fields[2], token: fields[3], kind }
}

function openLease({ pipe, token, kind }) {
  return new Promise((resolve, reject) => {
    const offline = () => new Error('ezShell 앱을 실행한 뒤 메시지 MCP를 다시 연결해 주세요.')
    const socket = net.createConnection(pipe)
    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => socket.destroy(offline()))
    socket.on('error', () => reject(offline()))
    socket.on('end', () => reject(offline()))
    socket.on('connect', () => socket.write(JSON.stringify({ method: 'watch-mcp', token, kind, cwd: process.cwd(), pid: process.pid }) + '\n'))
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
        resolve({ pipe, token: reply.token, socket })
      } catch (error) {
        socket.destroy()
        reject(error)
      }
    }
    socket.on('data', receive)
  })
}

async function main() {
  const options = connectionOptions()
  let registration
  let closed = false
  const server = new McpServer({ name: 'ezshell-cli-mcp', version: '1.0.0' }, { instructions })
  const call = async request => {
    try {
      if (!registration) throw new Error('메시지 MCP 초기화가 끝나지 않았습니다.')
      const lease = await registration
      const { success, ...result } = await rpc(request, lease)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(success ? {} : { isError: true }) }
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
  }
  server.registerTool('list_agents', { description: 'List connected ezShell agents and your own agent ID.' },
    () => call({ method: 'list' }))
  server.registerTool('send_message', {
    description: 'Send a task or note to another ezShell agent. A task can start when the recipient is waiting for input.',
    inputSchema: { to: id, text, request_id: id.optional().describe('Reuse this ID when retrying the same send.') }
  }, ({ to, text, request_id }) => call({ method: 'send', to, text, requestId: request_id }))
  server.registerTool('read_inbox', {
    description: 'Read messages sent to you. Returns unread messages by default. Confirm each new request right away with send_receipt, then reply with the result (or acknowledge) after handling. A message with receipt: true only confirms delivery; do not answer it.',
    inputSchema: { unread_only: z.boolean().default(true) }
  }, ({ unread_only }) => call({ method: 'inbox', unread: unread_only }))
  server.registerTool('wait_for_message', {
    description: 'Wait up to 30 seconds for unread ezShell messages while an active task is waiting for a teammate. Returns as soon as mail arrives. A receipt (receipt: true) is not the result: wait again for the reply.'
  }, () => call({ method: 'wait-inbox' }))
  server.registerTool('send_receipt', {
    description: 'Confirm a request as soon as you read it, before working on it. Write one short line in the language of the message: that you got it and are starting, or what you are finishing first and that you will continue after it. The request stays open: send the result later with reply_to_message.',
    inputSchema: { message_id: id, text: z.string().trim().min(1).max(500), request_id: id.optional() }
  }, ({ message_id, text, request_id }) => call({ method: 'send', replyTo: message_id, text, receipt: true, requestId: request_id }))
  server.registerTool('reply_to_message', {
    description: 'Reply to the sender and mark the original message as read.',
    inputSchema: { message_id: id, text, request_id: id.optional() }
  }, ({ message_id, text, request_id }) => call({ method: 'send', replyTo: message_id, text, requestId: request_id }))
  server.registerTool('acknowledge_message', {
    description: 'Mark a message as read when it needs no reply.',
    inputSchema: { message_id: id }
  }, ({ message_id }) => call({ method: 'ack', id: message_id }))

  server.server.oninitialized = () => {
    if (registration || closed) return
    registration = openLease(options)
    void registration.then(({ socket }) => {
      if (closed) socket.destroy()
      else socket.once('close', () => { void server.close().catch(() => {}) })
    }, error => {
      console.error(error.message)
      void server.close().catch(() => {})
    })
  }
  const onInputEnd = () => { void server.close().catch(() => {}) }
  process.stdin.once('end', onInputEnd)
  server.server.onclose = () => {
    closed = true
    process.stdin.off('end', onInputEnd)
    if (registration) void registration.then(({ socket }) => socket.destroy(), () => {})
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
module.exports = { run }
