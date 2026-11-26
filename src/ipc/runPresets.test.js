import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRunPresets, registerRunPresetIpc, resolveProject, withSubject } from './runPresets.js'
import { commandHash, createRunPresetStore, projectKey, realDirectory } from './runPresetStore.js'
import { pathKey } from '../renderer/lib/localWorkspaceTree'
import { withSubject as rendererSubject } from '../renderer/lib/runPresets'
import { zipOf } from '../../e2e/support/jdkFixture.js'

let base
beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), 'ezshell-run-')) })
afterEach(async () => {
  vi.useRealTimers()
  await rm(base, { recursive: true, force: true })
})

async function fixture(options = {}) {
  const root = await realDirectory(base)
  const file = path.join(root, 'run-presets.json')
  const outside = path.join(root, 'second-project')
  const folder = path.join(root, 'project')
  const subfolder = path.join(folder, 'sub')
  const checkout = path.join(root, 'other-checkout')
  const checkoutSubfolder = path.join(checkout, 'sub')
  await Promise.all([mkdir(subfolder, { recursive: true }), mkdir(checkoutSubfolder, { recursive: true }), mkdir(outside)])
  const location = (cwd, worktree = cwd, root = worktree) => ({ root, key: projectKey(root), worktree, worktreeKey: pathKey(worktree), cwd })
  const project = location(folder)
  const shellTasks = new Map()
  const operations = []
  const sendAsUser = vi.fn()
  const sendState = vi.fn()
  const notifyCrash = vi.fn()
  const state = { locked: false, now: 100, cwd: subfolder, bound: true }
  const handlers = new Map()
  const frame = {}
  const event = { senderFrame: frame, sender: { mainFrame: frame } }
  const allowed = () => !state.locked
  const emit = (id, event) => shellTasks.get(id).onEvent({ shellId: id, ...event })
  const shells = {
    currentDirectory: async () => state.cwd,
    chatAgentId: () => state.bound ? 'agent-1' : null,
    async openDevelopmentTask(task) {
      if (state.beforeOpen) await state.beforeOpen()
      const id = `local:${shellTasks.size + 1}`
      shellTasks.set(id, task)
      operations.push(['start', task.name, id])
      emit(id, { type: 'start', phase: task.preparation ? 'prepare' : 'server' })
      return { id }
    },
    async changeDevelopmentTask(id, _taskId, action, _allowed, prepare) {
      operations.push([action, shellTasks.get(id).name, id])
      emit(id, { type: 'exit', action, exitCode: 1 })
      if (action === 'restart') {
        const task = await prepare()
        shellTasks.set(id, task)
        emit(id, { type: 'start', phase: task.preparation ? 'prepare' : 'server' })
      }
    }
  }
  const makeController = (options = {}) => createRunPresets({ file, getShells: () => shells, getAgent: id => id === 'agent-1' ? { id, active: true, shellId: 'agent-shell' } : null,
    isLocked: () => state.locked, sendState, sendAsUser, notifyCrash, now: () => state.now, jarHome: root, javaHomeOf: id => id === 'jdk-21' ? outside : null,
    projectOf: async cwd => cwd === checkout || cwd === checkoutSubfolder ? { ...location(cwd, checkout, folder), gitWorktree: true } : location(cwd), ...options })
  const controller = makeController(options)
  const ipc = registerRunPresetIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, controller, fromMainWindow: e => e.sender === event.sender, isLocked: () => state.locked })
  const invoke = (channel, ...args) => handlers.get(channel)(event, folder, ...args)
  const invokeCheckout = (channel, ...args) => handlers.get(channel)(event, checkout, ...args)
  const save = async (name, input = {}) => (await invoke('run-presets-save', { name, relative: '.', kind: 'custom', command: 'npm run dev', ...input })).preset
  const agent = (method, name, fields = {}) => controller.agentTool('agent-1', { method: `run-${method}`, name, ...fields }, allowed)
  const list = () => controller.list(project)
  const start = async (id, command = 'npm run dev') => {
    expect(await invoke('run-preset-start', id)).toEqual({ needsConfirm: { command } })
    expect(await invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ ok: true })
  }
  return { file, outside, folder, subfolder, checkout, checkoutSubfolder, project, controller, makeController, allowed, event, handlers, ipc,
    state, list, operations, emit, save, start, invoke, invokeCheckout, agent, sendAsUser, sendState, notifyCrash, shellTasks }
}

describe('saved project runs', () => {
  it.each([7, 9])('approves one current missing JDBC JAR and mounts it for Tomcat %i', async major => {
    let home
    const f = await fixture({ toolHomeOf: () => home, toolVersionOf: () => `${major}.0.99` })
    home = f.outside
    const webLib = path.join(f.folder, 'WebContent', 'WEB-INF', 'lib')
    const projectLib = path.join(f.folder, 'lib')
    const cacheLib = path.join(path.dirname(f.file), '.m2', 'repository', 'example', 'jdbc', 'driver', '3.0')
    await Promise.all([mkdir(path.join(home, 'bin')), mkdir(path.join(home, 'conf')), mkdir(path.join(home, 'lib')),
      mkdir(webLib, { recursive: true }), mkdir(projectLib), mkdir(cacheLib, { recursive: true })])
    const driverJar = zipOf({ 'example/jdbc/Driver.class': 'fixture' })
    const first = path.join(projectLib, 'driver-1.jar')
    const alternate = path.join(projectLib, 'driver-2.jar')
    await Promise.all([
      writeFile(path.join(home, 'bin', process.platform === 'win32' ? 'catalina.bat' : 'catalina.sh'), 'fixture'),
      writeFile(path.join(home, 'conf', 'server.xml'), '<Server><Service><Connector/><Engine><Host/></Engine></Service></Server>'),
      writeFile(path.join(home, 'conf', 'context.xml'), '<Context><Resources cacheMaxSize="10240"/></Context>'),
      writeFile(path.join(f.folder, 'context.xml'), '<Context><Resource name="jdbc/Test" driverClassName="example.jdbc.Driver" password="fixture-secret"/></Context>'),
      writeFile(first, driverJar), writeFile(alternate, driverJar), writeFile(path.join(cacheLib, 'driver-3.0.jar'), driverJar)
    ])
    const input = { kind: 'tomcat', tomcat: 'fixture-tomcat', webapp: 'WebContent', contextXml: 'context.xml' }
    expect(await f.invoke('run-presets-save', { ...input, name: 'JDBC', extraLibs: ['lib/driver-1.jar'] })).toMatchObject({ ok: false })
    const saved = await f.save('JDBC', input)
    await f.start(saved.id, 'Tomcat 컨텍스트 설정 파일\ncontext.xml')
    const { shellId } = f.list().states[saved.id]
    const initial = f.shellTasks.get(shellId)
    expect(initial.missingJdbcDrivers).toEqual(['example.jdbc.Driver'])
    f.emit(shellId, { type: 'launched' })
    f.emit(shellId, { type: 'exit', exitCode: 1 })
    await initial.cleanup()
    const logged = await f.agent('log', 'JDBC', { errors: true })
    expect(logged.suggestions).toMatchObject([{ kind: 'missingClass' }])
    expect(logged.suggestions[0].jars).toEqual(expect.arrayContaining([
      { path: 'lib/driver-1.jar' }, { path: 'lib/driver-2.jar' }, { coordinate: 'example.jdbc:driver:3.0' }
    ]))
    expect(JSON.stringify(logged)).not.toContain(cacheLib)
    expect(JSON.stringify(logged)).not.toContain('fixture-secret')
    expect(logged.suggestions[0]).not.toHaveProperty('id')
    const { suggestions: [suggestion] } = await f.invoke('run-preset-diagnosis', saved.id)
    expect(suggestion).toMatchObject({ kind: 'missingClass', className: 'example.jdbc.Driver', apply: 'tomcatJar' })
    expect(suggestion.jars).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'lib/driver-1.jar', source: 'project' }),
      expect.objectContaining({ path: 'lib/driver-2.jar', source: 'project' }),
      expect.objectContaining({ path: '~/.m2/repository/example/jdbc/driver/3.0/driver-3.0.jar', source: 'maven' })
    ]))
    const request = { id: suggestion.id, jarId: suggestion.jars.find(jar => jar.path === 'lib/driver-2.jar').id }
    expect(await f.invokeCheckout('run-preset-apply-suggestion', saved.id, request)).toMatchObject({ ok: false })
    expect(await f.invoke('run-preset-apply-suggestion', saved.id, { ...request, jarId: alternate })).toMatchObject({ ok: false })
    await writeFile(alternate, zipOf({ 'example/jdbc/Missing.class': 'fixture' }))
    expect(await f.invoke('run-preset-apply-suggestion', saved.id, request)).toMatchObject({ ok: false })
    await writeFile(alternate, driverJar)
    const { preset } = await f.invoke('run-preset-apply-suggestion', saved.id, request)
    expect(preset.extraLibs).toEqual(['lib/driver-2.jar'])
    await expect(f.agent('start', 'JDBC')).rejects.toThrow('사용자가')
    await f.start(saved.id, 'Tomcat 컨텍스트 설정 파일\ncontext.xml\n\nTomcat에 연결할 JAR\nlib/driver-2.jar')
    const runtime = f.shellTasks.get(shellId)
    const base = runtime.env.CATALINA_BASE
    expect(runtime.missingJdbcDrivers).toBeUndefined()
    expect(await readFile(path.join(base, 'approved-lib', 'ezshell-approved-1.jar'))).toEqual(driverJar)
    expect(await readFile(path.join(base, 'lib', 'ezshell-approved-1.jar'))).toEqual(driverJar)
    const xml = await readFile(path.join(base, 'conf', 'server.xml'), 'utf8')
    expect(xml).toContain(major === 7 ? 'VirtualWebappLoader' : '<PostResources')
    expect(xml).toContain(major === 7 ? 'ezshell-approved-1.jar' : 'webAppMount="/WEB-INF/lib/ezshell-approved-1.jar"')
    if (major >= 8) {
      const defaults = await readFile(path.join(base, 'conf', 'context.xml'), 'utf8')
      expect(defaults).toContain('<Resources cacheMaxSize="10240">')
      expect(defaults).toContain('webAppMount="/WEB-INF/lib/ezshell-approved-1.jar"')
      expect(await readFile(path.join(home, 'conf', 'context.xml'), 'utf8')).not.toContain('PostResources')
    }
    expect(await readdir(webLib)).toEqual([])
    expect(await readdir(path.join(home, 'lib'))).toEqual([])
    expect(await f.invoke('run-preset-apply-suggestion', saved.id, request)).toMatchObject({ ok: false })
    f.emit(shellId, { type: 'exit', exitCode: 0 })
    await runtime.cleanup()
    const { preset: removed } = await f.invoke('run-presets-save', { ...preset, extraLibs: [] })
    expect(removed).not.toHaveProperty('extraLibs')
  })

  it('applies Maven suggestions only to their current run and confirms changed invocation options', async () => {
    const f = await fixture()
    const wrapper = path.join(f.folder, '.mvn', 'wrapper')
    await mkdir(wrapper, { recursive: true })
    await writeFile(path.join(wrapper, 'maven-wrapper.properties'), 'distributionUrl=https://example.invalid/apache-maven-3.6.3-bin.zip')
    await writeFile(path.join(f.folder, 'pom.xml'), '<project>spring-boot-maven-plugin</project>')
    await writeFile(path.join(f.folder, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'), 'fixture')
    const saved = await f.save('Maven', { kind: 'task', taskId: '.:maven', mavenMirrors: [{ repositoryId: 'forged', url: 'https://wrong.example.test/' }] })
    expect(saved).not.toHaveProperty('mavenMirrors')
    expect(await f.invoke('run-preset-start', saved.id)).toEqual({ ok: true })
    const { shellId } = f.list().states[saved.id]
    const blocked = '[ERROR] Could not transfer artifact example:demo:jar:1 from/to maven-default-http-blocker (http://0.0.0.0/): Blocked mirror for repositories: [legacy (http://legacy.invalid/maven/, default)]'
    f.emit(shellId, { type: 'data', data: blocked + '\n' })
    f.emit(shellId, { type: 'exit', exitCode: 1 })
    const { suggestions } = await f.invoke('run-preset-diagnosis', saved.id)
    expect(suggestions).toMatchObject([{ kind: 'mavenHttpBlocked', repositoryId: 'legacy', apply: 'mavenMirror' }])
    expect(await f.agent('log', 'Maven', { errors: true })).toMatchObject({
      suggestions: [expect.objectContaining({ kind: 'mavenHttpBlocked', repositoryId: 'legacy' })]
    })
    const report = await f.agent('log', 'Maven', { errors: true })
    expect(report.suggestions[0]).not.toHaveProperty('apply')
    expect(report.suggestions[0]).not.toHaveProperty('id')
    const request = { id: suggestions[0].id, replacementUrl: 'https://repo.example.test/maven/' }
    expect(await f.invokeCheckout('run-preset-apply-suggestion', saved.id, request)).toMatchObject({ ok: false })
    const otherFrame = { ...f.event, senderFrame: {} }
    expect(await f.handlers.get('run-preset-apply-suggestion')(otherFrame, f.folder, saved.id, request)).toMatchObject({ ok: false })
    const result = await f.invoke('run-preset-apply-suggestion', saved.id, request)
    expect(result).toMatchObject({ ok: true, preset: { mavenMirrors: [{ repositoryId: 'legacy', url: request.replacementUrl }] } })
    const renamed = await f.invoke('run-presets-save', { ...result.preset, name: 'Maven 실행', mavenMirrors: [] })
    expect(renamed.preset.mavenMirrors).toEqual(result.preset.mavenMirrors)
    await expect(f.agent('start', 'Maven 실행')).rejects.toThrow(/사용자가/)
    expect(await f.invoke('run-preset-start', saved.id)).toMatchObject({ needsConfirm: { command: expect.stringContaining('legacy → https://repo.example.test/maven/') } })
    expect(await f.invoke('run-preset-start', saved.id, { confirmCustom: true })).toEqual({ ok: true })
    const setting = path.join(path.dirname(f.file), 'runtimes', 'maven-settings', `${saved.id}.xml`)
    expect(f.shellTasks.get(shellId).command).toContain(' -gs ')
    expect(f.shellTasks.get(shellId).command).toContain(`${path.dirname(setting)}${path.sep}.run-${saved.id}-`)
    expect((await readFile(setting, 'utf8'))).not.toContain('<blocked>')
    expect(await f.invoke('run-preset-apply-suggestion', saved.id, request)).toMatchObject({ ok: false })

    f.emit(shellId, { type: 'data', data: '[DEBUG] Using mirror user-mirror (https://other.example.test/maven) for legacy (http://legacy.invalid/maven/).\n' })
    f.emit(shellId, { type: 'exit', exitCode: 1 })
    const conflict = (await f.invoke('run-preset-diagnosis', saved.id)).suggestions[0]
    expect(conflict).toMatchObject({ kind: 'mavenUserMirror', apply: 'mavenUserSettings' })
    expect(await f.invoke('run-preset-apply-suggestion', saved.id, { id: conflict.id })).toMatchObject({
      ok: true, preset: { mavenUserSettings: false }
    })
    expect(await f.invoke('run-preset-start', saved.id)).toMatchObject({ needsConfirm: { command: expect.stringContaining('서버 인증·프록시·미러·로컬 저장소') } })
    expect(await f.invoke('run-preset-start', saved.id, { confirmCustom: true })).toEqual({ ok: true })
    expect(f.shellTasks.get(shellId).command).toContain(' -s ')
    f.emit(shellId, { type: 'exit', exitCode: 0 })
    f.emit(shellId, { type: 'closed' })
    expect(await f.invoke('run-presets-delete', saved.id)).toEqual({ ok: true })
    await expect(readFile(setting, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('applies Maven settings to Tomcat preparation and reads the selected Maven version', async () => {
    let home, maven
    const f = await fixture({ toolHomeOf: () => home, toolHomeFor: kind => kind === 'maven' ? maven : null })
    home = f.outside
    maven = path.join(path.dirname(f.file), 'maven-install')
    await Promise.all([mkdir(path.join(home, 'bin')), mkdir(path.join(home, 'conf')),
      mkdir(path.join(maven, 'bin'), { recursive: true }), mkdir(path.join(maven, 'lib'), { recursive: true }),
      mkdir(path.join(f.folder, 'WebContent', 'WEB-INF'), { recursive: true })])
    await Promise.all([
      writeFile(path.join(home, 'bin', process.platform === 'win32' ? 'catalina.bat' : 'catalina.sh'), 'fixture'),
      writeFile(path.join(home, 'conf', 'server.xml'), '<Server><Service><Connector/><Engine><Host/></Engine></Service></Server>'),
      writeFile(path.join(maven, 'bin', process.platform === 'win32' ? 'mvn.cmd' : 'mvn'), 'fixture'),
      writeFile(path.join(maven, 'lib', 'maven-core-3.6.3.jar'), 'fixture')
    ])
    const saved = await f.save('Tomcat Maven', { kind: 'tomcat', tomcat: 'fixture', webapp: 'WebContent', prepare: { tool: 'maven', goals: 'verify' } })
    await f.start(saved.id, '기동 전 빌드\nmaven verify')
    const { shellId } = f.list().states[saved.id]
    f.emit(shellId, { type: 'data', phase: 'prepare', data: '[ERROR] Could not transfer artifact a:b:jar:1 from/to retired (https://retired.invalid/maven): status code: 404\n' })
    f.emit(shellId, { type: 'exit', phase: 'prepare', exitCode: 1 })
    const { suggestions } = await f.invoke('run-preset-diagnosis', saved.id)
    expect(await f.invoke('run-preset-apply-suggestion', saved.id, {
      id: suggestions[0].id, replacementUrl: 'https://mirror.example.test/maven/'
    })).toMatchObject({ ok: true })
    expect(await f.invoke('run-preset-start', saved.id)).toMatchObject({ needsConfirm: { command: expect.stringContaining('기동 전 빌드\nmaven verify') } })
    expect(await f.invoke('run-preset-start', saved.id, { confirmCustom: true })).toEqual({ ok: true })
    const task = f.shellTasks.get(shellId)
    expect(task.preparation.command).toContain('verify -gs ')
    const xml = await readFile(path.join(path.dirname(f.file), 'runtimes', 'maven-settings', `${saved.id}.xml`), 'utf8')
    expect(xml).toContain('<mirrorOf>retired</mirrorOf>')
    expect(xml).not.toContain('<blocked>')
    const server = await task.preparation.finish()
    expect(server.command).not.toContain('-gs')
    await server.cleanup()
  })

  it('confirms Tomcat preparation and VM options, reports build failure and lets MCP run approved builds by name', async () => {
    let home
    const f = await fixture({ toolHomeOf: () => home })
    home = f.outside
    await Promise.all([mkdir(path.join(home, 'bin')), mkdir(path.join(home, 'conf')), mkdir(path.join(f.folder, 'WebContent', 'WEB-INF'), { recursive: true })])
    await Promise.all([writeFile(path.join(home, 'bin', process.platform === 'win32' ? 'catalina.bat' : 'catalina.sh'), 'fixture'),
      writeFile(path.join(home, 'conf', 'server.xml'), '<Server><Service><Connector/><Engine><Host/></Engine></Service></Server>'),
      writeFile(path.join(f.folder, 'build.xml'), '<project><target name="pack"/><target name="compile"/></project>')])
    expect(await f.invoke('run-preset-ant-targets', '.')).toEqual({ ok: true, targets: ['pack', 'compile'] })
    expect(await f.invoke('run-preset-webapps')).toEqual({ ok: true, folders: ['WebContent'] })
    const saved = await f.save('Tomcat', { kind: 'tomcat', tomcat: 'fixture-tomcat', webapp: 'WebContent', vmArgs: '-Xmx512m', prepare: { tool: 'ant', target: 'pack' } })
    await expect(f.agent('start', 'Tomcat')).rejects.toThrow('사용자가')
    expect(await f.invoke('run-preset-start', saved.id, { confirmCustom: true })).toEqual({ needsConfirm: { command: '기동 전 빌드\nant pack\n\nTomcat VM 인자\n-Xmx512m' } })
    expect(await f.invoke('run-preset-start', saved.id, { confirmCustom: true })).toEqual({ ok: true })
    const { shellId } = f.list().states[saved.id]
    f.emit(shellId, { type: 'data', phase: 'prepare', data: 'Server startup in 50 seconds http://localhost:8080/\n' })
    expect(f.list().states[saved.id]).toMatchObject({ status: 'preparing', address: undefined })
    f.emit(shellId, { type: 'data', phase: 'prepare', data: 'ERROR missing output\n' })
    f.emit(shellId, { type: 'exit', phase: 'prepare', exitCode: 7 })
    expect(f.list().states[saved.id]).toMatchObject({ status: 'crashed', failedAt: 'prepare', exitCode: 7 })
    expect(await f.agent('log', 'Tomcat', { errors: true })).toMatchObject({ groups: expect.arrayContaining([expect.objectContaining({ lines: ['ERROR 빌드 실패', 'ERROR missing output'] })]) })
    await expect(f.agent('start', 'Tomcat')).resolves.toEqual({ ok: true })
    const task = f.shellTasks.get(shellId)
    const runtime = await task.preparation.finish(new AbortController().signal)
    f.emit(shellId, { type: 'prepared' })
    runtime.onEvent({ type: 'launched', shellId, pid: 17, env: runtime.env })
    f.emit(shellId, { type: 'data', phase: 'server', data: 'INFO Server startup in 108 milliseconds\n' })
    expect((await f.agent('list')).presets[0]).toMatchObject({ status: 'running', port: 8080 })
    expect(f.list().states[saved.id].address).toBe('http://127.0.0.1:8080/')
    await runtime.cleanup()
    await f.invoke('run-preset-stop', saved.id)
    await f.save('Tomcat', { ...saved, prepare: { tool: 'ant', target: 'compile' } })
    expect(await f.invoke('run-preset-start', saved.id)).toMatchObject({ needsConfirm: { command: expect.stringContaining('ant compile') } })
  })

  it('takes workspace trust from the main-frame dialog and approves context paths without copying settings to the store', async () => {
    const f = await fixture()
    const workspace = f.outside
    const server = path.join(workspace, 'Servers', 'Tomcat-config')
    await mkdir(server, { recursive: true })
    await mkdir(path.join(f.folder, 'WebContent', 'WEB-INF'), { recursive: true })
    const reference = path.join(server, 'context.xml')
    await writeFile(reference, '<Context><Resource name="jdbc/Test" password="fixture-password"/></Context>')
    await writeFile(path.join(server, 'server.xml'), '<Server><Service><Connector port="8180"/></Service></Server>')
    const handlers = new Map()
    const pickWorkspace = vi.fn(async () => workspace)
    const pickContext = vi.fn(async () => reference)
    registerRunPresetIpc({ ipcMain: { handle: (key, handle) => handlers.set(key, handle) }, controller: f.controller,
      fromMainWindow: event => event.sender === f.event.sender, isLocked: () => f.state.locked,
      chooseWorkspaceFolder: pickWorkspace, chooseContextFile: pickContext })
    const input = { name: 'Tomcat', kind: 'tomcat', tomcat: 'tomcat-9.0.124', webapp: 'WebContent', contextXml: reference, logEncoding: 'ms949' }
    expect(await f.invoke('run-presets-save', input)).toMatchObject({ ok: false })
    expect(await handlers.get('run-preset-workspace-servers')({ ...f.event, senderFrame: {} }, f.folder)).toMatchObject({ ok: false })
    expect(pickWorkspace).not.toHaveBeenCalled()
    expect(await handlers.get('run-preset-workspace-servers')(f.event, f.folder, 'renderer-overridden path'))
      .toMatchObject({ ok: true, workspace: 'second-project', servers: [{ contextXml: reference, name: 'Tomcat', port: 8180 }] })
    expect(pickWorkspace).toHaveBeenCalledExactlyOnceWith(f.folder)
    expect(await handlers.get('run-preset-choose-context-xml')(f.event, f.folder))
      .toMatchObject({ ok: true, contextXml: reference, label: 'context.xml' })
    const { preset } = await f.invoke('run-presets-save', input)
    expect(preset).toMatchObject({ contextXml: reference, logEncoding: 'ms949' })
    expect(await readFile(f.file, 'utf8')).not.toContain('fixture-password')
    const approval = await f.invoke('run-preset-start', preset.id)
    expect(approval).toEqual({ needsConfirm: { command: `Tomcat 컨텍스트 설정 파일\n${reference}` } })
  })

  it('checks names, env, relative paths and stored data', async () => {
    const f = await fixture()
    await symlink(f.outside, path.join(f.folder, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const input of [{ name: 'a'.repeat(21) }, { relative: '../second-project' }, { relative: 'outside' },
      { env: { a: 'no' } }, { env: { A: 'many\nlines' } }, { env: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`A${i}`, 'x'])) }]) {
      expect(await f.invoke('run-presets-save', { name: 'ok', kind: 'custom', command: 'node dev', ...input })).toMatchObject({ ok: false })
    }
    const preset = await f.save('web', { env: { PORT: '5431' }, confirmedHash: commandHash('npm run dev') })
    expect(preset).toMatchObject({ env: { PORT: '5431' } })
    expect(preset.hotReload).toBe('off')
    expect(preset).not.toHaveProperty('confirmedHash')
    const data = JSON.parse(await readFile(f.file, 'utf8'))
    expect(data.projects[0].presets[0]).not.toHaveProperty('confirmedHash')
    data.projects[0].presets.push({ ...preset, name: 'x'.repeat(21) })
    data.projects[0].presets[0].confirmedHash = commandHash('a different command')
    delete data.projects[0].presets[0].hotReload
    await writeFile(f.file, JSON.stringify(data))
    expect(createRunPresetStore(f.file).list(projectKey(f.folder))).toEqual([preset])
  })

  it.each(['temurin-21.0.5+11-x64', 'jbr-21.0.11+1163.125-x64', 'zulu-17.0.15-x64'])(
    'saves and reloads the managed JDK ID %s', async jdk => {
      const f = await fixture()
      const preset = await f.save('Server', { jdk })
      expect(preset).toMatchObject({ jdk })
      expect(createRunPresetStore(f.file).list(projectKey(f.folder))).toEqual([preset])
    })

  it('allows hot reload only for Spring Boot candidates and checks enhanced JDK support at launch', async () => {
    const f = await fixture()
    for (const input of [{ kind: 'custom', command: 'node dev' }, { kind: 'task', taskId: '.:node' }]) {
      expect(await f.invoke('run-presets-save', { name: 'try', hotReload: 'standard', ...input })).toMatchObject({ ok: false, error: expect.stringContaining('Spring Boot') })
    }
    await writeFile(path.join(f.folder, 'pom.xml'), '<artifactId>spring-boot-starter</artifactId>')
    const saved = await f.save('Spring', { kind: 'task', taskId: '.:maven', hotReload: 'enhanced', jdk: 'jdk-21' })
    expect(saved).toMatchObject({ hotReload: 'enhanced' })
    expect(await f.invoke('run-preset-start', saved.id)).toMatchObject({ ok: false, error: expect.stringContaining('HotswapAgent') })
    expect(f.operations).toEqual([])
  })

  it('reports hot reload in run_list, prepends results and lets run_wait observe the first new result', async () => {
    const f = await fixture()
    await writeFile(path.join(f.folder, 'pom.xml'), '<artifactId>spring-boot-starter</artifactId>')
    const close = vi.fn()
    const suspend = vi.fn()
    const resume = vi.fn()
    let callbacks
    const controller = f.makeController({ prepareReload: async task => ({ ...task, hotReload: { port: 57334 } }),
      startReload(config, options) { callbacks = options; expect(config.port).toBe(57334); return { close, suspend, resume } } })
    const { preset } = await controller.save(f.project, { name: 'Spring', kind: 'task', taskId: '.:maven', hotReload: 'standard' }, f.allowed)
    await controller.act(f.project, preset.id, 'start', { allowed: f.allowed })
    expect(callbacks).toBeUndefined()
    f.emit('local:1', { type: 'launched', pid: 13, env: { Path: 'JDK' } })
    expect(callbacks).toMatchObject({ pid: 13, env: { Path: 'JDK' } })
    expect(callbacks.running()).toBe(false)
    f.emit('local:1', { type: 'data', data: 'INFO Started Spring in 1.2 seconds\r\n' })
    expect(callbacks.running()).toBe(true)
    const read = (operation, fields) => controller.agentTool('agent-1', { method: `run-${operation}`, name: 'Spring', ...fields }, f.allowed)
    callbacks.onState({ status: 'applied', classes: 1, at: 101 })
    const wait = read('wait', { seconds: 2, until: 'reload' })
    const failure = { status: 'compileError', at: 102, reason: 'javac 컴파일에 실패했습니다.' }
    callbacks.onState({ status: 'compiling', at: 102 })
    callbacks.onState(failure, ['Example.java:1: error: Missing symbol'])
    callbacks.onState({ status: 'applied', classes: 2, at: 103 })
    expect(await wait).toMatchObject({ result: 'compileError', status: 'running', reload: failure })
    const listed = await read('list')
    expect(listed.presets[0]).toMatchObject({ status: 'running', port: null, errors: 1, reload: { status: 'applied', classes: 2 } })
    expect(JSON.stringify(listed)).not.toContain('57334')
    const recent = await read('log', { lines: 2 })
    expect(recent.lines).toEqual([expect.stringContaining('바로 반영됨 · 클래스 2개'), expect.stringContaining('컴파일 오류')])
    const { groups } = await read('log', { errors: true })
    expect(groups.at(-1).lines).toEqual(['ERROR javac 컴파일에 실패했습니다.', 'Example.java:1: error: Missing symbol'])
    expect(JSON.stringify(f.sendState.mock.calls)).not.toContain('57334')
    f.state.locked = true
    controller.suspendReloads()
    expect(suspend).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    f.state.locked = false
    controller.resumeReloads()
    expect(resume).toHaveBeenCalledTimes(1)
    await controller.act(f.project, preset.id, 'stop', { allowed: f.allowed })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('confirms the exact command from the main frame and restarts in one shell', async () => {
    const f = await fixture()
    const saved = await f.save('web', { jdk: 'jdk-21', env: { PORT: '26789' } })
    const { id } = saved
    const unauthorized = await f.handlers.get('run-preset-start')({ ...f.event, senderFrame: {} }, f.folder, id)
    expect(unauthorized.ok).toBe(false)
    expect(await f.invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ needsConfirm: { command: 'npm run dev' } })
    await f.save('web', { ...saved, command: 'node dev.js' })
    expect(await f.invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ needsConfirm: { command: 'node dev.js' } })
    expect(f.operations).toEqual([])
    expect(await f.invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ ok: true })
    const shellId = f.list().states[id].shellId
    expect(f.shellTasks.get(shellId)).toMatchObject({ env: { PORT: '26789' }, javaHome: f.outside })
    expect(await f.invoke('run-preset-restart', id)).toEqual({ ok: true })
    expect(f.operations).toEqual([['start', 'web', shellId], ['restart', 'web', shellId]])
    expect(f.notifyCrash).not.toHaveBeenCalled()
    expect(f.sendState).toHaveBeenLastCalledWith(expect.objectContaining({ id, state: expect.objectContaining({ shellId, status: 'starting' }) }))
    expect(createRunPresetStore(f.file).list(projectKey(f.folder))[0].confirmedHash).toBe(commandHash('node dev.js'))
  })

  it('checks shell binding, project, lock, per-preset control and the user stop window', async () => {
    const f = await fixture()
    const web = await f.save('web')
    const privatePreset = await f.save('private', { agentControl: false })
    expect(await f.agent('list')).toMatchObject({ presets: [{ name: 'web' }, { name: 'private', agentControl: false }] })
    await expect(f.agent('start', 'private')).rejects.toThrow('꺼져')
    await expect(f.agent('restart', 'private')).rejects.toThrow('꺼져')
    await expect(f.agent('stop', 'private')).rejects.toThrow('꺼져')
    expect(await f.agent('wait', 'private')).toEqual({ result: 'idle', status: 'idle' })
    await f.start(privatePreset.id)
    const privateShell = f.list().states[privatePreset.id].shellId
    f.emit(privateShell, { type: 'data', data: 'VITE v5 ready in 11 ms\nERROR compile failed\n' })
    expect(await f.agent('wait', 'private')).toEqual({ result: 'ready', status: 'running' })
    expect(await f.agent('log', 'private', { errors: true })).toEqual({ groups: [{ at: 100, lines: ['ERROR compile failed'] }], suggestions: [] })
    await expect(f.agent('start', 'web')).rejects.toThrow('사용자가')
    await expect(f.agent('wait', 'web', { until: 'reload' })).rejects.toThrow('바로 반영이 꺼져')
    f.state.bound = false
    await expect(f.agent('list')).rejects.toThrow('작업 폴더')
    f.state.bound = true
    f.state.cwd = f.outside
    await expect(f.agent('start', 'web')).rejects.toThrow('찾을 수 없습니다')
    f.state.cwd = f.subfolder
    await f.start(web.id)
    const shellId = f.list().states[web.id].shellId
    const waiting = f.agent('wait', 'web', { seconds: 2 })
    f.emit(shellId, { type: 'data', data: 'VITE v5 ready in 11 ms\r\n  Local: http://localhost:26789/\r\n' })
    expect(await waiting).toMatchObject({ result: 'ready', status: 'running' })
    await f.invoke('run-preset-stop', web.id)
    await expect(f.agent('restart', 'web')).rejects.toThrow('방금 중지')
    f.state.now += 30_000
    expect(await f.agent('start', 'web')).toEqual({ ok: true })
    expect(f.list().states[web.id].lastAction).toMatchObject({ by: 'agent-1', action: 'start' })
    f.state.locked = true
    await expect(f.agent('log', 'web')).rejects.toThrow('잠금')
    expect(await f.invoke('run-preset-stop', web.id)).toMatchObject({ ok: false })
  })

  it('confirms a batch before starting, follows its order and waits for the previous preset', async () => {
    const f = await fixture()
    const front = await f.save('front', { command: 'node front.js', waitReady: true })
    const back = await f.save('back', { command: 'node back.js' })
    await f.save('manual', { inAll: false })
    expect(await f.invoke('run-presets-reorder', [back.id, front.id, f.list().presets[2].id])).toEqual({ ok: true })
    expect(await f.invoke('run-preset-start-all')).toEqual({ needsConfirm: { command: 'node back.js' } })
    expect(await f.invoke('run-preset-start-all', { confirmCustom: true })).toEqual({ needsConfirm: { command: 'node front.js' } })
    expect(f.operations).toEqual([])
    const batch = f.invoke('run-preset-start-all', { confirmCustom: true })
    await vi.waitFor(() => expect(f.operations).toEqual([['start', 'back', 'local:1']]))
    f.emit('local:1', { type: 'data', data: 'VITE v5 ready in 10 ms\n' })
    expect(await batch).toEqual({ ok: true })
    expect(f.operations.map(([, name]) => name)).toEqual(['back', 'front'])
  })

  it('requires a fresh install confirmation and denies dependency installation to an agent', async () => {
    const f = await fixture()
    await writeFile(path.join(f.folder, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }))
    const { candidates } = await f.invoke('run-presets-candidates', '.')
    const saved = await f.save('web', { kind: 'task', taskId: candidates[0].taskId })
    const install = process.platform === 'win32' ? 'npm.cmd install' : 'npm install'
    await expect(f.agent('start', 'web')).rejects.toThrow('의존성 설치가 필요합니다')
    expect(await f.invoke('run-preset-start', saved.id, { confirmInstall: true })).toEqual({ needsInstall: { command: install } })
    expect(await f.invoke('run-preset-start', saved.id, { confirmInstall: true })).toEqual({ ok: true })
    expect(f.shellTasks.get('local:1').installCommand).toBe(install)
    expect(await f.invoke('run-preset-restart', saved.id, { confirmInstall: true })).toEqual({ needsInstall: { command: install } })
    expect(f.operations).toHaveLength(1)
    await mkdir(path.join(f.folder, 'node_modules'))
    expect(await f.invoke('run-preset-restart', saved.id)).toEqual({ ok: true })
    expect(f.shellTasks.get('local:1').installCommand).toBeUndefined()
  })

  it('delivers clean crash details only to a same-project agent and honors notify', async () => {
    const f = await fixture()
    const { id } = await f.save('web')
    await f.start(id)
    f.emit('local:1', { type: 'data', data: '\x1b[31mERROR failed\x1b[0m\r\n    at fixture (main.js:1:2)\r\n' })
    f.emit('local:1', { type: 'exit', exitCode: 1 })
    f.emit('local:1', { type: 'exit', exitCode: 1 })
    expect(f.notifyCrash).toHaveBeenCalledExactlyOnceWith('project', 'web')
    expect(f.list().states[id]).toMatchObject({ status: 'crashed', exitCode: 1, errors: 1 })
    expect(await f.agent('log', 'web', { lines: 2 })).toEqual({ lines: ['ERROR failed', '    at fixture (main.js:1:2)'] })
    expect(await f.invoke('run-preset-send', id, 'agent-1', '확인 부탁합니다')).toEqual({ ok: true })
    expect(f.sendAsUser.mock.calls[0][0]).toMatchObject({ to: 'agent-1', text: expect.stringContaining('ERROR failed\n    at fixture (main.js:1:2)\n\n확인 부탁합니다') })
    f.state.cwd = f.outside
    expect(await f.invoke('run-preset-send', id, 'agent-1', '')).toMatchObject({ ok: false })
    const silent = await f.save('quiet', { notify: false })
    await f.start(silent.id)
    f.emit('local:2', { type: 'exit', exitCode: 1 })
    expect(f.notifyCrash).toHaveBeenCalledTimes(1)
  })

  it('previews the exact body from the main frame and keeps it when the run changes before sending', async () => {
    const f = await fixture()
    const { id } = await f.save('web', { relative: 'sub' })
    await f.start(id)
    f.emit('local:1', { type: 'data', data: `ERROR failure ${'x'.repeat(1500)}\n${'    at fixture (src/very-long-fixture-name/main.js:1:2)\n'.repeat(80)}` })
    f.emit('local:1', { type: 'exit', exitCode: 2 })
    const preview = (event = f.event) => f.handlers.get('run-preset-send-preview')(event, f.folder, id)
    await expect(preview({ ...f.event, senderFrame: {} })).resolves.toMatchObject({ ok: false })
    f.state.locked = true
    await expect(preview()).resolves.toMatchObject({ ok: false })
    f.state.locked = false
    const { text } = await preview()
    expect(text).toMatch(/^web\n폴더 sub\/\n실행 방식 직접 입력\n종료 코드 2\n\nERROR failure/)
    expect(text).not.toContain(f.folder)
    expect(text).toHaveLength(3998)
    expect(await f.invoke('run-preset-restart', id)).toEqual({ ok: true })
    const note = 'n'.repeat(4000)
    expect(await f.invoke('run-preset-send', id, 'agent-1', note)).toEqual({ ok: true })
    expect(f.sendAsUser).toHaveBeenLastCalledWith({ to: 'agent-1', text: `${text}\n\n${note}` })
    expect(f.sendAsUser.mock.lastCall[0].text.length).toBeLessThanOrEqual(8000)
    const fresh = await preview()
    expect(fresh.text).not.toContain('ERROR failure')
    expect(await f.invoke('run-preset-send', id, 'agent-1', '  ')).toEqual({ ok: true })
    expect(f.sendAsUser).toHaveBeenLastCalledWith({ to: 'agent-1', text: fresh.text })
  })

  it('resolves the primary project and current worktree separately in a real Git repository', async () => {
    const f = await fixture()
    const linked = path.join(base, 'linked-checkout')
    const git = (...args) => execFileSync('git', args, { cwd: f.folder, stdio: 'pipe', windowsHide: true })
    git('init')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture')
    git('worktree', 'add', '--detach', linked)
    const nested = path.join(linked, 'nested')
    await mkdir(nested)
    expect(await resolveProject(nested)).toMatchObject({ root: f.folder, key: pathKey(f.folder), worktree: await realDirectory(linked), worktreeKey: pathKey(await realDirectory(linked)) })
  })

  it('shares presets across worktrees and keeps user and agent actions within their worktree', async () => {
    const f = await fixture()
    const preset = await f.save('web', { relative: 'sub' })
    const { id } = preset
    await f.start(id)
    const other = await f.invokeCheckout('run-presets-list')
    expect(other).toEqual({ projectKey: pathKey(f.folder), worktreeKey: pathKey(f.checkout), presets: [preset],
      states: { [id]: { status: 'idle', errors: 0 } } })
    expect(f.shellTasks.get('local:1').cwd).toBe(f.subfolder)
    f.state.cwd = f.checkoutSubfolder
    expect((await f.agent('list')).presets[0].status).toBe('idle')
    expect(await f.agent('start', 'web')).toEqual({ ok: true })
    expect(f.shellTasks.get('local:2').cwd).toBe(f.checkoutSubfolder)
    expect(f.sendState).toHaveBeenLastCalledWith({ projectKey: pathKey(f.folder), worktreeKey: pathKey(f.checkout), id,
      state: expect.objectContaining({ shellId: 'local:2', lastAction: { by: 'agent-1', action: 'start', at: 100 } }), firstAgentAction: true })
    f.emit('local:2', { type: 'data', data: 'ERROR in other checkout\n' })
    expect(await f.invoke('run-preset-errors', id)).toEqual({ groups: [] })
    expect(await f.agent('log', 'web', { lines: 1 })).toEqual({ lines: ['ERROR in other checkout'] })
    expect(await f.invoke('run-preset-stop-all')).toEqual({ ok: true })
    expect(f.list().states[id].status).toBe('stopped')
    expect((await f.invokeCheckout('run-presets-list')).states[id]).toMatchObject({ status: 'starting', shellId: 'local:2' })
    await expect(f.agent('restart', 'web')).resolves.toEqual({ ok: true })
    expect(f.operations.at(-1)).toEqual(['restart', 'web', 'local:2'])
    expect(await f.invoke('run-presets-delete', id)).toMatchObject({ ok: false })
  })

  it('persists the first agent start or restart notice once per preset across worktrees and app reloads', async () => {
    const f = await fixture()
    const preset = await f.save('web', { agentActionNotified: true })
    await f.start(preset.id)
    expect(f.sendState.mock.calls.some(([event]) => event.firstAgentAction)).toBe(false)
    await f.agent('restart', 'web')
    f.state.cwd = f.checkoutSubfolder
    await f.agent('start', 'web')
    const notices = () => f.sendState.mock.calls.map(([event]) => event).filter(event => event.firstAgentAction)
    expect(notices()).toEqual([expect.objectContaining({ worktreeKey: pathKey(f.folder), state: expect.objectContaining({ lastAction: expect.objectContaining({ action: 'restart' }) }) })])
    await f.save('web', preset)
    expect(createRunPresetStore(f.file).list(projectKey(f.folder))[0].agentActionNotified).toBe(true)
    expect(f.list().presets[0]).not.toHaveProperty('agentActionNotified')
    await f.makeController().agentTool('agent-1', { method: 'run-start', name: 'web' }, f.allowed)
    expect(notices()).toHaveLength(1)
  })

  it('resolves each task against the package manifest in the selected checkout', async () => {
    const f = await fixture()
    await Promise.all([writeFile(path.join(f.folder, 'package.json'), JSON.stringify({ scripts: { dev: 'node dev.js' } })),
      writeFile(path.join(f.checkout, 'package.json'), JSON.stringify({ scripts: { serve: 'node serve.js' } })),
      mkdir(path.join(f.folder, 'node_modules')), mkdir(path.join(f.checkout, 'node_modules'))])
    const { candidates } = await f.invoke('run-presets-candidates', '.')
    const saved = await f.save('web', { kind: 'task', taskId: candidates[0].taskId })
    expect(await f.invoke('run-preset-start', saved.id)).toEqual({ ok: true })
    expect(await f.invokeCheckout('run-preset-start', saved.id)).toEqual({ ok: true })
    expect(f.shellTasks.get('local:1')).toMatchObject({ cwd: f.folder, command: expect.stringMatching(/ run dev$/) })
    expect(f.shellTasks.get('local:2')).toMatchObject({ cwd: f.checkout, command: expect.stringMatching(/ run serve$/) })
  })

  it('waits for a launch already in progress before stopping it', async () => {
    const f = await fixture()
    const preset = await f.save('web')
    const entered = Promise.withResolvers()
    const resume = Promise.withResolvers()
    f.state.beforeOpen = () => { entered.resolve(); return resume.promise }
    await f.invoke('run-preset-start', preset.id)
    const starting = f.invoke('run-preset-start', preset.id, { confirmCustom: true })
    await entered.promise
    const stopping = f.controller.stopAll(f.project, f.allowed)
    expect(f.operations).toEqual([])
    resume.resolve()
    expect(await starting).toEqual({ ok: true })
    expect(await stopping).toEqual({ ok: true })
    expect(f.operations.map(([action]) => action)).toEqual(['start', 'stop'])
    expect(f.list().states[preset.id]).toMatchObject({ status: 'stopped', lastAction: { action: 'stop', by: 'user' } })
  })

  it('reports a transition still busy after the 10 second stop-all budget', async () => {
    const f = await fixture()
    const preset = await f.save('web')
    const entered = Promise.withResolvers()
    const resume = Promise.withResolvers()
    f.state.beforeOpen = () => { entered.resolve(); return resume.promise }
    await f.invoke('run-preset-start', preset.id)
    const starting = f.invoke('run-preset-start', preset.id, { confirmCustom: true })
    await entered.promise
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const stopping = f.controller.stopAll(f.project, f.allowed).catch(error => { settled = true; return error.message })
    await vi.advanceTimersByTimeAsync(9999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stopping).toContain('10초')
    resume.resolve()
    await starting
    await vi.waitFor(() => expect(f.list().states[preset.id]).toMatchObject({ status: 'stopped' }))
  })

  it.each(['백엔드', '웹앱', 'Vite', '서버2', '서버3'])('matches the renderer subject particle for %s', name => {
    expect(withSubject(name)).toBe(rendererSubject(name))
  })
})
