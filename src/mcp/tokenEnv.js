// Stores the MCP token in the user's environment (Windows) so a project's .mcp.json can refer to it.
// Only terminals and Claude Code instances started afterwards see the new value.
const childProcess = require('child_process')
const path = require('path')
const { TOKEN_ENV_VAR } = require('./clientSetup.js')

const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const TIMEOUT_MS = 15000
// The token arrives on stdin: a command line ends up in process-creation audit logs, and execFile's
// error text repeats it. SetEnvironmentVariable(…, 'User') broadcasts the change like setx does.
const SCRIPT = [
  '$value = [Console]::In.ReadLine()',
  "if ($value -notmatch '^[0-9a-f]{64}$') { exit 2 }",
  `[Environment]::SetEnvironmentVariable('${TOKEN_ENV_VAR}', $value, 'User')`
].join('; ')

/** Full path, so a powershell.exe in the current directory is never picked up */
const powershellPath = (env) => path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Never err.message: for execFile it starts with the whole command line. */
function describeFailure(err) {
  if (err.code === 'ENOENT') return 'PowerShell 을 찾을 수 없습니다.'
  if (err.killed) return '환경 변수 설정이 시간 안에 끝나지 않았습니다.'
  if (typeof err.code === 'number') return `환경 변수 설정 명령이 실패했습니다 (종료 코드 ${err.code}).`
  return '환경 변수 설정 명령을 실행하지 못했습니다.'
}

/** @returns {Promise<{ status: 'set' } | { status: 'unsupported' } | { status: 'failed', error: string }>} */
function setTokenEnv(token, { platform = process.platform, execFile = childProcess.execFile, env = process.env } = {}) {
  if (platform !== 'win32') return Promise.resolve({ status: 'unsupported' })
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return Promise.resolve({ status: 'failed', error: '토큰 형식이 올바르지 않습니다.' })
  }
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT]
    const options = { windowsHide: true, shell: false, timeout: TIMEOUT_MS }
    try {
      const child = execFile(powershellPath(env), args, options, (err) => {
        resolve(err ? { status: 'failed', error: describeFailure(err) } : { status: 'set' })
      })
      child.stdin.on('error', () => { /* the callback reports the failure */ })
      child.stdin.end(`${token}\n`)
    } catch (err) {
      resolve({ status: 'failed', error: describeFailure(err) })
    }
  })
}

module.exports = { setTokenEnv }
