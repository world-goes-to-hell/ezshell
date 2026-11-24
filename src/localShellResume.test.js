import { describe, it, expect, vi } from 'vitest'
import { createLocalShells } from './localShell.js'

// Resuming a past session from the agent history panel (src/agentHistory)
const ID = '01a1ec18-9b8a-71c1-839d-2e31c010300f'

function launchArgs({ platform, agent, resume, messaging = true, mode, restoring }) {
  const spawn = vi.fn(() => ({ write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }))
  const shells = createLocalShells({
    spawn,
    send: () => {},
    agents: messaging ? { register: () => ({ env: {}, close() {} }), codexHookMode: () => mode } : undefined,
    shell: platform === 'win32' ? { file: 'powershell.exe', args: ['-NoLogo'], name: 'PowerShell' } : { file: '/bin/zsh', args: ['-l'], name: 'zsh' },
    cwd: platform === 'win32' ? 'C:\\' : '/',
    env: {},
    platform
  })
  const { id } = shells.open({ agent, resume, restoring })
  shells.close(id)
  return spawn.mock.calls[0][1]
}

const launch = options => launchArgs(options).at(-1)

describe('usage of a Claude typed into a shell', () => {
  it('gives every shell its token and forgets it when the shell closes', () => {
    const spawn = vi.fn(() => ({ write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }))
    const forgetShell = vi.fn()
    const shells = createLocalShells({
      spawn, send: () => {},
      agents: { registerShell: id => ({ EZSHELL_SHELL_TOKEN: 'token-of-' + id, EZSHELL_AGENT_SETTINGS: 'C:\\s.json' }), forgetShell },
      shell: { file: 'powershell.exe', args: ['-NoLogo'], name: 'PowerShell' }, cwd: 'C:\\', env: {}, platform: 'win32'
    })
    const { id } = shells.open({})
    const [, args, options] = spawn.mock.calls[0]
    expect(options.env).toMatchObject({ EZSHELL_SHELL_TOKEN: 'token-of-' + id, EZSHELL_AGENT_SETTINGS: 'C:\\s.json' })
    expect(args.at(-1)).toContain('function global:claude')
    shells.close(id)
    expect(forgetShell).toHaveBeenCalledWith(id)
  })
})

describe('resuming an agent session', () => {
  it('passes the Claude session as --resume, keeping the messaging config', () => {
    expect(launch({ platform: 'win32', agent: 'claude', resume: ID })).toContain(`& $cli --resume ${ID} --mcp-config`)
    expect(launch({ platform: 'linux', agent: 'claude', resume: ID })).toBe(`exec claude --resume ${ID} --mcp-config "$EZSHELL_AGENT_MCP_CONFIG" --settings "$EZSHELL_AGENT_SETTINGS"`)
  })

  it('gives a Claude the usage status line of this run (agentUsageReport.js)', () => {
    expect(launch({ platform: 'win32', agent: 'claude' })).toContain('--settings "$env:EZSHELL_AGENT_SETTINGS"')
    expect(launch({ platform: 'linux', agent: 'codex' })).not.toContain('--settings')
  })

  it('puts the Codex resume subcommand before its options', () => {
    const windows = launch({ platform: 'win32', agent: 'codex', resume: ID })
    expect(windows).toContain(`& $cli resume ${ID} @ezShellArgs -c "mcp_servers.ezshell-cli-mcp.command=`)
    const posix = launch({ platform: 'linux', agent: 'codex', resume: ID })
    expect(posix).toContain(`exec codex resume ${ID} --no-daemon "$@"`)
    expect(posix).toContain(`*) exec codex resume ${ID} "$@"`)
    expect(launch({ platform: 'linux', agent: 'codex', resume: ID, messaging: false })).toBe(`exec codex resume ${ID}`)
  })

  it('starts a new session when there is nothing to resume', () => {
    expect(launch({ platform: 'linux', agent: 'claude', messaging: false })).toBe('exec claude')
  })

  it('adds Codex hooks before approval on manual launches and waits for approval on restore', () => {
    const settings = { platform: 'win32', agent: 'codex', resume: ID }
    expect(launch({ ...settings, mode: 'pending' })).toContain('Get-EzShellCodexHookArgs $cli $false')
    expect(launch({ ...settings, mode: 'pending', restoring: true })).not.toContain('Get-EzShellCodexHookArgs')
    expect(launch({ ...settings, mode: 'approved', restoring: true })).toContain('Get-EzShellCodexHookArgs $cli $true')
    expect(launch({ ...settings, mode: 'disabled' })).not.toContain('Get-EzShellCodexHookArgs')
    expect(launch({ ...settings, platform: 'linux', mode: 'pending' })).toContain('hooks.SessionStart=')
  })

  it('refuses anything but a session id, and resuming without an agent', () => {
    expect(() => launchArgs({ platform: 'linux', agent: 'claude', resume: `${ID}; rm -rf ~` })).toThrow()
    expect(() => launchArgs({ platform: 'win32', agent: 'codex', resume: '--help' })).toThrow()
    expect(() => launchArgs({ platform: 'linux', agent: undefined, resume: ID })).toThrow()
  })
})
