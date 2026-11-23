const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { rpc } = require('./agentMessageCli.js')

const MAX_INPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATES = {
  authenticating: 'starting', initializing: 'starting', idle: 'idle',
  working: 'working', tool_use: 'working', reviewing: 'working', error: 'error'
}

/** Only the status needed by the live shell crosses the pipe. The CLI's transcript_path can point at the App's store. */
function antigravityStatusFromInput(value, platform = process.platform) {
  if (value?.product !== 'antigravity' || typeof value.cwd !== 'string' || value.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(value.cwd)) return null
  const windows = platform === 'win32'
  if (windows ? !/^[a-z]:[\\/]/i.test(value.cwd) : !path.posix.isAbsolute(value.cwd) || value.cwd.startsWith('//')) return null
  const ids = [value.conversation_id, value.session_id].filter(id => id !== undefined && id !== '')
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id))) return null
  const [id, legacyId] = ids.map(id => id.toLowerCase())
  if (legacyId && legacyId !== id) return null
  const state = value.agent_state
  return {
    cwd: (windows ? path.win32 : path.posix).normalize(value.cwd),
    sessionId: id ?? null,
    status: value.tool_confirmation_pending === true ? 'blocked' : typeof state === 'string' && Object.hasOwn(STATES, state) ? STATES[state] : 'unknown'
  }
}

function antigravityStatusSettings(home, platform) {
  let original
  try {
    const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
    if (fs.statSync(file).size <= MAX_INPUT_BYTES) {
      original = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).statusLine
    }
  } catch { /* agy can start before the user has any settings */ }
  const forward = original?.enabled !== false && typeof original?.command === 'string' ? original.command.trim() : ''
  // agy 1.5.4 escapes quotes when it hands statusLine.command to cmd.exe. Expand the quoted
  // path inside cmd instead, then run the launcher's quoted Electron command from that batch file.
  const command = platform === 'win32'
    ? '%EZSHELL_ANTIGRAVITY_STATUS_COMMAND%'
    : 'ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_ANTIGRAVITY_STATUS_SCRIPT"'
  const statusLine = { type: 'command', command, stack_with_default: !forward || original.stack_with_default === true }
  if (forward && Number.isSafeInteger(original.padding) && original.padding >= 0) statusLine.padding = original.padding
  return { statusLine, forward }
}

async function readInput(stdin) {
  let data = ''
  stdin.setEncoding('utf8')
  for await (const chunk of stdin) {
    data += chunk
    if (Buffer.byteLength(data) > MAX_INPUT_BYTES) return ''
  }
  return data
}

/** Forward the original status-line input to the user's existing command and keep its display. */
function forwardStatusLine(command, input, env, stdout) {
  if (!command) return
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.EZSHELL_ANTIGRAVITY_STATUS_FORWARD
  const expanded = command.replace(/^~(?=[\\/])/, () => require('node:os').homedir())
  return new Promise(resolve => {
    const child = spawn(expanded, { env: childEnv, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill()
      child.stdin.destroy()
      child.stdout.destroy()
      child.unref()
      resolve()
    }, 3500)
    let bytes = 0
    child.once('error', () => { clearTimeout(timer); resolve() })
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.stdout.on('data', chunk => {
      if (bytes < MAX_OUTPUT_BYTES) stdout.write(chunk.subarray(0, MAX_OUTPUT_BYTES - bytes))
      bytes += chunk.length
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function runStatusReporter({ stdin = process.stdin, stdout = process.stdout, env = process.env, request = rpc } = {}) {
  const input = await readInput(stdin)
  if (!input) return
  const display = forwardStatusLine(env.EZSHELL_ANTIGRAVITY_STATUS_FORWARD, input, env, stdout)
  const { EZSHELL_AGENT_PIPE: pipe, EZSHELL_SHELL_TOKEN: token } = env
  try {
    const value = JSON.parse(input)
    if (pipe && token && antigravityStatusFromInput(value)) {
      const { product, cwd, conversation_id, session_id, agent_state, tool_confirmation_pending } = value
      await request({ method: 'antigravity-status', pid: process.pid, value: {
        product, cwd, conversation_id, session_id, agent_state, tool_confirmation_pending
      } }, { pipe, token })
    }
  } catch { /* A status line keeps rendering while the app is locked or shutting down. */ }
  await display
}

if (require.main === module) runStatusReporter().catch(() => {})

module.exports = { antigravityStatusFromInput, antigravityStatusSettings, runStatusReporter }
