const { execFile } = require('node:child_process')
const { homedir } = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { applyServerEntry } = require('../mcp/clientSetup.js')

const runFile = promisify(execFile)
const SERVER_NAME = 'ezshell-cli-mcp'
const LEGACY_SERVER_NAME = 'ezshell_agent'

// Read the running application's executable from a user-owned file. Installed and portable
// builds can replace their executable between runs without rewriting the agent settings.
const windowsBridge = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $bridge = [IO.File]::ReadAllLines($env:EZSHELL_AGENT_BRIDGE_FILE)
  if ($bridge.Count -ne 4) { throw 'Invalid bridge file' }
  $env:ELECTRON_RUN_AS_NODE = '1'
  $child = Start-Process -FilePath $bridge[0] -ArgumentList ([char]34 + $bridge[1] + [char]34) -PassThru -NoNewWindow -Wait
  exit $child.ExitCode
} catch {
  [Console]::Error.WriteLine('Start ezShell and reconnect the ezshell-cli-mcp MCP server.')
  exit 1
}`.trim()

const unixBridge = `
if ! { IFS= read -r executable && IFS= read -r script; } < "$EZSHELL_AGENT_BRIDGE_FILE"; then
  printf '%s\\n' 'Start ezShell and reconnect the ezshell-cli-mcp MCP server.' >&2
  exit 1
fi
ELECTRON_RUN_AS_NODE=1 exec "$executable" "$script"
`.trim()

const encodePowerShell = script => Buffer.from(script, 'utf16le').toString('base64')

function createEntry(kind, bridgeFile, platform = process.platform) {
  const env = { EZSHELL_AGENT_BRIDGE_FILE: bridgeFile, EZSHELL_AGENT_BRIDGE_KIND: kind }
  if (platform !== 'win32') return { command: '/bin/sh', args: ['-c', unixBridge], env }
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(windowsBridge)],
    env
  }
}

const windowsCodex = `
$cli = Get-Command codex.exe,codex.cmd,codex -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$cli) { exit 127 }
$cliArgs = ConvertFrom-Json -InputObject $env:EZSHELL_CODEX_SETUP_ARGS
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
& $cli @cliArgs
exit $LASTEXITCODE
`.trim()

async function runCodex(args, { cwd, platform, env }) {
  const options = { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
  const invocation = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(windowsCodex)]]
    : [platform === 'darwin' ? '/bin/zsh' : '/bin/sh', ['-lc', 'exec codex "$@"', 'ezshell-codex', ...args]]
  if (platform === 'win32') options.env = { ...env, EZSHELL_CODEX_SETUP_ARGS: JSON.stringify(args) }
  try {
    return (await runFile(...invocation, options)).stdout
  } catch (error) {
    if (error.code === 127 || error.code === 'ENOENT') throw new Error('Codex CLI를 찾을 수 없습니다.')
    // Do not relay CLI output. An existing configuration can contain other tools' credentials.
    throw new Error('Codex 설정을 처리하지 못했습니다. Codex CLI의 설정을 확인하세요.')
  }
}

function sameEntry(actual, entry) {
  return actual.type === 'stdio' && actual.command === entry.command
    && JSON.stringify(actual.args) === JSON.stringify(entry.args)
    && ownsEntry(actual, entry)
}

function ownsEntry(actual, entry) {
  return !!actual && Object.entries(entry.env).every(([key, value]) => actual.env?.[key] === value)
}

async function installAgentMessageMcp(kind, {
  bridgeFile, enableBridge, homeDir = homedir(), env = process.env, platform = process.platform,
  codex = args => runCodex(args, { cwd: path.dirname(bridgeFile), platform, env })
}) {
  if (!['codex', 'claude'].includes(kind)) throw new Error('지원하지 않는 실행 도구입니다.')
  const entry = createEntry(kind, bridgeFile, platform)
  if (kind === 'claude') {
    const filePath = path.resolve(env.CLAUDE_CONFIG_DIR || homeDir, '.claude.json')
    await enableBridge()
    const result = applyServerEntry({
      filePath, name: SERVER_NAME, entry: { type: 'stdio', ...entry }, createIfMissing: true,
      legacyNames: [LEGACY_SERVER_NAME],
      ownsExisting: previous => ownsEntry(previous, entry),
      ownsLegacy: previous => ownsEntry(previous, entry)
    }).result
    return result === 'replaced' ? 'added' : result
  }

  let servers
  try { servers = JSON.parse(await codex(['mcp', 'list', '--json'])) }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new Error('Codex MCP 서버 목록을 읽지 못했습니다.')
  }
  if (!Array.isArray(servers)) throw new Error('Codex MCP 서버 목록을 읽지 못했습니다.')
  const existing = servers.find(server => server?.name === SERVER_NAME)
  if (existing && (!ownsEntry(existing.transport, entry) || existing.enabled === false)) return 'conflict'
  const current = existing && sameEntry(existing.transport, entry)
  const legacy = servers.find(server => server?.name === LEGACY_SERVER_NAME && ownsEntry(server.transport, entry))
  await enableBridge()
  if (!current) {
    const environment = Object.entries(entry.env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
    await codex(['mcp', 'add', SERVER_NAME, ...environment, '--', entry.command, ...entry.args])
  }
  if (legacy) await codex(['mcp', 'remove', LEGACY_SERVER_NAME])
  return current && !legacy ? 'unchanged' : 'added'
}

module.exports = { installAgentMessageMcp, createEntry }
