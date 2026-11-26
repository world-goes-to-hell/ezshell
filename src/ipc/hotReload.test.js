import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { HOT_ARGS, MAVEN_ARGS, INIT_GRADLE, portFilter, prepareHotReload, startHotReload } from './hotReload.js'
import { createJavac, devtoolsLayout, inspectJavaBuild, javaLayout, javacArguments } from './hotReloadJava.js'

let root
let source
let output
let sourceFile
let leases
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-hot-test-'))
  source = path.join(root, 'src', 'main', 'java')
  output = path.join(root, 'target', 'classes')
  await Promise.all([fs.mkdir(source, { recursive: true }), fs.mkdir(output, { recursive: true })])
  sourceFile = path.join(source, 'Example.java')
  await fs.writeFile(sourceFile, 'class Example {}')
  leases = []
})
afterEach(async () => {
  for (const lease of leases) lease.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('hot reload launch', () => {
  it('quotes the complete Maven property for PowerShell and POSIX and hides the launch port', async () => {
    const port = 52147
    const task = { id: '.:maven', command: 'mvn spring-boot:run', cwd: root }
    const launch = await prepareHotReload(task, { worktree: root, userData: root, platform: 'win32', mode: 'standard', reserve: async () => port })
    expect(launch.command).toBe(`mvn spring-boot:run '-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,quiet=y,address=127.0.0.1:${port}'`)
    const privateOutput = ['Listening at 127.0.0.1:52', '147\r\nStarted App at http://localhost:8080/\r\n'].map(text => launch.filterOutput(text)).join('')
    expect(privateOutput).not.toContain(String(port))
    expect(privateOutput).toContain('http://localhost:8080')
    const posix = await prepareHotReload(task, { worktree: root, userData: root, platform: 'linux', mode: 'enhanced', reserve: async () => port,
      args: ["-javaagent:/root's tools/agent.jar"] })
    expect(posix.command).toContain('"-javaagent:/root\'\\\'\'s tools/agent.jar"')
    const filter = portFilter(12321)
    expect(filter('12') + filter('3') + filter('21') + filter('', true)).toBe('[바로 반영]')
    expect(filter('in 1') + filter('12321ms, pid 12321') + filter('0')).toBe('in 112321ms, pid 123210')
  })

  it.skipIf(process.platform !== 'win32')('passes an agent path with spaces as a single quoted JVM argument through a Windows Maven wrapper', async () => {
    await fs.writeFile(path.join(root, 'mvnw.cmd'), '@echo off\r\ncall "%~dp0maven-argv.cmd" %*\r\n')
    await fs.writeFile(path.join(root, 'maven-argv.cmd'), `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`)
    const agent = "-javaagent:C:\\Users\\John O'Connor (Dev)\\Java tools\\agent.jar"
    const launch = await prepareHotReload({ id: '.:maven', command: '.\\mvnw.cmd spring-boot:run', cwd: root },
      { worktree: root, userData: root, platform: 'win32', mode: 'enhanced', args: ['-Dsample=yes', agent], reserve: async () => 52147 })
    expect(launch.command).not.toContain('Java tools')
    expect(launch.env[MAVEN_ARGS]).toBe(`-Dsample=yes "${agent}"`)
    expect(launch.env[MAVEN_ARGS]).not.toContain('52147')
    const encoded = Buffer.from(launch.command, 'utf16le').toString('base64')
    const argv = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { cwd: root, encoding: 'utf8', windowsHide: true }))
    expect(argv).toEqual(['spring-boot:run', `-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,quiet=y,address=127.0.0.1:52147 \${env.${MAVEN_ARGS}}`])
  })

  it('only gives bootRun the Gradle JVM arguments, including an agent path with spaces', async () => {
    const args = ['-XX:+AllowEnhancedClassRedefinition', '-javaagent:C:\\Java agents\\hotswap-agent.jar']
    const task = { id: '.:gradle', command: './gradlew bootRun --no-daemon', cwd: root, env: { X: 'Y' } }
    const launch = await prepareHotReload(task, { worktree: root, userData: root, platform: 'linux', mode: 'enhanced', args, reserve: async () => 52148 })
    const init = path.join(root, 'hot-reload', 'init.gradle')
    expect(launch.command).toBe(`${task.command} -I '${init}'`)
    expect(launch.command).not.toContain('52148')
    expect(launch.env.X).toBe('Y')
    expect(JSON.parse(launch.env[HOT_ARGS]).slice(1)).toEqual(args)
    expect(await fs.readFile(init, 'utf8')).toBe(INIT_GRADLE)
    expect(INIT_GRADLE).toMatch(/task.name == 'bootRun'/)
    expect(INIT_GRADLE).toContain(`task.environment.remove('${HOT_ARGS}')`)
    expect(task.env).toEqual({ X: 'Y' })
  })

  it('uses DevTools without opening a debug endpoint and reads Java build options', async () => {
    await fs.writeFile(path.join(root, 'pom.xml'), `<project><project.build.sourceEncoding>MS949</project.build.sourceEncoding>
      <encoding>\${project.build.sourceEncoding}</encoding><dependencies><dependency><artifactId>spring-boot-devtools</artifactId></dependency>
      <!-- <artifactId>lombok</artifactId> --></dependencies></project>`)
    const task = { id: '.:maven', command: 'mvn spring-boot:run', cwd: root }
    const reserve = vi.fn()
    const launch = await prepareHotReload(task, { worktree: root, userData: root, mode: 'standard', reserve })
    expect(await inspectJavaBuild(root)).toEqual({ devtools: true, lombok: false, encoding: 'MS949' })
    expect(launch).toEqual({ ...task, hotReload: { worktree: root, cwd: root, devtools: true } })
    expect(reserve).not.toHaveBeenCalled()
  })
})

describe('hot reload classpath and compiler', () => {
  it('expands a manifest-only Maven classpath and skips network entries', async () => {
    // An archive whose Class-Path header has a folded local name and a network URL.
    const manifest = 'UEsDBBQAAAAIAGxFel1h+2hsYwAAAGwAAAAUAAAATUVUQS1JTkYvTUFOSUZFU1QuTUYVyjEOgzAMQNE9Uu7ghZG4MGZlrtSpu2lMMUpDFFsVxwfW//6Tiiys1r+5qewlwhAe3k2ZVPsX2RrBqH3Z8HMnVoQsM/JhjbrxOiFxDRs1WM2qRryIfjVzkPKnLAnLfrN33p1QSwECFAAUAAAACABsRXpdYftobGMAAABsAAAAFAAAAAAAAAAAAAAAAAAAAAAATUVUQS1JTkYvTUFOSUZFU1QuTUZQSwUGAAAAAAEAAQBCAAAAlQAAAAAA'
    const jar = path.join(root, 'maven classpath.jar')
    const lib = path.join(root, 'lib')
    const dependency = path.join(lib, 'extra dep.jar')
    await fs.mkdir(lib)
    await Promise.all([fs.writeFile(jar, Buffer.from(manifest, 'base64')), fs.writeFile(dependency, 'fixture')])
    expect(await javaLayout({ baseDir: root, classpaths: [jar] }, root)).toEqual({ classpath: [jar, output, dependency], roots: [{ source, output, moduleRoot: root }] })
  })

  it('finds output-source pairs only in the current worktree', async () => {
    const module = path.join(root, 'api')
    const gradleSource = path.join(module, 'src', 'main', 'java')
    const gradleOutput = path.join(module, 'build', 'classes', 'java', 'main')
    await Promise.all([fs.mkdir(gradleSource, { recursive: true }), fs.mkdir(gradleOutput, { recursive: true })])
    const layout = await javaLayout({ baseDir: root, classpaths: ['target/classes', gradleOutput, 'missing'] }, root)
    expect(layout).toEqual({ classpath: [output, gradleOutput], roots: [
      { source, output, moduleRoot: root }, { source: gradleSource, output: gradleOutput, moduleRoot: module }
    ] })
  })

  it('only queries the DevTools JVM descended from the configured terminal', async () => {
    const jar = path.join(root, 'spring-boot-devtools-3.3.4.jar')
    await fs.writeFile(jar, 'fixture')
    const properties = `java.class.path=${[output, jar].join(path.delimiter).replaceAll('\\', '\\\\')}\nuser.dir=${root.replaceAll('\\', '\\\\')}\n`
    const run = vi.fn(async () => ({ stdout: properties }))
    const layout = await devtoolsLayout({ pid: 1, env: {}, cwd: root, worktree: root, signal: new AbortController().signal, run,
      processes: async () => new Map([[2, { parent: 1, name: 'cmd.exe' }], [3, { parent: 2, name: 'java.exe' }], [4, { parent: 99, name: 'java.exe' }]]) })
    expect(run).toHaveBeenCalledExactlyOnceWith(process.platform === 'win32' ? 'jcmd.exe' : 'jcmd', ['3', 'VM.system_properties'], expect.anything())
    expect(layout?.classpath).toEqual([output, jar])
  })

  it('uses a javac argument file, matches the release, and includes cached Lombok', async () => {
    const classHeader = Buffer.from('cafebabe000000340001', 'hex')
    await fs.writeFile(path.join(output, 'Example.class'), classHeader)
    const home = path.join(root, 'home')
    const cache = path.join(home, '.m2', 'repository', 'org', 'projectlombok', 'lombok', '1.18.42')
    await fs.mkdir(cache, { recursive: true })
    const processor = path.join(cache, 'lombok-1.18.42.jar')
    await fs.writeFile(processor, 'fixture')
    await fs.writeFile(path.join(root, 'pom.xml'), '<artifactId>lombok</artifactId>')
    let staged
    const invoke = vi.fn(async (_tool, args, options) => {
      if (args[0] === '-version') return { stdout: '', stderr: 'javac 17.0.15' }
      expect(args).toHaveLength(2)
      expect(options.timeout).toBe(60_000)
      expect(options.shell).toBeUndefined()
      const file = args[1].slice(1)
      const content = await fs.readFile(file, 'utf8')
      expect(content).toContain(javacArguments({ output: path.join(path.dirname(file), 'classes'), classpath: [output, processor],
        encoding: 'UTF-8', release: 8, compilerVersion: 17, processor, sources: [sourceFile] }))
      staged = path.dirname(file)
      await fs.writeFile(path.join(staged, 'classes', 'Example$Inner.class'), classHeader)
      return { stdout: '', stderr: '' }
    })
    const compile = createJavac({ env: { JAVA_HOME: path.join(root, 'JDK with spaces') }, signal: new AbortController().signal,
      readClassInfo: () => ({ name: 'Example$Inner', major: 52 }), home, tempRoot: root, run: invoke })
    expect((await compile({ root: { moduleRoot: root, source, output }, sources: [sourceFile], classpath: [output] }))[0].name).toBe('Example$Inner')
    expect(invoke.mock.calls[0][0]).toBe(path.join(root, 'JDK with spaces', 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))
    await expect(fs.stat(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(output, 'Example$Inner.class'))).toEqual(classHeader)
    expect(javacArguments({ output, classpath: [output], encoding: 'UTF-8', release: 8, compilerVersion: 8, sources: [sourceFile] }))
      .toContain('"-source"\n"1.8"\n"-target"\n"1.8"')
  })
})

function fakeWatch() {
  let emit
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
  return { watch: vi.fn((_root, _options, receive) => { emit = receive; return watcher }), watcher,
    changed: (file, type = 'change') => emit(type, file) }
}

describe('hot reload worker', () => {
  it('keeps the JDWP handshake behind the ownership check even while paused', async () => {
    let ownsListener = false
    const vm = { close: vi.fn(), onClose: vi.fn() }
    const connect = vi.fn(async () => vm)
    const verifyListener = vi.fn(async () => ownsListener)
    leases.push(startHotReload({ port: 58140, cwd: root, worktree: root }, { env: {}, pid: 6, paused: true,
      running: () => true, onState: vi.fn(), connect, verifyListener }))
    await vi.waitFor(() => expect(verifyListener).toHaveBeenCalledWith({ pid: 6, port: 58140, signal: expect.any(AbortSignal) }))
    expect(connect).not.toHaveBeenCalled()
    ownsListener = true
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1), { timeout: 1600 })
  })

  it('sends no classpath request when a pause interrupts the capability check', async () => {
    const capabilities = Promise.withResolvers()
    const report = vi.fn()
    const vm = { canRedefine: vi.fn(() => capabilities.promise), classPaths: vi.fn(), close: vi.fn(), onClose: vi.fn() }
    const connect = vi.fn(async () => vm)
    const session = startHotReload({ port: 58140, cwd: root, worktree: root }, { env: {}, pid: 6, paused: true, running: () => true,
      onState: report, connect, verifyListener: async () => true })
    leases.push(session)
    await vi.waitFor(() => expect(connect).toHaveBeenCalled())
    expect(vm.canRedefine).not.toHaveBeenCalled()
    session.resume()
    await vi.waitFor(() => expect(vm.canRedefine).toHaveBeenCalled())
    session.suspend()
    capabilities.resolve(true)
    await capabilities.promise
    expect(vm.classPaths).not.toHaveBeenCalled()
    expect(vm.close).not.toHaveBeenCalled()
  })

  it('keeps the connection through initialization failure and watcher suspension', async () => {
    const events = fakeWatch()
    const report = vi.fn()
    const vm = { canRedefine: async () => false, close: vi.fn(), onClose: vi.fn() }
    const connect = vi.fn(async () => vm)
    const session = startHotReload({ port: 58140, cwd: root, worktree: root }, { env: {}, pid: 6, running: () => true,
      onState: report, watchSource: events.watch, connect, verifyListener: async () => true })
    leases.push(session)
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), undefined))
    expect(events.watch).not.toHaveBeenCalled()
    const { signal } = connect.mock.calls[0][0]
    session.suspend()
    expect(signal.aborted).toBe(false)
    expect(vm.close).not.toHaveBeenCalled()
    session.close()
    expect(signal.aborted).toBe(true)
    expect(vm.close).toHaveBeenCalledTimes(1)
  })

  it('publishes compiled classes for DevTools without a JDWP connection', async () => {
    const events = fakeWatch()
    const report = vi.fn()
    const connect = vi.fn()
    const compile = vi.fn(async () => [{ name: 'Example', bytes: Buffer.from('class') }])
    leases.push(startHotReload({ devtools: true, cwd: root, worktree: root }, { env: {}, pid: 6, running: () => true,
      onState: report, watchSource: events.watch, connect, quiet: 10, makeCompiler: () => compile, readClassInfo: vi.fn(),
      findDevtools: async () => ({ roots: [{ output, source, moduleRoot: root }], classpath: [output] }) }))
    await vi.waitFor(() => expect(events.watch).toHaveBeenCalled())
    events.changed('Example.java')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied', classes: 1, devtools: true }), undefined))
    expect(connect).not.toHaveBeenCalled()
  })

  it('debounces, ignores deleted and unready files, and queues edits made while compiling', async () => {
    const events = fakeWatch()
    const release = Promise.withResolvers()
    const compile = vi.fn().mockImplementationOnce(() => release.promise).mockResolvedValue([])
    const applied = [{ name: 'demo/Example$Inner', bytes: Buffer.from('class') }]
    const vm = { canRedefine: async () => true, classPaths: async () => ({ baseDir: root, classpaths: [output] }),
      redefine: vi.fn(), close: vi.fn(), onClose: vi.fn() }
    const connect = vi.fn(async () => vm)
    const report = vi.fn()
    let running = false
    leases.push(startHotReload({ port: 58140, cwd: root, worktree: root }, { env: {}, pid: 6,
      running: () => running, onState: report, watchSource: events.watch, connect, verifyListener: async () => true, makeCompiler: () => compile,
      readClassInfo: vi.fn(), timeout: 2000, quiet: 25 }))
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'watching' }), undefined))
    expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: '127.0.0.1', port: 58140 }))
    events.changed('Example.java')
    running = true
    events.changed('Example.java')
    events.changed('Example.java')
    events.changed('Deleted.java', 'rename')
    await vi.waitFor(() => expect(compile).toHaveBeenCalledExactlyOnceWith({ root: { output, source, moduleRoot: root }, sources: [sourceFile], classpath: [output] }))
    events.changed('Example.java')
    release.resolve(applied)
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2))
    expect(vm.redefine).toHaveBeenCalledExactlyOnceWith([{ signature: 'Ldemo/Example$Inner;', bytes: applied[0].bytes }], { signal: expect.any(AbortSignal) })
    leases[0].close()
    expect(vm.close).toHaveBeenCalledTimes(1)
    expect(events.watcher.close).toHaveBeenCalledTimes(1)
  })

  it('reconnects before the next edit and reports structure changes, diagnostics, and an uncertain result', async () => {
    const events = fakeWatch()
    let disconnected
    const port = 51814
    const makeVm = () => ({ canRedefine: async () => true, classPaths: async () => ({ baseDir: root, classpaths: [output] }),
      redefine: vi.fn(), close: vi.fn(), onClose: fn => { disconnected = fn } })
    const first = makeVm()
    const second = makeVm()
    second.redefine.mockRejectedValue(Object.assign(new Error('private value'), { name: 'JdwpError', code: 63, reason: '메서드 추가', signature: 'Ldemo/Example;' }))
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const report = vi.fn()
    const classes = [{ name: 'demo/Example', bytes: Buffer.from('class') }]
    const compile = vi.fn().mockResolvedValueOnce(classes)
      .mockRejectedValueOnce(Object.assign(new Error('diagnostic'), { stderr: `bytecode error near ${port}` }))
      .mockResolvedValueOnce(classes)
    leases.push(startHotReload({ port, cwd: root, worktree: root }, { env: {}, pid: 6, running: () => true,
      onState: report, watchSource: events.watch, connect, verifyListener: async () => true, makeCompiler: () => compile, readClassInfo: vi.fn(), quiet: 10 }))
    await vi.waitFor(() => expect(disconnected).toBeTypeOf('function'))
    await vi.waitFor(() => expect(events.watch).toHaveBeenCalled())
    disconnected()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    events.changed('Example.java')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'restartNeeded', reason: '메서드 추가 (demo.Example)' }), undefined))
    expect(connect).toHaveBeenCalledTimes(2)
    events.changed('Example.java')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'compileError' }), ['bytecode error near [바로 반영]']))
    const reason = 'JVM이 시간 안에 응답하지 않아 변경 반영 여부를 확인할 수 없습니다.'
    second.redefine.mockRejectedValueOnce(new Error(reason))
    events.changed('Example.java')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason }), undefined))
    expect(JSON.stringify(report.mock.calls)).not.toContain(String(port))
  })
})
