import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, promises, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAgentMessages } from './ipc/agentMessages.js'
import { rpc } from './ipc/agentMessageCli.js'
import { PROMPT } from './ipc/agentInboxPrompts.js'
import { createLocalShells, defaultShell, BACKLOG_CHARS } from './localShell.js'
import { portFilter } from './ipc/hotReload.js'

function fakePty() {
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => { pty.emit = cb },
    onExit: (cb) => { pty.exit = cb }
  }
  return pty
}

function setup(options = {}) {
  const ptys = []
  const sent = []
  const spawn = vi.fn((file, args, options) => {
    const pty = fakePty()
    pty.options = options
    ptys.push(pty)
    return pty
  })
  const shells = createLocalShells({
    spawn, send: (channel, payload) => sent.push({ channel, payload }),
    shell: { file: 'sh', args: [], name: 'sh' }, cwd: '/home', env: {},
    commandLine: async () => '', timedProcessTree: options.processTree, ...options
  })
  return { shells, ptys, sent, spawn }
}

describe('defaultShell', () => {
  it('is PowerShell on Windows and the login shell elsewhere', () => {
    expect(defaultShell('win32', {}).file).toBe('powershell.exe')
    expect(defaultShell('linux', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-l'], name: 'zsh' })
    expect(defaultShell('linux', {}).file).toBe('/bin/bash')
  })
})

describe('createLocalShells', () => {
  it.skipIf(process.platform !== 'win32')('keeps a verified launch directory through adoption, shell replacement, and restoration', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'ezshell-cwd-'))
    const original = join(root, 'actual')
    const shown = join(root, 'shown')
    mkdirSync(original)
    mkdirSync(shown)
    const { shells, ptys } = setup({ platform: 'win32', processAlive: () => true, cwd: root })
    try {
      const { id } = shells.open({ cwd: original })
      ptys[0].pid = 789
      ptys[0].emit(`\x1b]7;${pathToFileURL(shown).href}\x07`)
      expect(await shells.currentDirectory(id)).toBe(shown)
      expect(await shells.runAuthorityDirectory(id)).toBe(original)
      // Splitting, promoting a pane and taking a tab out all attach the same shell ID.
      expect(shells.attach(id)).toBeTruthy()
      expect(shells.list().find(item => item.id === id).cwd).toBe(original)
      expect(await shells.runAuthorityDirectory(id)).toBe(original)
      const replacement = shells.open({ replacementFor: id, agent: 'codex', resume: 'a1a729f9-0e10-4f7e-b510-8affbe1b2655' })
      ptys[1].pid = 790
      expect(await shells.runAuthorityDirectory(replacement.id)).toBe(original)
      const restored = shells.open({ cwd: shells.list().find(item => item.id === replacement.id).cwd, restoring: true })
      ptys[2].pid = 791
      expect(await shells.runAuthorityDirectory(restored.id)).toBe(original)
    } finally { shells.closeAll(); rmSync(root, { recursive: true, force: true }) }
  })

  it('drains active development cleanup and refuses a new launch during shutdown', async () => {
    const cwd = realpathSync(tmpdir())
    const { shells, ptys, spawn } = setup({ stopDevelopmentProcess: async pty => pty.exit({ exitCode: 0 }) })
    const cleanup = Promise.withResolvers()
    const release = vi.fn(() => cleanup.promise)
    await shells.openDevelopmentTask({ id: 'test:drain', name: 'Test', cwd, command: 'run-app', cleanup: release }, {})
    const drained = vi.fn()
    const closing = shells.drainDevelopmentTasks().then(drained)
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(null))
    expect(drained).not.toHaveBeenCalled()
    await expect(shells.openDevelopmentTask({ id: 'test:late', name: 'Late', cwd, command: 'run-app' }, {})).rejects.toThrow('종료')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(shells.attach(shells.list()[0].id).exited).toBe(true)
    expect(ptys).toHaveLength(1)
    cleanup.resolve()
    await closing
    shells.closeAll()
  })

  it('runs a preparation PTY before launching the runtime in the same shell', async () => {
    const cwd = realpathSync(tmpdir())
    const { shells, ptys, sent, spawn } = setup({ stopDevelopmentProcess: async pty => pty.exit({ exitCode: 1 }) })
    const onEvent = vi.fn()
    const cleanup = vi.fn()
    const runtime = { cwd, command: 'run-server', expectedUrl: 'http://127.0.0.1:8080/demo', cleanup, onEvent }
    const prepare = vi.fn(async () => runtime)
    const task = { id: 'preset:tomcat', name: 'Tomcat', cwd, onEvent, preparation: { command: 'build-app', finish: prepare } }
    const { id } = await shells.openDevelopmentTask(task, {})
    expect(shells.list()[0].development.status).toBe('starting')
    expect(onEvent).toHaveBeenCalledWith({ type: 'start', shellId: id, phase: 'prepare' })
    ptys[0].emit('build output http://localhost:4567\n')
    expect(shells.list()[0].development.url).toBeNull()
    ptys[0].exit({ exitCode: 0 })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), undefined)
    expect(shells.list()).toHaveLength(1)
    expect(shells.list()[0]).toMatchObject({ id, development: { status: 'running', url: runtime.expectedUrl } })
    expect(onEvent).toHaveBeenCalledWith({ type: 'prepared', shellId: id })
    expect(sent.some(x => x.channel === 'local-shell-exit')).toBe(false)
    await shells.changeDevelopmentTask(id, task.id, 'stop')
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    expect(sent.filter(x => x.channel === 'local-shell-exit')).toHaveLength(1)
    shells.close(id)
  })

  it('runs main-process preparation without a build PTY and retains its compiler failure', async () => {
    const cwd = realpathSync(tmpdir())
    const { shells, spawn } = setup()
    const onEvent = vi.fn()
    const prepare = vi.fn(async ({ log }) => {
      log('javac\r\n')
      throw Object.assign(new Error('javac exit'), { code: 2, stderr: 'Probe.java:3: error: failed' })
    })
    const finish = vi.fn()
    const { id } = await shells.openDevelopmentTask({ id: 'preset:eclipse', name: 'Eclipse', cwd, onEvent,
      preparation: { run: prepare, finish } }, {})
    expect(onEvent).toHaveBeenCalledWith({ type: 'start', shellId: id, phase: 'prepare' })
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'exit', phase: 'prepare', exitCode: 2 }))
    expect(shells.attach(id).backlog).toContain('Probe.java:3: error: failed')
    expect(spawn).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    shells.close(id)
  })

  it('never starts the server after a failed build or a stop during staging', async () => {
    const cwd = realpathSync(tmpdir())
    const { shells, ptys, spawn } = setup()
    const onEvent = vi.fn()
    const staging = Promise.withResolvers()
    const runtime = { cwd, command: 'run-server', cleanup: vi.fn() }
    const prepare = vi.fn(() => staging.promise)
    const task = { id: 'preset:tomcat', name: 'Tomcat', cwd, onEvent, preparation: { command: 'build-app', finish: prepare } }
    const { id } = await shells.openDevelopmentTask(task, {})
    ptys[0].exit({ exitCode: 7 })
    expect(prepare).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'exit', shellId: id, phase: 'prepare', exitCode: 7 }))
    await shells.changeDevelopmentTask(id, task.id, 'restart', () => true, () => task)
    ptys[1].exit({ exitCode: 0 })
    const [signal] = prepare.mock.calls[0]
    const stopping = shells.changeDevelopmentTask(id, task.id, 'stop')
    expect(signal.aborted).toBe(true)
    staging.resolve(runtime)
    await stopping
    expect(spawn).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(runtime.cleanup).toHaveBeenCalledTimes(1))
    expect(shells.attach(id).exited).toBe(true)
    shells.close(id)
  })

  it('decodes raw development output before sending it to the terminal and run log', async () => {
    const cwd = realpathSync(tmpdir())
    const { shells, ptys, sent } = setup({ platform: 'linux' })
    const onEvent = vi.fn()
    const { id } = await shells.openDevelopmentTask({ id: 'preset:encoded', name: 'MS949', cwd, command: 'run-server', logEncoding: 'auto', onEvent }, {})
    expect(ptys[0].options.encoding).toBeNull()
    ptys[0].emit(Buffer.concat([Buffer.from('ERROR '), Buffer.from('c7d1b1db', 'hex'), Buffer.from('\r\n')]))
    expect(shells.attach(id).backlog).toContain('ERROR 한글')
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'data', data: 'ERROR 한글\r\n' }))
    expect(sent.some(event => event.channel === 'local-shell-data' && event.payload.data === 'ERROR 한글\r\n')).toBe(true)
    ptys[0].exit({ exitCode: 1 })
    shells.close(id)
  })

  it('redacts a hot reload port before writing backlog, terminal events or run log events', async () => {
    const cwd = realpathSync(tmpdir())
    const { shells, ptys, sent } = setup()
    const onEvent = vi.fn()
    const { id } = await shells.openDevelopmentTask({ id: 'preset:fixture', name: 'Spring Boot', relative: '.',
      command: 'mvn spring-boot:run', cwd, hotReload: { port: 51837 }, filterOutput: portFilter(51837), onEvent }, {})
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'launched', shellId: id }))
    ptys[0].emit('Debug at http://127.0.0.1:51')
    ptys[0].emit('837/\r\n')
    expect(shells.list()[0].development.url).toBeNull()
    ptys[0].emit('Spring listening at http://localhost:8080/\r\n')
    expect(shells.list()[0].development.url).toBe('http://localhost:8080')
    expect(JSON.stringify([sent, onEvent.mock.calls, shells.attach(id)])).not.toContain('51837')
    ptys[0].exit({ exitCode: 0 })
    shells.close(id)
  })

  it('tracks a development process, restarts in place, and keeps the port and exit code independent of log output', async () => {
    const cwd = realpathSync(tmpdir())
    const { shells, ptys, sent, spawn } = setup({ stopDevelopmentProcess: async pty => pty.exit({ exitCode: 1 }), waitDevelopmentPort: vi.fn() })
    const task = { id: '.:node', name: 'Node', relative: '.', command: 'node run.cjs', cwd }
    const { id } = await shells.openDevelopmentTask(task, {})
    expect(shells.list()[0].development).toMatchObject({ taskId: task.id, status: 'running', url: null })
    ptys[0].emit('Ready at http://localhost:51')
    ptys[0].emit('73/\r\n')
    expect(shells.list()[0].development).toMatchObject({ status: 'running', url: 'http://localhost:5173' })
    await expect(shells.changeDevelopmentTask(id, 'other:id', 'stop')).rejects.toThrow()
    await shells.changeDevelopmentTask(id, task.id, 'restart')
    expect(shells.list()).toHaveLength(1)
    expect(shells.list()[0]).toMatchObject({ id, development: { status: 'running', url: null } })
    expect(spawn.mock.calls[1][1]).toEqual(spawn.mock.calls[0][1])
    ptys[0].exit({ exitCode: 2 })
    expect(shells.list()[0].development.status).toBe('running')
    ptys[1].exit({ exitCode: 23 })
    expect(shells.list()[0].development).toMatchObject({ status: 'exited', exitCode: 23 })
    expect(shells.attach(id).backlog).toContain('Ready at')
    await shells.changeDevelopmentTask(id, task.id, 'restart')
    await shells.changeDevelopmentTask(id, task.id, 'stop')
    expect(shells.list()[0].development.status).toBe('exited')
    expect(sent.some(({ channel, payload }) => channel === 'local-shell-development-state' && payload.development?.status === 'stopping')).toBe(true)
    shells.close(id)
  })

  it('applies a preset environment inside its PTY only', async () => {
    const cwd = realpathSync(tmpdir())
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    const env = { [pathKey]: 'system-bin', JAVA_HOME: 'system-java', PORT: '8080' }
    const { shells, spawn } = setup({ env, stopDevelopmentProcess: async pty => pty.exit({ exitCode: 1 }) })
    const javaHome = join(cwd, 'preset-java')
    const task = { id: 'preset:test', name: 'Dev', relative: '.', command: 'node run.cjs', cwd, javaHome,
      env: { PORT: '26789', JAVA_HOME: 'ignored', PATH: 'project-bin' } }
    const { id } = await shells.openDevelopmentTask(task, {})
    expect(spawn.mock.calls[0][2].env).toMatchObject({
      PORT: '26789', JAVA_HOME: javaHome, [pathKey]: `${join(javaHome, 'bin')}${delimiter}project-bin`
    })
    expect(env).toEqual({ [pathKey]: 'system-bin', JAVA_HOME: 'system-java', PORT: '8080' })
    shells.close(id)
    const plain = await shells.openDevelopmentTask({ ...task, id: '.:node', javaHome: undefined, env: undefined }, {})
    expect(spawn.mock.calls[1][2].env).toMatchObject(env)
    shells.close(plain.id)
  })

  it.skipIf(process.platform !== 'win32')('passes through legacy agy, caches the probe, and rechecks a replaced binary', () => {
    const profile = mkdtempSync(join(tmpdir(), 'ezshell-agy-launch-'))
    const settings = join(profile, 'chat settings.json')
    const shim = join(profile, 'agy.ps1')
    const helpLog = join(profile, 'help.log')
    try {
      writeFileSync(settings, '{}')
      writeFileSync(shim, String.raw`
if ($args[0] -ceq '--help') {
    $global:LASTEXITCODE = 0
    if ($env:EZSHELL_TEST_AGY_UPDATED) { Write-Output '  -s, --settings' }
    else { Write-Output '  --settings-file string' }
    Write-Output '  --version'
    Add-Content -LiteralPath $env:EZSHELL_TEST_AGY_HELP 'probe'
} else {
    Write-Output (ConvertTo-Json -Compress -InputObject @($env:AGY_CLI_OSC7501, $env:AGY_CLI_OSC7501_MESSAGES, @($args)))
}
`)
      const { shells, spawn } = setup({
        platform: 'win32', shell: defaultShell('win32'), cwd: profile,
        agents: { registerShell: () => ({ EZSHELL_ANTIGRAVITY_SETTINGS: settings }) }
      })
      const id = shells.open().id
      const launch = spawn.mock.calls[0][1].at(-1)
      shells.close(id)
      const script = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
function global:Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -eq 'agy.exe') { return $env:EZSHELL_TEST_AGY_SHIM }
    if ($Name -eq 'agy') { return }
    Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
}
$env:AGY_CLI_OSC7501 = 'user-osc'
$env:AGY_CLI_OSC7501_MESSAGES = 'user-messages'
${launch}
agy 'two words' '$literal'
agy second
$env:EZSHELL_TEST_AGY_UPDATED = 'yes'
agy --settings 'user settings.json'
agy update
Add-Content -LiteralPath $env:EZSHELL_TEST_AGY_SHIM '# updated'
agy 'after update'
agy again
Write-Output "$env:AGY_CLI_OSC7501/$env:AGY_CLI_OSC7501_MESSAGES"
`
      const output = execFileSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
      ], {
        windowsHide: true, encoding: 'utf8', env: {
          ...process.env, EZSHELL_ANTIGRAVITY_SETTINGS: settings,
          EZSHELL_TEST_AGY_SHIM: shim, EZSHELL_TEST_AGY_HELP: helpLog
        }
      })
      const lines = output.trim().split(/\r?\n/)
      expect(lines.filter(line => line.startsWith('\x1b[2m'))).toEqual([
        '\x1b[2m이 Antigravity CLI 는 ezShell 채팅 보기에 필요한 설정을 지원하지 않습니다. agy update 로 업데이트하면 채팅 보기를 쓸 수 있습니다.\x1b[0m'
      ])
      expect(lines.filter(line => line.startsWith('[')).map(line => JSON.parse(line))).toEqual([
        ['user-osc', 'user-messages', ['two words', '$literal']],
        ['user-osc', 'user-messages', ['second']],
        ['user-osc', 'user-messages', ['--settings', 'user settings.json']],
        ['user-osc', 'user-messages', ['update']],
        ['on', 'brief', ['--settings', settings, 'after update']],
        ['on', 'brief', ['--settings', settings, 'again']]
      ])
      expect(lines.at(-1)).toBe('user-osc/user-messages')
      expect(readFileSync(helpLog, 'utf8').trim().split(/\r?\n/)).toEqual(['probe', 'probe'])
    } finally {
      for (const file of [settings, shim, helpLog]) rmSync(file, { force: true })
      rmdirSync(profile)
    }
  })

  it.skipIf(process.platform === 'win32')('only injects Antigravity settings in managed Unix launches that support them', () => {
    const profile = mkdtempSync(join(tmpdir(), 'ezshell-agy-launch-'))
    const settings = join(profile, 'chat settings.json')
    const shim = join(profile, 'agy')
    try {
      writeFileSync(shim, String.raw`#!/bin/sh
if [ "$1" = "--help" ]; then
    printf "%s\n" "$EZSHELL_TEST_AGY_HELP"
    exit 0
fi
printf "run:<%s><%s><%s><%s>\n" "$AGY_CLI_OSC7501" "$AGY_CLI_OSC7501_MESSAGES" "$1" "$2"
`, { mode: 0o755 })
      const { shells, spawn } = setup({
        platform: 'linux', shell: { file: '/bin/sh', args: [], name: 'sh' }, cwd: profile,
        agents: { registerShell: () => ({ EZSHELL_ANTIGRAVITY_SETTINGS: settings }) }
      })
      const id = shells.open({ agent: 'antigravity' }).id
      const launch = spawn.mock.calls[0][1].at(-1)
      shells.close(id)
      const run = help => execFileSync('/bin/sh', ['-c', launch], {
        encoding: 'utf8', env: {
          ...process.env, PATH: `${profile}:${process.env.PATH}`, EZSHELL_ANTIGRAVITY_SETTINGS: settings,
          EZSHELL_TEST_AGY_HELP: help, AGY_CLI_OSC7501: '', AGY_CLI_OSC7501_MESSAGES: ''
        }
      })
      expect(run('  --settings-file string')).toMatch(/^\x1b\[2m이 Antigravity CLI .*\x1b\[0m\nrun:<><><><>\n$/)
      expect(run('  -s, --settings string')).toBe(`run:<on><brief><--settings><${settings}>\n`)
    } finally {
      rmSync(shim, { force: true })
      rmdirSync(profile)
    }
  })

  it('binds the Antigravity status reporter, rejects tool descendants, keeps OSC blocking, and detaches on exit', async () => {
    let shells
    let locked = false
    const agents = createAgentMessages({ notify: vi.fn(), isLocked: () => locked, reportLocalAntigravity: report => shells.reportAntigravityStatus(report) })
    await agents.ready()
    const runtime = { name: basename(process.execPath), executable: process.execPath }
    const antigravityRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ezshell-agy-status-')))
    const statusShell = { name: process.platform === 'win32' ? 'cmd.exe' : 'sh' }
    const processes = new Map([
      [12, { parent: 10, name: 'agy.exe', startedAt: 1 }], [13, { parent: 11, name: 'agy.exe', startedAt: 1 }],
      [14, { ...runtime, parent: 19 }], [19, { ...statusShell, parent: 12 }],
      [15, { ...runtime, parent: 11 }],
      [16, { ...runtime, parent: 20 }], [20, { ...statusShell, parent: 13 }],
      [17, { ...runtime, parent: 21 }], [21, { ...statusShell, parent: 18 }], [18, { parent: 12, name: 'agy.exe' }],
      [22, { ...runtime, parent: 19, executable: join(dirname(process.execPath), 'other', runtime.name) }],
      [23, { ...runtime, parent: 24 }], [24, { parent: 12, name: 'powershell.exe' }]
    ])
    const fixture = setup({ agents, processTree: async () => processes, processAlive: pid => processes.has(pid), antigravityRoot })
    shells = fixture.shells
    const first = shells.open({ agent: 'antigravity' }).id
    const second = shells.open().id
    const [firstPty, secondPty] = fixture.ptys
    firstPty.pid = 10
    secondPty.pid = 11
    const cwd = process.platform === 'win32' ? 'C:\\work' : '/work'
    const sessionId = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const otherId = 'd13ee880-0dde-49af-a4c9-7a3620649d7b'
    mkdirSync(join(antigravityRoot, sessionId))
    mkdirSync(join(antigravityRoot, otherId))
    const report = (pty, pid, conversation_id = '', fields = {}, token = pty.options.env.EZSHELL_SHELL_TOKEN) => rpc({
      method: 'antigravity-status', pid,
      value: { product: 'antigravity', cwd, conversation_id, agent_state: 'idle', ...fields }
    }, { pipe: pty.options.env.EZSHELL_AGENT_PIPE, token })
    try {
      expect(firstPty.options.env).not.toHaveProperty('EZSHELL_AGENT_TOKEN')
      expect(fixture.spawn.mock.calls[0][1].join(' ')).toContain('--settings')
      expect(shells.agentOf(first)).toBeNull()
      expect(await report(firstPty, 16)).toMatchObject({ stored: false })
      expect(await report(firstPty, 17)).toMatchObject({ stored: false })
      expect(await report(firstPty, 22, otherId)).toMatchObject({ stored: false })
      expect(await report(firstPty, 23, otherId)).toMatchObject({ stored: false })
      expect(await report(secondPty, 15)).toMatchObject({ stored: false })
      expect(await report(firstPty, 14, '', {}, 'unregistered')).toMatchObject({ stored: false })
      locked = true
      expect(await report(firstPty, 14)).toMatchObject({ stored: false })
      locked = false
      firstPty.emit('\x1b]7501;?\x07\x1b]7501;state=blocked:kind=question:app=antigravity\x07')
      expect(await report(firstPty, 14)).toMatchObject({ stored: true })
      expect(shells.agentOf(first)).toEqual({ kind: 'antigravity', cwd, sessionId: null, status: 'blocked' })
      expect(await report(firstPty, 14, sessionId)).toMatchObject({ stored: true })
      expect(await report(firstPty, 23, otherId)).toMatchObject({ stored: false })
      expect(shells.agentOf(first)?.sessionId).toBe(sessionId)
      expect(shells.approvalOf(first)).toEqual({ question: null, detail: [], options: [], signature: 'antigravity-terminal', usesTerminalInput: true })
      firstPty.write.mockClear()
      expect((await shells.answerApproval(first, '1', 'antigravity-terminal')).ok).toBe(false)
      expect((await shells.chatSend(first, 'text')).ok).toBe(false)
      expect(shells.interruptAgent(first)).toBe(false)
      expect(firstPty.write).not.toHaveBeenCalled()
      firstPty.emit('\x1b]7501;state=idle:app=antigravity\x07')
      expect(shells.approvalOf(first)).toBeNull()
      expect(await report(secondPty, 16, otherId)).toMatchObject({ stored: true })
      expect(shells.agentOf(first)?.sessionId).toBe(sessionId)
      expect(shells.agentOf(second)?.sessionId).toBe(otherId)
      expect(agents.snapshot().agents).toMatchObject([
        { kind: 'antigravity', shellId: first, active: true, mcpConnected: false, status: 'idle' },
        { kind: 'antigravity', shellId: second, active: true, mcpConnected: false, status: 'idle' }
      ])
      processes.delete(12)
      expect(shells.agentOf(first)).toBeNull()
      expect(await report(firstPty, 14, sessionId)).toMatchObject({ stored: false })
      await vi.waitFor(() => expect(agents.snapshot().agents.find(agent => agent.shellId === first)?.active).not.toBe(true), { timeout: 2000 })
      expect(shells.isRunning(first)).toBe(true)
    } finally {
      shells.closeAll()
      agents.stop()
      rmSync(antigravityRoot, { recursive: true, force: true })
    }
  })

  it('requires a brain directory created after agy started before changing its role conversation', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ezshell-agy-role-')))
    const session = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const earlier = 'd13ee880-0dde-49af-a4c9-7a3620649d7b'
    const later = 'd13ee880-0dde-49af-a4c9-7a3620649d7c'
    const earlierDirectory = join(root, earlier)
    mkdirSync(earlierDirectory)
    const stat = statSync(earlierDirectory)
    const startedAt = (stat.birthtimeMs || stat.mtimeMs) + 1
    const processes = new Map([
      [12, { parent: 10, name: 'agy.exe', startedAt }],
      [13, { parent: 12, name: process.platform === 'win32' ? 'cmd.exe' : 'sh' }],
      [14, { parent: 13, name: basename(process.execPath), executable: process.execPath }]
    ])
    const registerLocalAntigravity = vi.fn((_, attach) => Boolean(attach({ agentId: 'antigravity-1', setStatus: vi.fn(), onExit: vi.fn() })))
    const setVerifiedSession = vi.fn()
    const { shells, ptys } = setup({
      processTree: async () => processes, processAlive: pid => processes.has(pid), antigravityRoot: root,
      agents: { registerLocalAntigravity, setVerifiedSession }
    })
    const { id } = shells.open()
    ptys[0].pid = 10
    let sequence = 0
    const report = sessionId => shells.reportAntigravityStatus({
      shellId: id, pid: 14, isCurrent: () => true, sequence: ++sequence,
      status: { sessionId, cwd: root, status: 'idle' }
    })
    try {
      expect(await report(earlier)).toBe(true)
      expect(registerLocalAntigravity).toHaveBeenCalledWith(root, expect.any(Function), null)
      expect(shells.agentOf(id).sessionId).toBeNull()
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(startedAt))
      mkdirSync(join(root, session))
      expect(await report(session)).toBe(true)
      expect(shells.agentOf(id).sessionId).toBe(session)
      expect(await report(null)).toBe(true)
      expect(await report(earlier)).toBe(true)
      expect(await report(later)).toBe(true)
      expect(shells.agentOf(id).sessionId).toBe(session)
      expect(setVerifiedSession.mock.calls).toEqual([
        ['antigravity-1', session], ['antigravity-1', session], ['antigravity-1', session], ['antigravity-1', session]
      ])

      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(startedAt))
      mkdirSync(join(root, later))
      const readStat = promises.lstat
      const olderCheck = Promise.withResolvers()
      const releaseOlderCheck = Promise.withResolvers()
      const lstat = vi.spyOn(promises, 'lstat').mockImplementation(async (file, ...options) => {
        if (file === earlierDirectory) {
          olderCheck.resolve()
          await releaseOlderCheck.promise
        }
        return readStat(file, ...options)
      })
      try {
        const accepted = report(later)
        const unverified = report(earlier)
        await olderCheck.promise
        expect(await accepted).toBe(true)
        releaseOlderCheck.resolve()
        expect(await unverified).toBe(true)
        expect(setVerifiedSession).toHaveBeenLastCalledWith('antigravity-1', later)
        expect(shells.agentOf(id).sessionId).toBe(later)
      } finally {
        releaseOlderCheck.resolve()
        lstat.mockRestore()
      }
      const logs = join(earlierDirectory, '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      writeFileSync(join(logs, 'transcript.jsonl'), '')
      expect(await report(earlier)).toBe(true)
      expect(shells.agentOf(id).sessionId).toBe(earlier)
    } finally {
      shells.closeAll()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds a manual Claude through its own process and updates the session without MCP', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const session = { pid: 12, cwd: '/work', startedAt, sessionId: '183a2d7a-c5d8-4d40-acd1-11c08bce7cde' }
    const nested = { ...session, pid: 13 }
    const outside = { ...session, pid: 22 }
    const processes = new Map([
      [12, { parent: 10, name: 'claude.exe', startedAt }],
      [13, { parent: 12, name: 'claude.exe', startedAt }],
      [14, { parent: 12, name: 'electron.exe' }],
      [22, { parent: 20, name: 'claude.exe', startedAt }]
    ])
    const readClaudeSessions = vi.fn(async () => [session, nested, outside])
    const processTree = vi.fn(async () => processes)
    const onExit = vi.fn()
    const registerLocalClaude = vi.fn((_, attach) => attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit }))
    const { shells, ptys } = setup({ readClaudeSessions, processTree, processAlive: pid => processes.has(pid), agents: { registerLocalClaude } })
    const first = shells.open().id
    const second = shells.open().id
    ptys[0].pid = 10
    ptys[1].pid = 11
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(registerLocalClaude).toHaveBeenCalledTimes(1)
      expect(shells.agentOf(first)).toMatchObject({ kind: 'claude', cwd: session.cwd, sessionId: session.sessionId })
      expect(shells.agentOf(second)).toBeNull()

      const next = { ...session, sessionId: 'd13ee880-0dde-49af-a4c9-7a3620649d7b' }
      readClaudeSessions.mockResolvedValue([next, nested, outside])
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.agentOf(first)?.sessionId).toBe(next.sessionId)
      expect(processTree).toHaveBeenCalledTimes(1)
      expect(registerLocalClaude).toHaveBeenCalledTimes(1)

      const connectMcp = await shells.bindAgentProcess({ pid: 14, kind: 'claude' })
      expect(connectMcp({ agentId: 'claude-2', setStatus: vi.fn(), onExit }).agentId).toBe('claude-2')
      processes.delete(12)
      readClaudeSessions.mockResolvedValue([outside])
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.agentOf(first)).toBeNull()
      expect(shells.isRunning(first)).toBe(true)
      expect(onExit.mock.calls).toEqual([['claude-1'], ['claude-2']])
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it.each([10, 12])('verifies a managed Claude session from its own process (PID %s)', async pid => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const ownSession = { pid, cwd: '/work', startedAt, sessionId: '183a2d7a-c5d8-4d40-acd1-11c08bce7cde' }
    const nextSession = { ...ownSession, sessionId: 'd13ee880-0dde-49af-a4c9-7a3620649d7b' }
    const unrelatedSession = { ...nextSession, pid: 22 }
    const processTree = vi.fn(async () => new Map([
      [pid, { parent: pid === 10 ? 1 : 10, name: 'claude.exe', startedAt }],
      [22, { parent: 20, name: 'claude.exe', startedAt }],
      [23, { parent: pid, name: 'node.exe', startedAt }]
    ]))
    const readClaudeSessions = vi.fn(async () => [unrelatedSession, { ...nextSession, pid: 23 }, ownSession])
    const setVerifiedSession = vi.fn()
    const registerLocalClaude = vi.fn()
    const { shells, ptys } = setup({ readClaudeSessions, processTree, processAlive: () => true, agents: {
      register: () => ({ env: { EZSHELL_AGENT_ID: 'claude-managed' }, close: vi.fn() }),
      registerLocalClaude,
      setVerifiedSession
    } })
    try {
      shells.open({ agent: 'claude' })
      ptys[0].pid = 10
      await vi.advanceTimersByTimeAsync(1000)
      expect(setVerifiedSession.mock.calls).toEqual([['claude-managed', ownSession.sessionId]])
      readClaudeSessions.mockResolvedValue([nextSession])
      await vi.advanceTimersByTimeAsync(1000)
      expect(setVerifiedSession.mock.calls).toEqual([
        ['claude-managed', ownSession.sessionId], ['claude-managed', nextSession.sessionId]
      ])
      expect(registerLocalClaude).not.toHaveBeenCalled()
      expect(processTree).toHaveBeenCalledTimes(1)
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it('ignores a stale Claude session file after PID reuse when reading the sleep target', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now() + 1000
    const sessionId = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const session = { pid: 12, cwd: '/work', sessionId, startedAt: startedAt + 7770, processStartedAt: startedAt }
    const claude = { parent: 10, name: 'claude.exe', startedAt: startedAt + 1500 }
    const processes = new Map([[12, claude], [14, { parent: 12, name: 'electron.exe' }]])
    const readClaudeSessions = async () => [session]
    const processTree = vi.fn(async () => processes)
    const registerLocalClaude = vi.fn((_, attach) => attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() }))
    const setVerifiedSession = vi.fn()
    const { shells, ptys } = setup({
      readClaudeSessions, processTree, processAlive: pid => processes.has(pid),
      agents: { registerLocalClaude, setVerifiedSession }
    })
    const { id } = shells.open()
    ptys[0].pid = 10
    try {
      await vi.advanceTimersByTimeAsync(3000)
      expect(shells.agentOf(id)).toBeNull()
      expect(registerLocalClaude).not.toHaveBeenCalled()
      expect(processTree).toHaveBeenCalledTimes(1)

      session.processStartedAt = claude.startedAt
      await vi.advanceTimersByTimeAsync(1000)
      expect(registerLocalClaude).toHaveBeenCalledTimes(1)
      const attach = await shells.bindAgentProcess({ pid: 14, kind: 'claude' })
      attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() })
      expect(shells.idleAgents()).toMatchObject([{ kind: 'claude', external: true, sessionId }])

      claude.startedAt += 5000
      session.startedAt += 1
      await vi.advanceTimersByTimeAsync(1000)
      expect(setVerifiedSession).not.toHaveBeenCalled()
      expect(shells.idleAgents()).toEqual([])
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it.each([null, 'codex.exe', 'node.exe'])('uses a Codex resume UUID only for the CLI directly below the shell (parent %s)', async parent => {
    const sessionId = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const processes = new Map([
      [12, { parent: 10, name: parent }],
      [13, { parent: parent ? 12 : 10, name: 'codex.exe' }],
      [14, { parent: 13, name: 'electron.exe' }]
    ])
    const commandLine = vi.fn(async () => `"C:\\Program Files\\codex.exe" --no-daemon resume ${sessionId}`)
    const { shells, ptys } = setup({ processTree: async () => processes, processAlive: pid => processes.has(pid), commandLine, agents: {} })
    shells.open()
    ptys[0].pid = 10
    try {
      const attach = await shells.bindAgentProcess({ pid: 14, kind: 'codex' })
      const binding = attach({ agentId: 'codex-1', setStatus: vi.fn(), onExit: vi.fn() })
      if (parent) {
        expect(commandLine).not.toHaveBeenCalled()
        expect(binding).not.toHaveProperty('resumeId')
      } else {
        expect(commandLine).toHaveBeenCalledExactlyOnceWith(13)
        expect(binding).toMatchObject({ resumeId: sessionId })
      }
    } finally {
      shells.closeAll()
    }
  })

  it.each(['launch', 'reported', 'mismatch', 'missing'])('attests an external Codex working folder from the shell (%s)', async mode => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ezshell-codex-folder-')))
    const moved = join(folder, 'moved')
    mkdirSync(moved)
    const processes = new Map([
      [13, { parent: 10, name: 'codex.exe', startedAt: 1500 }],
      [14, { parent: 13, name: 'electron.exe' }]
    ])
    const { shells, ptys } = setup({ cwd: folder, processTree: async () => processes, processAlive: pid => processes.has(pid), agents: {} })
    shells.open()
    ptys[0].pid = 10
    try {
      if (mode === 'reported' || mode === 'mismatch') {
        ptys[0].emit(`\x1b]7;${require('node:url').pathToFileURL(moved).href}\x07`)
      }
      const cwd = mode === 'reported' ? moved : mode === 'missing' ? undefined : folder
      const attach = await shells.bindAgentProcess({ pid: 14, kind: 'codex', cwd })
      const binding = attach({ agentId: 'codex-1', setStatus: vi.fn(), onExit: vi.fn() })
      if (mode === 'mismatch' || mode === 'missing') {
        expect(binding).not.toHaveProperty('codexProcessStartedAt')
        expect(binding).not.toHaveProperty('codexRoleCwd')
      } else {
        expect(binding).toMatchObject({ codexProcessStartedAt: 1500, codexRoleCwd: cwd })
      }
    } finally {
      shells.closeAll()
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('binds five agents to their own shells when two MCP processes start after a shared snapshot', async () => {
    const processes = new Map()
    const processTree = vi.fn(async () => processes)
    const { shells, ptys } = setup({ agents: {}, processTree, processAlive: () => true })
    const agents = Array.from({ length: 5 }, (_, index) => {
      const { id } = shells.open()
      const ptyPid = 200 + index
      const cliPid = 300 + index
      const pid = 400 + index
      const kind = index % 2 === 0 ? 'claude' : 'codex'
      ptys[index].pid = ptyPid
      processes.set(cliPid, { parent: ptyPid, name: `${kind}.exe` })
      return { id, cliPid, pid, kind }
    })
    const addHelpers = (set, entries) => {
      for (const { pid, cliPid } of entries) set.set(pid, { parent: cliPid, name: 'electron.exe' })
      return set
    }
    processTree.mockResolvedValueOnce(addHelpers(new Map(processes), agents.slice(0, 3)))
    addHelpers(processes, agents.slice(3))

    try {
      const connections = await Promise.all(agents.map(({ pid, kind }) => shells.bindAgentProcess({ pid, kind })))
      expect(processTree).toHaveBeenCalledTimes(2)
      const attached = connections.map((connect, index) => connect({
        agentId: `${agents[index].kind}-${index}`, setStatus: () => {}, onExit: () => {}
      }))
      expect(attached.map(agent => agent.shellId)).toEqual(agents.map(agent => agent.id))
    } finally {
      shells.closeAll()
    }
  })

  it('distinguishes unavailable process ancestry from a known process outside the app shells', async () => {
    const processTree = vi.fn(async () => new Map([[12, { parent: 1, name: 'electron.exe' }]]))
      .mockRejectedValueOnce(new Error('snapshot unavailable'))
    const { shells, ptys } = setup({ processTree, agents: {} })
    shells.open()
    ptys[0].pid = 10
    try {
      await expect(shells.bindAgentProcess({ pid: 12, kind: 'claude' })).rejects.toThrow(/계보/)
      await expect(shells.bindAgentProcess({ pid: 12, kind: 'claude' })).resolves.toBeUndefined()
    } finally {
      shells.closeAll()
    }
  })

  it('reads the composer of a CLI whose start scrolled out of the backlog before its MCP connected (2026-11-23 user report)', async () => {
    const processes = new Map([[15, { parent: 12, name: 'electron.exe' }], [12, { parent: 10, name: 'claude.exe' }]])
    const { shells, ptys } = setup({ agents: {}, processTree: async () => processes, processAlive: () => true })
    const { id } = shells.open()
    ptys[0].pid = 10
    const rule = '─'.repeat(79)
    try {
      // Claude turns bracketed paste on once, when it starts; a long session pushes that out of the backlog
      ptys[0].emit('\x1b[?2004h')
      for (let sent = 0; sent <= BACKLOG_CHARS * 2; sent += 64 * 1024) ptys[0].emit('x'.repeat(64 * 1024 - 2) + '\r\n')
      ptys[0].emit(`\x1b[2J\x1b[10;1H${rule}\x1b[11;1H❯ \x1b[12;1H${rule}\x1b[11;3H`)
      const attach = await shells.bindAgentProcess({ pid: 15, kind: 'claude' })
      attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() })
      // The headless screen parses what it is given asynchronously
      await vi.waitFor(() => expect(shells.chatScreen(id).lines.join('')).toContain('❯'))
      expect(shells.chatScreen(id).composer).toBe('empty')
    } finally {
      shells.closeAll()
    }
  })

  it('tracks the CLI across MCP disconnection and reconnection until the CLI exits', async () => {
    vi.useFakeTimers()
    const processes = new Map([
      [15, { parent: 14, name: 'electron.exe' }],
      [14, { parent: 13, name: 'powershell.exe' }],
      [13, { parent: 12, name: 'node.exe' }],
      [12, { parent: 10, name: 'claude.exe', startedAt: 10_000 }]
    ])
    const alive = new Set([12, 13, 14, 15])
    const { shells, ptys } = setup({ agents: {}, processTree: async () => processes, processAlive: pid => alive.has(pid) })
    const { id } = shells.open()
    ptys[0].pid = 10
    const onExit = vi.fn()
    try {
      const attach = await shells.bindAgentProcess({ pid: 15, kind: 'claude' })
      const binding = attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit })
      expect(binding.shellId).toBe(id)
      const authorizeBinding = vi.fn(() => { throw new Error('Reconnect credential required') })
      expect(() => attach({ agentId: 'claude-2', setStatus: vi.fn(), onExit, authorizeBinding })).toThrow('Reconnect credential required')
      expect(authorizeBinding).toHaveBeenCalledExactlyOnceWith('claude-1', false, true)
      alive.delete(15)
      expect(binding.detach()).toBe(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.agentOf(id).kind).toBe('claude')
      expect(onExit).not.toHaveBeenCalled()

      processes.set(16, { parent: 13, name: 'electron.exe' })
      alive.add(16)
      const reconnect = await shells.bindAgentProcess({ pid: 16, kind: 'claude' })
      authorizeBinding.mockImplementation(() => {})
      const reconnected = reconnect({ agentId: 'claude-2', setStatus: vi.fn(), onExit, authorizeBinding })
      expect(reconnected.agentId).toBe('claude-1')
      expect(binding.detach()).toBe(false)
      processes.get(12).startedAt += 1000
      const reusedPid = await shells.bindAgentProcess({ pid: 16, kind: 'claude' })
      authorizeBinding.mockImplementation(() => { throw new Error('Process start changed') })
      expect(() => reusedPid({ agentId: 'claude-3', setStatus: vi.fn(), onExit, authorizeBinding })).toThrow('Process start changed')
      expect(authorizeBinding).toHaveBeenLastCalledWith('claude-1', false, false)
      alive.delete(12)
      expect(await shells.chatSend(id, 'check')).toEqual({ ok: false, reason: 'not-agent' })
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.isRunning(id)).toBe(true)
      expect(shells.agentOf(id)).toBeNull()
      expect(onExit).toHaveBeenCalledExactlyOnceWith('claude-1')
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it('sets the PTY color capabilities without changing the parent environment', () => {
    const env = { Term: 'dumb', No_Color: '1', ColorTerm: '24bit', Path: 'shell-path' }
    const { shells, ptys } = setup({ env, platform: 'win32' })
    shells.open()
    expect(ptys[0].options.name).toBe('xterm-256color')
    expect(ptys[0].options.env).toEqual({ Term: 'xterm-256color', ColorTerm: 'truecolor', Path: 'shell-path' })
    expect(env).toEqual({ Term: 'dumb', No_Color: '1', ColorTerm: '24bit', Path: 'shell-path' })
  })

  it('passes the corrected environment through agent registration', () => {
    const register = vi.fn((kind, id, cwd, env) => ({ env: { ...env, EZSHELL_AGENT_PIPE: 'test-pipe' } }))
    const { shells, ptys } = setup({ env: { TERM: 'dumb', NO_COLOR: '1' }, agents: { register } })
    const { id } = shells.open({ agent: 'codex' })
    const terminalEnv = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    // No resumed session: the last argument (the session the usage watcher looks for) is empty
    expect(register).toHaveBeenCalledWith('codex', id, '/home', terminalEnv, null)
    expect(ptys[0].options.env).toEqual({ ...terminalEnv, EZSHELL_AGENT_PIPE: 'test-pipe' })
  })

  it('clears the Orca color override even when its TERM advertises colors', () => {
    const env = { TERM_PROGRAM: 'Orca', TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }
    const { shells, ptys } = setup({ env })
    shells.open()
    expect(ptys[0].options.env).toEqual({ TERM_PROGRAM: 'Orca', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
    expect(env.NO_COLOR).toBe('1')
  })

  it('drops inherited session markers and credentials, keeping Claude settings', () => {
    // Started from inside Claude Code, every Claude in a local shell took itself for a sub-session of it
    // (transcript saving off, so its conversation could not be resumed)
    const { shells, ptys } = setup({ env: {
      TERM: 'xterm', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_SOCKET: 'pipe', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_PID: '42',
      CLAUDE_CONFIG_DIR: 'D:\\claude', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
      EZSHELL_AGENT_ID: 'codex-1', EZSHELL_AGENT_TOKEN: 'parent-agent', EZSHELL_AGENT_PIPE: 'parent-pipe'
    } })
    shells.open()
    expect(ptys[0].options.env).toEqual({
      TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_CONFIG_DIR: 'D:\\claude', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe'
    })
  })

  it('preserves NO_COLOR from a parent with a color-capable terminal', () => {
    const { shells, ptys } = setup({ env: { TERM: 'xterm', NO_COLOR: '1' } })
    shells.open()
    expect(ptys[0].options.env).toEqual({ TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' })
  })

  it('continues through PTY output and exit when the message registration has no status callbacks', () => {
    const pty = fakePty()
    const close = vi.fn()
    const send = vi.fn()
    const shells = createLocalShells({
      spawn: () => pty,
      send,
      agents: { register: () => ({ env: {}, close }) },
      shell: { file: 'sh', args: [], name: 'sh' },
      cwd: '/home',
      env: {}
    })
    const { id } = shells.open({ agent: 'claude' })
    pty.emit('\x1b]0;✳ Claude Code\x07')
    pty.exit({ exitCode: 0 })
    expect(send).toHaveBeenCalledWith('local-shell-exit', { id, exitCode: 0 })
    expect(close).toHaveBeenCalledOnce()
  })

  it('opens a shell with a clamped size and forwards its output', () => {
    const { shells, ptys, sent } = setup()
    const { id, name } = shells.open({ cols: 100000, rows: 'x' })
    expect(name).toBe('sh')
    expect(ptys[0].options).toMatchObject({ cols: 500, rows: 24, cwd: '/home' })
    ptys[0].emit('hello')
    expect(sent).toEqual([{ channel: 'local-shell-data', payload: { id, data: 'hello' } }])
  })

  it('reports a Windows shell directory from a split OSC sequence and ignores network URLs', async () => {
    const { shells, ptys } = setup({ platform: 'win32', cwd: 'C:\\launch' })
    const { id } = shells.open()
    expect(await shells.currentDirectory(id)).toBe('C:\\launch')
    ptys[0].emit('\x1b]7;file:///C:/my%20')
    ptys[0].emit('work\x07')
    expect(await shells.currentDirectory(id)).toBe('C:\\my work')
    ptys[0].emit('\x1b]7;file://example.com/share\x07')
    expect(await shells.currentDirectory(id)).toBe('C:\\my work')
  })

  it('gives a redrawn tab the output so far and the exit state', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    ptys[0].emit('a')
    ptys[0].emit('b')
    expect(shells.attach(id)).toEqual({ backlog: 'ab', exited: false, exitCode: null })
    ptys[0].exit({ exitCode: 3 })
    expect(shells.attach(id)).toEqual({ backlog: 'ab', exited: true, exitCode: 3 })
    expect(shells.attach('local:99')).toBeNull()
  })

  it('keeps only the end of a long output', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    for (let i = 0; i < 5; i++) ptys[0].emit(String(i).repeat(BACKLOG_CHARS))
    const { backlog } = shells.attach(id)
    expect(backlog.length).toBe(BACKLOG_CHARS)
    expect(backlog.endsWith('4')).toBe(true)
  })

  it('writes and resizes only a running shell, and ignores input that is not text', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    shells.write(id, 'ls\r')
    shells.write(id, { toString: () => 'x' })
    shells.write('local:99', 'x')
    shells.resize(id, 120, 40)
    expect(ptys[0].write.mock.calls).toEqual([['ls\r']])
    expect(ptys[0].resize).toHaveBeenCalledWith(120, 40)
    ptys[0].exit({ exitCode: 0 })
    shells.write(id, 'x')
    shells.resize(id, 80, 24)
    expect(ptys[0].write).toHaveBeenCalledTimes(1)
    expect(ptys[0].resize).toHaveBeenCalledTimes(1)
  })

  it('routes a Windows screenshot to the running agent and counts it as a Codex draft', () => {
    const { shells, ptys } = setup({ platform: 'win32' })
    const codex = shells.open({ agent: 'codex' })
    const claude = shells.open({ agent: 'claude' })
    const ordinary = shells.open()
    ptys[0].emit('\x1b]0;⠋ Codex\x07')
    expect(shells.pasteClipboardImage(codex.id)).toBe(true)
    expect(shells.pasteClipboardImage(claude.id)).toBe(true)
    expect(shells.pasteClipboardImage(ordinary.id)).toBe(false)
    expect(ptys[0].write.mock.calls).toEqual([['\x16']])
    expect(ptys[1].write.mock.calls).toEqual([['\x1bv']])
    expect(ptys[2].write).not.toHaveBeenCalled()
    expect(shells.hasWorkingAgent([codex.id])).toBe(false)
    shells.write(codex.id, '\r')
    expect(shells.hasWorkingAgent([codex.id])).toBe(true)
    ptys[1].exit({ exitCode: 0 })
    expect(shells.pasteClipboardImage(claude.id)).toBe(false)
  })

  it('kills a running shell on close, and every shell on closeAll', () => {
    const { shells, ptys } = setup()
    const first = shells.open()
    shells.open()
    shells.open()
    ptys[2].exit({ exitCode: 0 })
    shells.close(first.id)
    expect(ptys[0].kill).toHaveBeenCalledTimes(1)
    shells.closeAll()
    expect(ptys[1].kill).toHaveBeenCalledTimes(1)
    expect(ptys[2].kill).not.toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })

  it('keeps more than ten local shells open at once', () => {
    const { shells } = setup()
    const opened = Array.from({ length: 12 }, () => shells.open())
    expect(shells.count()).toBe(12)
    expect(shells.list().map(shell => shell.id)).toEqual(opened.map(shell => shell.id))
  })

  it('prepares one replacement per shell and keeps the original until adoption', () => {
    const { shells, ptys, spawn } = setup()
    const previous = shells.open({ cols: 96, rows: 35 })
    const options = { agent: 'claude', resume: 'abcdef12-1111-4222-8333-444455556666', replacementFor: previous.id }
    spawn.mockImplementationOnce(() => { throw new Error('PTY failed') })
    expect(() => shells.open(options)).toThrow('PTY failed')
    expect(shells.count()).toBe(1)
    expect(ptys[0].kill).not.toHaveBeenCalled()

    const replacement = shells.open(options)
    expect(replacement.id).not.toBe(previous.id)
    expect(ptys[1].options).toMatchObject({ cols: 96, rows: 35 })
    expect(() => shells.open(options)).toThrow(/바꾸는 중/)
    expect(ptys[0].kill).not.toHaveBeenCalled()
    shells.close(previous.id)
    expect(ptys[0].kill).toHaveBeenCalledOnce()
    expect(shells.count()).toBe(1)
    expect(shells.attach(replacement.id)?.exited).toBe(false)
  })

  it('tracks the activity of the launched agent across split OSC sequences', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'claude' })
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]0;⠋')
    ptys[0].emit(' Codex\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]2;Codex\x1b')
    ptys[0].emit('\\')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]9;4;3\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].exit({ exitCode: 0 })
    expect(shells.hasWorkingAgent([id])).toBe(false)
  })

  it('ignores Codex startup progress and an unsubmitted draft, then reports work after submission', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'codex' })
    ptys[0].emit('\x1b]0;⠋ ezshell\x07\x1b]9;4;3\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    shells.write(id, '\x1b[I')
    shells.write(id, '\r')
    expect(shells.hasWorkingAgent([id])).toBe(false)

    shells.write(id, '\x1b[200~Check the output\rfrom this command\x1b[201~')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    shells.write(id, '\r')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]0;ezshell\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]0;⠙ ezshell\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
  })

  it('reconciles stale Codex working with its resumed rollout and takes new work immediately', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const sessionId = '01a20800-880a-74f1-86d2-96226700df12'
    const setStatus = vi.fn()
    const { shells, ptys } = setup({
      agents: { register: () => ({ env: { EZSHELL_AGENT_ID: 'codex-1' }, setStatus, close: vi.fn() }) }
    })
    vi.setSystemTime(1000)
    const { id } = shells.open({ agent: 'codex', resume: sessionId })
    const report = (status, at, session = sessionId, agent = 'codex-1') =>
      shells.setCodexTurnStatus(id, agent, session, { status, at })
    const working = '\x1b]7501;state=working:app=codex\x07'
    const status = () => shells.agentOf(id).status
    try {
      shells.write(id, 'Initial request')
      shells.write(id, '\r')
      vi.setSystemTime(2000)
      ptys[0].emit(working)
      vi.setSystemTime(3000)
      report('idle', 1900)
      report('idle', 2000)
      report('idle', 2800, '01a20800-880a-74f1-86d2-96226700df13')
      report('idle', 2800, sessionId, 'codex-2')
      expect(status()).toBe('working')

      report('idle', 2900)
      expect(status()).toBe('idle')
      expect(setStatus).toHaveBeenLastCalledWith('idle')

      vi.setSystemTime(3100)
      report('working', 3050)
      report('idle', 3049)
      expect(status()).toBe('working')
      expect(setStatus).toHaveBeenLastCalledWith('working', 'screen')

      vi.setSystemTime(3300)
      report('idle', 3200)
      expect(status()).toBe('idle')
      ptys[0].emit(working)
      expect(status()).toBe('working')
      expect(setStatus).toHaveBeenLastCalledWith('working', 'screen')

      vi.setSystemTime(3500)
      report('idle', 3400)
      expect(status()).toBe('idle')
      shells.write(id, 'Next request')
      shells.write(id, '\r')
      expect(status()).toBe('working')

      vi.setSystemTime(3700)
      ptys[0].emit('\x1b]7501;state=blocked:app=codex\x07')
      vi.setSystemTime(3900)
      report('idle', 3800)
      expect(status()).toBe('blocked')

      ptys[0].emit('\x1b]7501;state=done:app=codex\x07')
      expect(status()).toBe('idle')
      vi.setSystemTime(4100)
      report('working', 4050)
      expect(status()).toBe('working')
      ptys[0].emit('\x1b]7501;state=done:app=codex\x07')
      expect(status()).toBe('idle')
    } finally {
      shells.close(id)
      vi.useRealTimers()
    }
  })

  it('accepts late official status for the owning shell and treats chat stop as a user interrupt', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const setStatus = vi.fn()
    const setHookSession = vi.fn()
    const { shells, ptys } = setup({
      agents: { register: () => ({ env: { EZSHELL_AGENT_ID: 'claude-1' }, setStatus, close: vi.fn() }), setHookSession }
    })
    vi.setSystemTime(1000)
    const { id } = shells.open({ agent: 'claude' })
    const title = text => ptys[0].emit('\x1b]0;' + text + '\x07')
    const status = () => shells.agentOf(id).status
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const turn = { kind: 'claude', event: 'UserPromptSubmit', sessionId, promptId: sessionId, startedAt: 20_000 }
    try {
      vi.setSystemTime(20_000)
      title('✳ Claude')
      expect(status()).toBe('idle')
      shells.reportAgentHook(id, 'claude-2', turn)
      expect(status()).toBe('idle')
      shells.reportAgentHook(id, 'claude-1', turn)
      expect(status()).toBe('working')
      expect(setHookSession).toHaveBeenCalledExactlyOnceWith('claude-1', sessionId)
      expect(shells.agentOf(id)).toMatchObject({ sessionId, status: 'working' })

      vi.setSystemTime(20_100)
      title('⠋ Claude')
      shells.write(id, '\x1b[A')
      vi.setSystemTime(20_200)
      title('✳ Claude')
      expect(status()).toBe('working')

      vi.setSystemTime(20_300)
      title('⠋ Claude')
      expect(shells.interruptAgent(id)).toBe(true)
      vi.setSystemTime(20_400)
      title('✳ Claude')
      expect(status()).toBe('idle')
      expect(setStatus).toHaveBeenLastCalledWith('idle', 'hook')
    } finally {
      shells.close(id)
      vi.useRealTimers()
    }
  })

  it('records Codex approval and publishes a source-only status change from its authenticated hook', async () => {
    let shells
    const dir = mkdtempSync(join(tmpdir(), 'ezshell-hook-trust-'))
    const codexHookTrustFile = join(dir, 'mode')
    const agents = createAgentMessages({ notify: vi.fn(), isLocked: () => false,
      codexHookTrustFile, onAgentHook: (id, agentId, report) => shells.reportAgentHook(id, agentId, report) })
    await agents.ready()
    const fixture = setup({ agents })
    shells = fixture.shells
    const { id } = shells.open({ agent: 'codex' })
    const env = fixture.ptys[0].options.env
    const request = { method: 'agent-event', kind: 'codex', event: 'SessionStart', startedAt: Date.now() }
    const options = { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN }
    try {
      expect(agents.snapshot().agents[0]).not.toHaveProperty('statusSource')
      fixture.ptys[0].emit('\x1b]7501;state=idle:app=codex\x07')
      const before = agents.snapshot()
      expect(before.agents[0]).toMatchObject({ status: 'idle', statusSource: 'screen' })
      expect(agents.codexHookMode()).toBe('pending')
      expect(await rpc(request, { ...options, token: 'foreign' })).toMatchObject({ success: false })
      expect(agents.codexHookMode()).toBe('pending')
      expect(await rpc(request, options)).toMatchObject({ stored: true })
      expect(shells.agentOf(id).status).toBe('idle')
      const after = agents.snapshot()
      expect(after.agents[0]).toMatchObject({ status: 'idle', statusSource: 'hook' })
      expect(after.revision).toBeGreaterThan(before.revision)
      expect(agents.codexHookMode()).toBe('approved')
      expect(readFileSync(codexHookTrustFile, 'utf8').trim()).toBe('approved')
      expect(readFileSync(env.EZSHELL_CODEX_HOOK_MODE_FILE, 'utf8').trim()).toBe('approved')
      const restarted = createAgentMessages({ notify: vi.fn(), isLocked: () => false, codexHookTrustFile })
      expect(restarted.codexHookMode()).toBe('approved')
    } finally {
      shells.close(id)
      agents.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recognizes a typed hook review only for its shell nonce and waits for an attached agent before saving a decline', async () => {
    const setCodexHookMode = vi.fn(() => true)
    const { shells, ptys } = setup({ platform: 'win32', agents: { codexHookMode: () => 'pending', setCodexHookMode,
      registerShell: () => ({ EZSHELL_CODEX_HOOK_NONCE: 'nonce' }) } })
    const { id } = shells.open()
    try {
      ptys[0].emit('\x1b]777;ezshell-codex-hooks=start;other\x07')
      ptys[0].emit('Hooks need review\r\n10 hooks are new or changed.\r\n> 3. Continue without trusting')
      expect(shells.codexHookReview(id)).toBeNull()
      ptys[0].emit('\x1b]777;ezshell-codex-hooks=start;nonce\x07')
      ptys[0].emit('Hooks need review\r\n10 hooks are new or changed.\r\n> 3. Continue without trusting')
      await vi.waitFor(() => expect(shells.codexHookReview(id)).toMatchObject({ count: 10, declineSelected: true }))
      shells.write(id, '\r')
      expect(setCodexHookMode).not.toHaveBeenCalled()
    } finally { shells.close(id) }
  })

  it('passes a Stop through after a user interrupt and keeps a later blocked turn working', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { shells } = setup({ agents: { register: () => ({ env: { EZSHELL_AGENT_ID: 'claude-1' }, close: vi.fn() }),
      unreadFor: () => ['new'] } })
    vi.setSystemTime(1000)
    const { id } = shells.open({ agent: 'claude' })
    const report = (event, promptId, options) => shells.reportAgentHook(id, 'claude-1',
      { kind: 'claude', event, promptId, startedAt: Date.now() }, options)
    try {
      report('UserPromptSubmit', 'first')
      vi.setSystemTime(2000)
      expect(shells.interruptAgent(id)).toBe(true)
      vi.setSystemTime(3000)
      expect(report('Stop', 'first', { checkStop: true })).toBe(true)
      expect(shells.agentOf(id).status).toBe('idle')
      vi.setSystemTime(13_000)
      report('UserPromptSubmit', 'second')
      vi.setSystemTime(14_000)
      expect(report('StopFailure', 'second', { checkStop: true })).toBe(true)
      expect(shells.agentOf(id).status).toBe('idle')
      vi.setSystemTime(15_000)
      report('UserPromptSubmit', 'third')
      vi.setSystemTime(16_000)
      expect(report('Stop', 'third', { checkStop: true })).toEqual({ block: PROMPT })
      expect(shells.agentOf(id).status).toBe('working')
    } finally { shells.close(id); vi.useRealTimers() }
  })

  it('clears every live hook state and returns to the shell signals when official hooks are turned off', () => {
    let enabled = true
    const agents = { hooksEnabled: () => enabled, register: (_kind, shellId) => ({ env: { EZSHELL_AGENT_ID: shellId }, close: vi.fn() }) }
    const { shells, ptys } = setup({ agents })
    const { id } = shells.open({ agent: 'claude' })
    const { id: other } = shells.open({ agent: 'codex' })
    const report = (shellId, kind) => shells.reportAgentHook(shellId, shellId,
      { kind, event: 'UserPromptSubmit', promptId: 'turn', startedAt: Date.now() })
    try {
      ptys[0].emit('\x1b]7501;state=idle:app=claude\x07')
      ptys[1].emit('\x1b]7501;state=done:app=codex\x07')
      expect(report(id, 'claude')).toBe(true)
      expect(report(other, 'codex')).toBe(true)
      expect([shells.agentOf(id).status, shells.agentOf(other).status]).toEqual(['working', 'working'])
      enabled = false
      shells.clearAgentHooks()
      expect([shells.agentOf(id).status, shells.agentOf(other).status]).toEqual(['idle', 'idle'])
      expect(report(id, 'claude')).toBeUndefined()
      expect(shells.agentOf(id).status).toBe('idle')
    } finally { shells.close(id); shells.close(other) }
  })

  it('reports a quiet open hook turn and time since the last idle activity only for the owning agent', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { shells } = setup({ agents: { register: () => ({ env: { EZSHELL_AGENT_ID: 'claude-1' }, close: vi.fn() }) } })
    vi.setSystemTime(1000)
    const { id } = shells.open({ agent: 'claude' })
    const report = (event, promptId) => shells.reportAgentHook(id, 'claude-1',
      { kind: 'claude', event, promptId, startedAt: Date.now() })
    try {
      report('SessionStart')
      vi.setSystemTime(2000)
      expect(shells.inspectAgent(id, 'claude-1')).toMatchObject({ status: 'idle', statusSource: 'hook', idleFor: 1000, blocked: null })
      expect(shells.inspectAgent(id, 'claude-2')).toBeNull()
      report('UserPromptSubmit', 'turn')
      vi.setSystemTime(121_999)
      expect(shells.inspectAgent(id, 'claude-1')).toMatchObject({ status: 'working', idleFor: null, blocked: null })
      vi.setSystemTime(122_000)
      expect(shells.inspectAgent(id, 'claude-1')).toMatchObject({ status: 'working', blocked: { kind: 'hook-running' } })
      report('PreToolUse', 'turn')
      expect(shells.inspectAgent(id, 'claude-1')).toMatchObject({ blocked: null })
      report('SessionEnd', 'turn')
      expect(shells.inspectAgent(id, 'claude-1')).toMatchObject({ status: 'ended', blocked: { kind: 'ended' } })
    } finally { shells.close(id); vi.useRealTimers() }
  })

  // Recorded from Claude Code (2026-11): working spins ◐/◑ in the title, idle is ✳, and it sends no
  // program status report even after the probe is answered
  it('reads the half-circle spinner of Claude Code as working and ✳ as idle', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'claude' })
    ptys[0].emit('\x1b]0;✳ Claude Code\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]0;◐ Claude Code\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]0;◑ 인사 응답 테스트\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]0;✳ 인사 응답 테스트\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
  })

  it('answers the program status probe and prefers root state over title and child reports', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'claude' })
    ptys[0].emit('\x1b]750')
    ptys[0].emit('1;?\x07')
    expect(ptys[0].write).toHaveBeenCalledWith('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\')
    ptys[0].emit('\x1b]7501;state=blocked:app=claude-code:kind=permission\x1b\\')
    ptys[0].emit('\x1b]0;⠋ Claude\x07\x1b]7501;state=working:app=claude-code:id=job\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]7501;state=working:app=claude-code\x1b\\')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]7501;state=done:app=claude-code\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
  })

  it.each([
    ['claude', ['← □ Scope ✓ Submit →', '', 'How should I proceed?', '', '❯ 1. [ ] Use the first option',
      '  2. [ ] Type something', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel']],
    ['codex', ['Would you like to run the following command?', '', '› 1. Yes, proceed (y)',
      '  2. No, go back (esc)', '', 'Press enter to confirm or esc to cancel']]
  ])('publishes response needed for a visible %s prompt even if the CLI reports idle', async (kind, prompt) => {
    const setStatus = vi.fn()
    const { shells, ptys } = setup({ agents: { register: () => ({ env: {}, setStatus, close() {} }) } })
    const { id } = shells.open({ agent: kind, cols: 100 })
    const clear = '\x1b[?2004h\x1b[2J\x1b[H'
    const idle = `\x1b]7501;state=idle:app=${kind}\x07`
    try {
      ptys[0].emit(idle + clear + prompt.join('\r\n'))
      await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith('blocked', 'screen'))
      expect(shells.agentOf(id).status).toBe('blocked')
      ptys[0].emit(idle)
      expect(setStatus).toHaveBeenLastCalledWith('blocked', 'screen')

      // The next normal output may contain numbered text of its own.
      ptys[0].emit(clear + ['Here is the plan:', '  1. Read the file', '  2. Run the tests'].join('\r\n'))
      await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith('idle', 'screen'))
      expect(shells.agentOf(id).status).toBe('idle')
    } finally {
      shells.close(id)
    }
  })
})

describe('closeAll before an update', () => {
  it('ends the whole process tree of every live shell before closing the terminals', () => {
    const order = []
    const killTrees = vi.fn(pids => order.push(['trees', pids]))
    const { shells, ptys } = setup({ killTrees })
    shells.open()
    shells.open()
    shells.open()
    ptys.forEach((pty, index) => {
      pty.pid = 100 + index
      pty.kill.mockImplementation(() => order.push(['kill', pty.pid]))
    })
    ptys[2].exit({ exitCode: 0 })

    shells.closeAll({ killTrees: true })

    expect(killTrees).toHaveBeenCalledTimes(1)
    expect(order[0]).toEqual(['trees', [100, 101]])
    expect(order.slice(1)).toEqual([['kill', 100], ['kill', 101]])
  })

  it('leaves the trees alone on a normal quit', () => {
    const killTrees = vi.fn()
    const { shells, ptys } = setup({ killTrees })
    shells.open()
    ptys[0].pid = 100
    shells.closeAll()
    expect(killTrees).not.toHaveBeenCalled()
    expect(ptys[0].kill).toHaveBeenCalled()
  })
})
