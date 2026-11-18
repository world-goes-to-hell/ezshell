const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const runFile = promisify(execFile)
const windowsProcessList = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "{0} {1}" -f $_.ProcessId,$_.ParentProcessId }'

// The installed MCP server is a child of the CLI, which is a child of the terminal shell.
async function getProcessParents(platform = process.platform) {
  const command = platform === 'win32' ? 'powershell.exe' : '/bin/ps'
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', windowsProcessList]
    : ['-axo', 'pid=,ppid=']
  const { stdout } = await runFile(command, args, { timeout: 3000, windowsHide: true })
  const parents = new Map()
  for (const line of stdout.split('\n')) {
    const pair = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (pair) parents.set(Number(pair[1]), Number(pair[2]))
  }
  return parents
}

module.exports = { getProcessParents }
