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
const suggestionPath = path.join(profile, id + '-suggestion')
const targetPath = path.join(profile, id + '-chat-target')
const claude = kind === 'claude'
const indicator = claude ? '> ' : '› '
let draft = ''
let suggestion = ''
let target = ''
let client = null

// A prompt with choices drawn instead of the composer, as the CLIs do (local-agent-chat)
const approvalPath = path.join(profile, id + '-approval')
let approval = ''
// A screen of the CLI's own, drawn instead of the composer (a chat slash command like /config)
const screenPath = path.join(profile, id + '-screen')
let screen = ''
const commandHistoryPath = path.join(profile, id + '-command-history')
let commandHistory = ''

function draw() {
  if (screen) {
    process.stdout.write('\x1b[2J\x1b[H' + screen)
    return
  }
  if (approval) {
    process.stdout.write('\x1b[2J\x1b[Hfixture ready: ' + id + '\r\n' + approval)
    return
  }
  if (!claude && process.env.EZSHELL_TEST_AGENT_CHAT && ['', '/fast', '/ultrafas', '/ultrafast'].includes(draft)) {
    const setting = path.join(profile, id + '-speed')
    const tier = fs.existsSync(setting) ? fs.readFileSync(setting, 'utf8') : ''
    const speed = tier === 'priority' ? 'Fast' : tier === 'ultrafast' ? 'Ultrafast' : 'Standard'
    const modelFile = path.join(profile, id + '-speed-model')
    const model = fs.existsSync(modelFile) ? fs.readFileSync(modelFile, 'utf8') : 'gpt-6.2-sol'
    const ultrafast = fs.existsSync(path.join(profile, id + '-ultrafast-eligible'))
    const rows = commandHistory ? commandHistory.trimEnd().split('\r\n') : ['fixture ready: ' + id]
    if (draft === '/fast') rows.push('› /fast     toggle faster responses', '')
    if (ultrafast && draft.startsWith('/ultrafas')) rows.push('› /ultrafast     toggle fastest responses', '')
    const row = rows.length + 1
    rows.push(indicator + draft, '', `  ${model} default · ${speed} · /workspace${target ? ' · ' + target : ''}`)
    process.stdout.write('\x1b[2J\x1b[H' + rows.join('\r\n') + `\x1b[${row};${indicator.length + draft.length + 1}H`)
    return
  }
  const lines = draft.split('\n')
  const separator = lines.indexOf('')
  const paths = separator === -1 ? lines : lines.slice(0, separator)
  const unfocusedAttachment = claude && process.env.EZSHELL_TEST_AGENT_CHAT && paths.length > 0 &&
    paths.every(file => file.endsWith('.png') && fs.existsSync(file))
  // The fixture's stdout is not a TTY on Windows. Keep both rules on one row even in a split pane.
  const ruleWidth = unfocusedAttachment ? 16 : Math.max(8, Math.min(process.stdout.columns || 80, 80) - 4)
  const rule = '─'.repeat(ruleWidth)
  const border = claude ? (target ? '─'.repeat(12) + ' ' + target + ' ─' : rule) + '\r\n' : ''
  let footer = unfocusedAttachment ? '\r\n' + rule + '\r\n  ⏵⏵ auto mode on\x1b[3;3H' : ''
  let display = draft
  if (unfocusedAttachment) {
    const tokens = paths.map((_, index) => '[Image #' + (index + 1) + ']').join(' ')
    display = tokens + (separator === -1 ? '' : '\n' + lines.slice(separator + 1).join('\n'))
  }
  if (claude && !draft && suggestion) {
    display = '\x1b[2m' + suggestion + '\x1b[22m'
    footer = '\r\n' + rule + '\r\n  ⏵⏵ bypass permissions on\x1b[3;3H'
  }
  if (!claude && target) {
    if (draft.length > 100) display = `[Pasted Content ${draft.length} chars]`
    footer = '\r\n\r\n  gpt-6 medium · ' + target + `\x1b[2;${display.length + 3}H`
  }
  process.stdout.write('\x1b[2J\x1b[H' + (commandHistory || 'fixture ready: ' + id + '\r\n') + border + indicator + display.replace(/\r?\n/g, '\r\n') + footer)
}

// How it was started (local-agent-sleep: the resumed agent gets the session id and the kept options)
fs.writeFileSync(path.join(profile, id + '-argv'), JSON.stringify(process.argv.slice(3)))
process.stdout.write('\x1b[?2004h\x1b]0;✳ ' + id + '\x07')
draw()
process.stdout.on('resize', draw)

const args = process.argv.slice(3)
const mcpConfigIndex = args.indexOf('--mcp-config')
const mcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : null
async function connectMcp() {
  let entry
  if (!managedId) {
    if (!claude && (!args.includes('--no-daemon') || !args.includes('--yolo'))) {
      throw new Error('Manual Codex launch did not preserve its argument and use the per-terminal server')
    }
    if (claude && mcpConfig && [process.env.EZSHELL_AGENT_WAKE_MCP_CONFIG, process.env.EZSHELL_AGENT_SHELL_MCP_CONFIG].includes(mcpConfig)) {
      const spec = JSON.parse(fs.readFileSync(mcpConfig, 'utf8')).mcpServers['ezshell-cli-mcp']
      const expand = value => value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name])
      entry = {
        command: expand(spec.command), args: spec.args.map(expand),
        env: { ...process.env, ...Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, expand(value)])) }
      }
    } else {
      const { createEntry } = require('../../src/ipc/agentMessageSetup.js')
      entry = createEntry(kind, path.join(profile, 'agent-message-connection'))
    }
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

const manualChatOnly = claude && !managedId && process.env.EZSHELL_TEST_MANUAL_CLAUDE_CHAT
if (manualChatOnly || (claude && !managedId && process.env.EZSHELL_TEST_IDLE_MINUTE_MS)) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const session = path.join(dir, process.pid + '.json')
  const sessionId = fs.readFileSync(path.join(profile, 'manual-claude-session'), 'utf8')
  const procStart = 116444736000000000 + Math.round((Date.now() - process.uptime() * 1000) * 10000)
  fs.writeFileSync(session, JSON.stringify({
    pid: process.pid, sessionId, cwd: process.cwd(), startedAt: Date.now(), procStart, kind: 'interactive', entrypoint: 'cli'
  }))
  process.on('exit', () => fs.rmSync(session, { force: true }))
}
if (!manualChatOnly || (mcpConfig && mcpConfig === process.env.EZSHELL_AGENT_SHELL_MCP_CONFIG)) {
  connectMcp().catch(error => fs.writeFileSync(path.join(profile, id + '-mcp-error'), error.message))
}

// Hook mode (local-agent-hooks): `<id>-hooks` holds a list of hook events, e.g.
// [{ "event": "UserPromptSubmit", "prompt": "p1" }, { "event": "Stop", "prompt": "p1", "delay": 600 }].
// Each one runs the reporter the way Claude Code runs the hook it was given: the command comes from the
// `--settings` file ezShell passed (src/ipc/agentMessages.js), and must be the fixed one. `delay` holds
// that report's input back, so a later event can arrive first (async hooks); `after` starts it later.
// Keep `delay` under 1000: the reporter gives up on its input after 1s (agentHookInput.js) and on the
// whole report after 1.5s, and a report it gives up on is silently not sent. Each result is a line of
// `<id>-hook-log`; when the reporter answers a Stop with `decision: block`, the fake does what Claude does
// with the reason: it reads its inbox (`<id>-block-read`).
const hooksPath = path.join(profile, id + '-hooks')
const hookLogPath = path.join(profile, id + '-hook-log')
const hookSession = require('crypto').randomUUID()
const hookPrompts = new Map()
const promptUuid = name => {
  if (!hookPrompts.has(name)) hookPrompts.set(name, require('crypto').randomUUID())
  return hookPrompts.get(name)
}
function hookCommand(event) {
  const index = args.indexOf('--settings')
  if (!claude || index < 0) return null
  try {
    return JSON.parse(fs.readFileSync(args[index + 1], 'utf8')).hooks?.[event]?.[0]?.hooks?.[0]?.command ?? null
  } catch { return null }
}
function runHook(step) {
  const command = hookCommand(step.event)
  const log = entry => fs.appendFileSync(hookLogPath, JSON.stringify({ event: step.event, prompt: step.prompt, ...entry }) + '\n')
  if (!command) return log({ skipped: true })
  const { HOOK_COMMANDS } = require('../../src/agentHookReport.js')
  if (command !== HOOK_COMMANDS.claude) return log({ error: 'unexpected hook command: ' + command })
  // The same program, script and argument the command names, with ELECTRON_RUN_AS_NODE=1. Windows has no
  // POSIX shell on this test's PATH (Claude Code uses Git Bash), so the command is not handed to one there.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const child = process.platform === 'win32'
    ? require('child_process').spawn(process.env.EZSHELL_CLI_EXE, [process.env.EZSHELL_AGENT_HOOK_SCRIPT, 'claude'], { env, windowsHide: true })
    : require('child_process').spawn('/bin/sh', ['-c', command], { env })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.on('close', () => {
    let block = null
    try { block = stdout.trim() ? JSON.parse(stdout) : null } catch { /* not a decision */ }
    log({ stdout: stdout.trim(), block: block?.decision === 'block' ? block.reason : null })
    if (block?.decision === 'block' && client) {
      client.callTool({ name: 'read_inbox', arguments: {} })
        .then(result => fs.appendFileSync(path.join(profile, id + '-block-read'), JSON.stringify(result) + '\n'))
        .catch(error => fs.appendFileSync(path.join(profile, id + '-block-read'), JSON.stringify({ error: error.message }) + '\n'))
    }
  })
  child.on('error', error => log({ error: error.message }))
  const input = JSON.stringify({
    hook_event_name: step.event,
    session_id: hookSession,
    ...(step.prompt ? { prompt_id: promptUuid(step.prompt) } : {}),
    ...(step.tool ? { tool_use_id: step.tool, tool_name: 'Bash' } : {}),
    ...(step.event === 'Stop' ? { stop_hook_active: step.active === true } : {}),
    ...(step.event === 'SessionStart' ? { source: 'startup' } : {})
  })
  const send = () => child.stdin.end(input)
  if (step.delay) setTimeout(send, step.delay)
  else send()
}

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
  if (fs.existsSync(screenPath)) {
    screen = fs.readFileSync(screenPath, 'utf8')
    fs.unlinkSync(screenPath)
    draw()
  }
  if (fs.existsSync(commandHistoryPath)) {
    commandHistory = fs.readFileSync(commandHistoryPath, 'utf8')
    fs.unlinkSync(commandHistoryPath)
    draw()
  }
  if (fs.existsSync(draftPath)) {
    draft = fs.readFileSync(draftPath, 'utf8')
    fs.unlinkSync(draftPath)
    draw()
  }
  if (fs.existsSync(suggestionPath)) {
    suggestion = fs.readFileSync(suggestionPath, 'utf8')
    fs.unlinkSync(suggestionPath)
    draw()
  }
  if (fs.existsSync(targetPath)) {
    target = fs.readFileSync(targetPath, 'utf8')
    fs.unlinkSync(targetPath)
    draw()
  }
  if (fs.existsSync(titlePath)) {
    process.stdout.write('\x1b]0;' + fs.readFileSync(titlePath, 'utf8') + '\x07')
    fs.unlinkSync(titlePath)
    draw()
  }
  if (fs.existsSync(hooksPath)) {
    const steps = JSON.parse(fs.readFileSync(hooksPath, 'utf8'))
    fs.unlinkSync(hooksPath)
    // `after`: started that many ms later (its reporter's start time, the order main sorts by, comes later)
    for (const step of steps) step.after ? setTimeout(() => runHook(step), step.after) : runHook(step)
  }
  if (fs.existsSync(statusPath)) {
    process.stdout.write('\x1b]7501;' + fs.readFileSync(statusPath, 'utf8') + '\x1b\\')
    fs.unlinkSync(statusPath)
  }
  if (fs.existsSync(exitPath)) {
    const code = Number(fs.readFileSync(exitPath, 'utf8'))
    // Removed so that the agent typed again in the same shell (resumed after a sleep) keeps running
    fs.unlinkSync(exitPath)
    process.exit(code)
  }
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
