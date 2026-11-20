const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const { EZSHELL_AGENT_ID: managedId, EZSHELL_TEST_AGENT_PROFILE: profile } = process.env
const kind = process.argv[2]
const id = managedId ?? 'manual-' + kind
const commandPath = path.join(profile, id + '-command')
const resultPath = path.join(profile, id + '-result')
const titlePath = path.join(profile, id + '-title')
const statusPath = path.join(profile, id + '-program-status')
const exitPath = path.join(profile, id + '-exit-code')
const requestPath = path.join(profile, id + '-mcp-request')
const responsePath = path.join(profile, id + '-mcp-response')
const disconnectPath = path.join(profile, id + '-mcp-disconnect')
const reconnectPath = path.join(profile, id + '-mcp-reconnect')
const draftPath = path.join(profile, id + '-draft')
const claude = kind === 'claude'
const indicator = claude ? '> ' : '› '
let draft = ''
let client = null

// A prompt with choices drawn instead of the composer, as the CLIs do (local-agent-chat)
const approvalPath = path.join(profile, id + '-approval')
let approval = ''

function draw() {
  if (approval) {
    process.stdout.write('\x1b[2J\x1b[Hfixture ready: ' + id + '\r\n' + approval)
    return
  }
  const unfocusedAttachment = claude && process.env.EZSHELL_TEST_AGENT_CHAT && draft.startsWith('첨부 이미지를 열어 확인해 주세요.')
  // The fixture's stdout is not a TTY on Windows. Keep both rules on one row even in a split pane.
  const ruleWidth = unfocusedAttachment ? 16 : Math.max(8, Math.min(process.stdout.columns || 80, 80) - 4)
  const border = claude ? '─'.repeat(ruleWidth) + '\r\n' : ''
  const footer = unfocusedAttachment ? '\r\n' + border + '\r\n  ⏵⏵ auto mode on\x1b[3;3H' : ''
  let display = draft
  if (unfocusedAttachment) {
    const [header, ...lines] = draft.split('\n')
    const separator = lines.indexOf('')
    const paths = separator === -1 ? lines : lines.slice(0, separator)
    if (paths.every(file => file.endsWith('.png') && fs.existsSync(file))) {
      // Actual Claude converts the paths of existing PNGs to image tokens before drawing the draft.
      const tokens = paths.map((_, index) => '[Image #' + (index + 1) + ']').join(' ')
      display = tokens + header + (separator === -1 ? '' : '\n' + lines.slice(separator + 1).join('\n'))
    }
  }
  process.stdout.write('\x1b[2J\x1b[Hfixture ready: ' + id + '\r\n' + border + indicator + display.replace(/\r?\n/g, '\r\n') + footer)
}

process.stdout.write('\x1b[?2004h\x1b]0;✳ ' + id + '\x07')
draw()
process.stdout.on('resize', draw)

async function connectMcp() {
  const args = process.argv.slice(3)
  let entry
  if (!managedId) {
    if (!claude && (!args.includes('--no-daemon') || !args.includes('--yolo'))) {
      throw new Error('Manual Codex launch did not preserve its argument and use the per-terminal server')
    }
    const { createEntry } = require('../../src/ipc/agentMessageSetup.js')
    entry = createEntry(kind, path.join(profile, 'agent-message-connection'))
  } else if (claude) {
    const configIndex = args.indexOf('--mcp-config')
    if (configIndex < 0) throw new Error('No Claude MCP config argument')
    const spec = JSON.parse(fs.readFileSync(args[configIndex + 1], 'utf8')).mcpServers['ezshell-cli-mcp']
    if (spec.command !== '${EZSHELL_CLI_EXE}' || spec.args[0] !== '${EZSHELL_AGENT_MCP_SCRIPT}') throw new Error('Wrong Claude MCP config')
  } else {
    if (!args.includes('--no-daemon')) throw new Error('Managed Codex is using the shared background server')
    for (const field of ['command=', 'args=', 'env_vars=']) {
      if (!args.some(value => value.startsWith('mcp_servers.ezshell-cli-mcp.' + field))) throw new Error('Missing Codex MCP argument ' + field)
    }
  }
  entry ??= { command: process.execPath, args: [process.env.EZSHELL_AGENT_MCP_SCRIPT], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  const connected = new Client({ name: 'fixture-agent', version: '1' })
  await connected.connect(new StdioClientTransport(entry))
  client = connected
  const { tools } = await client.listTools()
  fs.writeFileSync(path.join(profile, id + '-tools'), JSON.stringify(tools.map(tool => tool.name)))
}

connectMcp().catch(error => fs.writeFileSync(path.join(profile, id + '-mcp-error'), error.message))

let running = false
let callingTool = false
setInterval(() => {
  if (client && fs.existsSync(disconnectPath)) {
    fs.unlinkSync(disconnectPath)
    void client.close()
    client = null
  }
  if (!client && fs.existsSync(reconnectPath)) {
    fs.unlinkSync(reconnectPath)
    connectMcp().catch(error => fs.writeFileSync(path.join(profile, id + '-mcp-error'), error.message))
  }
  if (fs.existsSync(approvalPath)) {
    approval = fs.readFileSync(approvalPath, 'utf8')
    fs.unlinkSync(approvalPath)
    draw()
  }
  if (fs.existsSync(draftPath)) {
    draft = fs.readFileSync(draftPath, 'utf8')
    fs.unlinkSync(draftPath)
    draw()
  }
  if (fs.existsSync(titlePath)) {
    process.stdout.write('\x1b]0;' + fs.readFileSync(titlePath, 'utf8') + '\x07')
    fs.unlinkSync(titlePath)
    draw()
  }
  if (fs.existsSync(statusPath)) {
    process.stdout.write('\x1b]7501;' + fs.readFileSync(statusPath, 'utf8') + '\x1b\\')
    fs.unlinkSync(statusPath)
  }
  if (fs.existsSync(exitPath)) process.exit(Number(fs.readFileSync(exitPath, 'utf8')))
  if (client && !callingTool && fs.existsSync(requestPath)) {
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
    fs.unlinkSync(requestPath)
    callingTool = true
    client.callTool(request)
      .then(result => fs.writeFileSync(responsePath, JSON.stringify(result)))
      .catch(error => fs.writeFileSync(responsePath, JSON.stringify({ error: error.message })))
      .finally(() => { callingTool = false })
  }
  if (running || !fs.existsSync(commandPath)) return
  const command = fs.readFileSync(commandPath, 'utf8')
  fs.unlinkSync(commandPath)
  running = true
  exec(command, { env: process.env }, (error, stdout, stderr) => {
    fs.writeFileSync(resultPath, JSON.stringify({ exit: error?.code ?? 0, stdout, stderr }))
    running = false
  })
}, 40)
