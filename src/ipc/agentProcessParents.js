const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const runFile = promisify(execFile)
const windowsProcessList = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath | ' +
  'ForEach-Object { "{0} {1} {2}`t{3}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.ExecutablePath }'

// The installed MCP server is a child of the CLI, which is a child of the terminal shell.
async function getProcessTree(platform = process.platform) {
  const command = platform === 'win32' ? 'powershell.exe' : '/bin/ps'
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', windowsProcessList]
    : ['-axo', 'pid=,ppid=,comm=']
  const { stdout } = await runFile(command, args, { timeout: 3000, windowsHide: true })
  const processes = new Map()
  for (const line of stdout.split('\n')) {
    const [identity, executable] = platform === 'win32' ? line.trimEnd().split('\t') : [line]
    const process = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(identity)
    if (process) processes.set(Number(process[1]), { parent: Number(process[2]), name: process[3], executable })
  }
  return processes
}

module.exports = { getProcessTree }
