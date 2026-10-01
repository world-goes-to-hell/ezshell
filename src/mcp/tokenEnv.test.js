import { describe, it, expect, vi } from 'vitest'
import tokenEnvModule from './tokenEnv.js'

const { setTokenEnv } = tokenEnvModule
const TOKEN = 'ab'.repeat(32)
const ENV = { SystemRoot: 'C:\\Windows' }
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Like child_process.execFile: calls back later and hands back a child whose stdin receives the token */
function fakeExecFile(error = null) {
  const written = []
  const execFile = vi.fn((file, args, options, callback) => {
    setImmediate(() => callback(error, '', ''))
    return { stdin: { on: () => {}, end: (text) => written.push(text) } }
  })
  return { execFile, written }
}

const realisticFailure = (extra) => Object.assign(new Error(`Command failed: setx EZSHELL_MCP_TOKEN ${TOKEN}\n`), extra)

describe('setTokenEnv', () => {
  it('sets the user variable through PowerShell by full path, with the token on stdin only', async () => {
    const { execFile, written } = fakeExecFile()
    await expect(setTokenEnv(TOKEN, { platform: 'win32', execFile, env: ENV })).resolves.toEqual({ status: 'set' })
    const [file, args, options] = execFile.mock.calls[0]
    expect(file).toBe(POWERSHELL)
    expect(args.join(' ')).toContain("SetEnvironmentVariable('EZSHELL_MCP_TOKEN'")
    expect(args.join(' ')).not.toContain(TOKEN)
    expect(options).toMatchObject({ windowsHide: true, shell: false })
    expect(written).toEqual([`${TOKEN}\n`])
  })

  it.each([
    ['a non-zero exit', realisticFailure({ code: 1 }), '환경 변수 설정 명령이 실패했습니다 (종료 코드 1).'],
    ['a timeout', realisticFailure({ killed: true, signal: 'SIGTERM' }), '환경 변수 설정이 시간 안에 끝나지 않았습니다.'],
    ['a missing PowerShell', realisticFailure({ code: 'ENOENT' }), 'PowerShell 을 찾을 수 없습니다.']
  ])('reports %s without the error text, which repeats the command line', async (label, error, message) => {
    const { execFile } = fakeExecFile(error)
    const result = await setTokenEnv(TOKEN, { platform: 'win32', execFile, env: ENV })
    expect(result).toEqual({ status: 'failed', error: message })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('falls back to C:\\Windows when SystemRoot is not set', async () => {
    const { execFile } = fakeExecFile()
    await setTokenEnv(TOKEN, { platform: 'win32', execFile, env: {} })
    expect(execFile.mock.calls[0][0]).toBe(POWERSHELL)
  })

  it('does nothing on other systems', async () => {
    const { execFile } = fakeExecFile()
    await expect(setTokenEnv(TOKEN, { platform: 'darwin', execFile })).resolves.toEqual({ status: 'unsupported' })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('refuses anything that is not a token', async () => {
    const { execFile } = fakeExecFile()
    await expect(setTokenEnv('x & del *', { platform: 'win32', execFile, env: ENV })).resolves.toMatchObject({ status: 'failed' })
    expect(execFile).not.toHaveBeenCalled()
  })
})
