// Claude Code's status line command for a Claude that ezShell launched (`--settings`, see
// agentMessages.js). It reads the status line input, sends the usage numbers to the app over the
// agent message pipe and prints only a color reset: Claude then draws no status line row at all
// (an empty output still kept one blank row). Whatever fails, the output stays the same.
const { claudeUsageFromStatus } = require('./agentUsage.js')
const { rpc } = require('./agentMessageCli.js')

const MAX_INPUT = 256 * 1024
const RESET = '\x1b[0m'

function readInput() {
  return new Promise(resolve => {
    let data = ''
    const done = () => resolve(data)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
      if (data.length > MAX_INPUT) { data = ''; done() }
    })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
    // Claude writes the input and closes it; never hang the status line
    setTimeout(done, 1500).unref()
  })
}

async function main() {
  try {
    const usage = claudeUsageFromStatus(JSON.parse(await readInput()))
    const { EZSHELL_AGENT_PIPE: pipe, EZSHELL_AGENT_TOKEN: token, EZSHELL_SHELL_TOKEN: shellToken } = process.env
    // A Claude ezShell launched has its own agent token; one typed into a local shell has the shell's
    const request = token ? { method: 'usage', usage } : shellToken ? { method: 'usage', usage, shellToken } : null
    if (usage && pipe && request) {
      await Promise.race([rpc(request, { pipe, token: token ?? 'shell' }), new Promise(resolve => setTimeout(resolve, 1500).unref())])
    }
  } catch {
    // The terminal shows nothing either way
  }
  process.stdout.write(RESET)
}

main().finally(() => setTimeout(() => process.exit(0), 10).unref())
