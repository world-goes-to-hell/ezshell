const startedAt = Date.now()
const { readHookInput } = require('./ipc/agentHookInput.js')
const { eventFromHookFields } = require('./ipc/agentHookEvent.js')
const { rpc } = require('./ipc/agentMessageCli.js')
const { PROMPT, REMIND_PROMPT } = require('./ipc/agentInboxPrompts.js')

const HOOK_COMMANDS = Object.freeze({
  claude: 'ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_HOOK_SCRIPT" claude',
  codex: 'ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_HOOK_SCRIPT" codex',
  codexWindows: "$env:ELECTRON_RUN_AS_NODE='1'; & $env:EZSHELL_CLI_EXE $env:EZSHELL_AGENT_HOOK_SCRIPT codex"
})

async function main() {
  try {
    const input = await readHookInput(process.stdin)
    const event = input && eventFromHookFields(process.argv[2], input.fields, startedAt, input.subagent)
    const { EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: token, EZSHELL_SHELL_TOKEN: shellToken } = process.env
    const remaining = startedAt + 1500 - Date.now()
    if (!event || !pipe || (!token && !shellToken) || remaining <= 0) return
    const options = { pipe, token: token || 'shell', signal: AbortSignal.timeout(remaining) }
    const payload = token ? event : { ...event, shellToken }
    const checkStop = input.complete && event.event === 'Stop'
    const recorded = await rpc({ method: 'agent-event', ...payload, ...(checkStop ? { checkStop: true } : {}) }, options)
    if (!recorded?.success || !recorded.stored || !checkStop) return
    const decision = await rpc({ method: 'stop-check', ...payload }, options)
    if (decision?.success && (decision.block === PROMPT || decision.block === REMIND_PROMPT)) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.block }) + '\n')
    }
  } catch {
    // Leave the CLI's turn alone if the input or the app is unavailable.
  } finally {
    process.stdin.destroy()
  }
}

if (require.main === module) void main()

module.exports = { HOOK_COMMANDS }
