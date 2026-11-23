const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const runFile = promisify(execFile)
const windowsProcessList = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate | ' +
  'ForEach-Object { $t = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; ' +
  '"{0} {1} {2}`t{3}`t{4}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.ExecutablePath,$t }'

// The installed MCP server is a child of the CLI, which is a child of the terminal shell.
async function getProcessTree(platform = process.platform) {
  const command = platform === 'win32' ? 'powershell.exe' : '/bin/ps'
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', windowsProcessList]
    : ['-axo', 'pid=,ppid=,lstart=,comm=']
  const env = platform === 'win32' ? process.env : { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
  const { stdout } = await runFile(command, args, { timeout: 3000, windowsHide: true, env })
  const processes = new Map()
  for (const line of stdout.split('\n')) {
    if (platform === 'win32') {
      const [identity, executable, milliseconds] = line.trimEnd().split('\t')
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(identity)
      if (match) processes.set(Number(match[1]), { parent: Number(match[2]), name: match[3], executable, startedAt: Number(milliseconds) || 0 })
    } else {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(line)
      if (match) processes.set(Number(match[1]), { parent: Number(match[2]), name: match[4], startedAt: Date.parse(match[3] + ' UTC') || 0 })
    }
  }
  return processes
}

module.exports = { getProcessTree }
