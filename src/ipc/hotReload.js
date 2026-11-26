const fs = require('node:fs/promises')
const { watch } = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { sameOrInside } = require('../localFiles/roots.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { inspectJavaBuild, javaLayout, devtoolsLayout, createJavac } = require('./hotReloadJava.js')

const START_TIMEOUT = 300_000
const QUIET_MS = 300
const HOT_ARGS = 'EZSHELL_HOT_RELOAD_JVM_ARGS'
const MAVEN_ARGS = 'EZSHELL_HOT_RELOAD_MAVEN_OPTIONS'
const INIT_GRADLE = `import groovy.json.JsonSlurper

gradle.beforeProject { project ->
  project.tasks.withType(org.gradle.api.tasks.JavaExec).all { task ->
    if (task.name == 'bootRun') {
      task.doFirst {
        def args = System.getenv('${HOT_ARGS}')
        if (args) task.jvmArgs(new JsonSlurper().parseText(args))
        task.environment.remove('${HOT_ARGS}')
      }
    }
  }
}
`

const RESULTS = new Set(['applied', 'restartNeeded', 'compileError', 'failed'])
const STRUCTURAL_CHANGES = new Set([63, 64, 66, 67, 70, 71, 72])
const UNCONFIRMED = 'JVM이 시간 안에 응답하지 않아 변경 반영 여부를 확인할 수 없습니다.'
const STATUS_LABEL = { applied: '바로 반영됨', restartNeeded: '재기동 필요', compileError: '컴파일 오류', failed: '바로 반영 실패' }

function reloadLog(state) {
  const clock = new Date(state.at)
  const time = [clock.getHours(), clock.getMinutes(), clock.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
  const detail = state.status === 'applied' ? ` · 클래스 ${state.classes ?? 0}개` : state.reason ? `: ${state.reason}` : ''
  return `${time} ${STATUS_LABEL[state.status]}${detail}`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function shellArgument(value, platform) {
  return `'${value.replaceAll("'", platform === 'win32' ? "''" : "'\\''")}'`
}

const mavenOptions = args => args.map(arg => /[\s"']/u.test(arg) ? `"${arg.replaceAll('"', `"'"'"`)}"` : arg).join(' ')
const jdwpOption = port => `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,quiet=y,address=127.0.0.1:${port}`

async function prepareTomcatReload({ layout, worktree, cwd, mode, args = [], reserve = freePort }) {
  if (layout.reason) return { hotReloadFailure: layout.reason, jvmArgs: [] }
  const port = await reserve()
  return { hotReload: { port, worktree, cwd, mode, layout }, filterOutput: portFilter(port), jvmArgs: [jdwpOption(port), ...args] }
}

async function gradleInitFile(userData) {
  const base = await fs.realpath(userData)
  const directory = path.join(base, 'hot-reload')
  await fs.mkdir(directory, { recursive: true })
  if (await fs.realpath(directory) !== directory) throw new Error('바로 반영의 Gradle 설정 폴더가 바뀌었습니다.')
  const file = path.join(directory, 'init.gradle')
  const stat = await fs.lstat(file).catch(() => null)
  if (stat?.isFile() && stat.size === Buffer.byteLength(INIT_GRADLE) && await fs.readFile(file, 'utf8') === INIT_GRADLE) return file
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, INIT_GRADLE, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, file)
    return file
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

// Remove the private port before PTY output reaches the backlog, renderer, or MCP. A port number
// can span two PTY chunks. Keep just a suffix that could be the start of that number.
function portFilter(port) {
  const digits = String(port)
  let tail = ''
  let previousDigit = false
  return (chunk, final = false) => {
    let text = tail + chunk
    tail = ''
    if (!final) {
      const suffix = /\d+$/.exec(text)
      if (suffix && (suffix.index !== 0 || !previousDigit) && digits.startsWith(suffix[0])) {
        tail = suffix[0]
        text = text.slice(0, suffix.index)
      }
    }
    const continued = previousDigit
    if (text.length) previousDigit = /\d$/.test(text)
    return text.replace(/\d+/g, (number, index) => number === digits && (index !== 0 || !continued) ? '[바로 반영]' : number)
  }
}

async function prepareHotReload(task, { worktree, kind = task.id, mode, args = [], userData, platform = process.platform, reserve = freePort }) {
  const build = await inspectJavaBuild(task.cwd)
  if (build.devtools) return { ...task, hotReload: { devtools: true, worktree, cwd: task.cwd } }
  const port = await reserve()
  const jvmArgs = [jdwpOption(port), ...args]
  const setting = { port, worktree, cwd: task.cwd, mode }
  if (kind.endsWith(':maven')) {
    // Windows batch launchers parse nested quotes twice. Have Maven expand the enhanced
    // options after the batch invocation. The private JDWP argument stays out of the environment.
    const windowsOptions = platform === 'win32' && args.length > 0
    const value = windowsOptions ? `${jvmArgs[0]} \${env.${MAVEN_ARGS}}` : mavenOptions(jvmArgs)
    const property = shellArgument(`-Dspring-boot.run.jvmArguments=${value}`, platform)
    return { ...task, command: `${task.command} ${property}`, ...(windowsOptions && { env: { ...task.env, [MAVEN_ARGS]: mavenOptions(args) } }),
      hotReload: setting, filterOutput: portFilter(port) }
  }
  const init = await gradleInitFile(userData)
  return { ...task, command: `${task.command} -I ${shellArgument(init, platform)}`, env: { ...task.env, [HOT_ARGS]: JSON.stringify(jvmArgs) },
    hotReload: setting, filterOutput: portFilter(port) }
}

function signatureName(signature) {
  const name = typeof signature === 'string' ? signature.replace(/^L(.+);$/, '$1').replaceAll('/', '.') : ''
  return /^[\p{L}_$][\p{L}\p{N}_$.]{0,159}$/u.test(name) ? name : ''
}

function compilerFailure(error) {
  const output = [error.stderr, error.stdout].filter(Boolean).join('\n')
  if (output) return { reason: 'javac 컴파일에 실패했습니다.', diagnostics: output.split(/\r?\n/) }
  const reason = error.code ? 'javac를 실행하지 못했습니다.' : error.message
  return { reason: /^선택한 JDK에서 javac|^javac 버전|^Lombok을 |^컴파일(?:한| 출력)/.test(reason) ? reason : 'javac 컴파일에 실패했습니다.' }
}

function keepVmConnected(port, connect) {
  const lifetime = new AbortController()
  const { signal } = lifetime
  let connection
  let connecting = false

  async function maintain() {
    if (signal.aborted || connecting || connection) return
    connecting = true
    try {
      while (!signal.aborted && !connection) {
        try {
          const start = connect ?? require('../runtimes/jdwp.js').connectJdwp
          const vm = await start({ host: '127.0.0.1', port, signal })
          if (signal.aborted) { vm.close(); return }
          connection = vm
          vm.onClose(() => {
            if (connection !== vm) return
            connection = undefined
            void maintain()
          })
        } catch { /* The port opens only when the build starts its JVM. */ }
        if (!connection) await delay(250, undefined, { signal, ref: false })
      }
    } catch { /* Shutdown aborts the connection retry timer. */ }
    finally { connecting = false }
  }

  void maintain()
  return {
    current: () => connection,
    close() { lifetime.abort(); connection?.close(); connection = undefined }
  }
}

function startHotReload(config, options) {
  const debug = config.devtools ? null : keepVmConnected(config.port, options.connect)
  let monitor
  let closed = false
  function resume() {
    if (!closed && !monitor) monitor = watchJavaChanges(config, { ...options, debug })
  }
  function suspend() { monitor?.close(); monitor = undefined }
  function close() { closed = true; suspend(); debug?.close() }
  if (!options.paused) resume()
  return { close, suspend, resume }
}

function watchJavaChanges(config, { pid, env, running, onState, watchSource = watch, findDevtools = devtoolsLayout,
  debug, readClassInfo, makeCompiler = createJavac, timeout = START_TIMEOUT, quiet = QUIET_MS, now = Date.now }) {
  const lifetime = new AbortController()
  const { signal } = lifetime
  const watchers = []
  const pending = new Map()
  let timer
  let lastChange = 0
  let processing = false
  let classpath = []
  let compile

  function report(next, diagnostics) {
    if (signal.aborted) return
    const privatePort = config.port ? new RegExp(`(?<!\\d)${config.port}(?!\\d)`, 'g') : null
    const clean = value => privatePort ? value.replace(privatePort, '[바로 반영]') : value
    onState({ ...next, ...(next.reason && { reason: clean(next.reason) }), ...(config.devtools && { devtools: true }), at: now() }, diagnostics?.map(clean))
  }

  async function work() {
    timer = undefined
    if (signal.aborted || processing || !pending.size || !running()) return
    processing = true
    const batch = [...pending]
    pending.clear()
    let stage = 'compile'
    try {
      const sources = []
      for (const [root, files] of batch) {
        const entries = await Promise.all([...files].map(file => resolveLocalPreviewPath(file).catch(() => null)))
        const changed = entries.filter(entry => entry?.stat.isFile() && sameOrInside(root.source, entry.path) && /\.java$/i.test(entry.path) &&
          !root.excluded?.some(folder => sameOrInside(folder, entry.path))).map(entry => entry.path)
        if (changed.length) sources.push({ root, changed })
      }
      if (!sources.length || signal.aborted || !running()) return
      report({ status: 'compiling' })
      const classes = []
      for (const { root, changed } of sources) classes.push(...await compile({ root, sources: changed, classpath }))
      signal.throwIfAborted()
      stage = 'apply'
      if (!config.devtools && classes.length) {
        const vm = debug.current()
        if (!vm) throw new Error('실행 중인 JVM과 다시 연결하는 중입니다.')
        await vm.redefine(classes.map(({ name, bytes }) => ({ signature: `L${name};`, bytes })), { signal })
      }
      report({ status: 'applied', classes: classes.length })
    } catch (error) {
      if (signal.aborted) return
      if (stage === 'compile') {
        const { reason, diagnostics } = compilerFailure(error)
        report({ status: 'compileError', reason }, diagnostics ?? [])
      } else if (error.name === 'JdwpError' && STRUCTURAL_CHANGES.has(error.code)) {
        const className = signatureName(error.signature)
        const why = typeof error.reason === 'string' && /^[\p{L}\p{N} ().·_-]{1,100}$/u.test(error.reason) ? error.reason : '클래스 구조 변경'
        report({ status: 'restartNeeded', reason: className ? `${why} (${className})` : why })
      } else report({ status: 'failed', reason: error.message === UNCONFIRMED ? UNCONFIRMED : '실행 중인 JVM에 변경을 적용하지 못했습니다.' })
    } finally {
      processing = false
      schedule()
    }
  }

  function schedule() {
    if (signal.aborted || processing || !pending.size) return
    clearTimeout(timer)
    timer = setTimeout(() => { void work() }, Math.max(0, quiet - (now() - lastChange)))
    timer.unref?.()
  }

  function changed(root, filename) {
    if (signal.aborted || !running() || typeof filename !== 'string' || !/\.java$/i.test(filename)) return
    const file = path.resolve(root.source, filename)
    if (!sameOrInside(root.source, file)) return
    if (!pending.has(root)) pending.set(root, new Set())
    pending.get(root).add(file)
    lastChange = now()
    schedule()
  }

  function close() {
    lifetime.abort()
    clearTimeout(timer)
    pending.clear()
    for (const watcher of watchers.splice(0)) watcher.close()
  }

  async function initialize() {
    const deadline = now() + timeout
    let warned = false
    while (!signal.aborted) {
      let layout
      try {
        if (config.devtools) layout = await findDevtools({ pid, cwd: config.cwd, env, worktree: config.worktree, signal })
        else if (debug.current()) {
          const vm = debug.current()
          signal.throwIfAborted()
          if (!await vm.canRedefine()) {
            report({ status: 'failed', reason: '이 JVM에서 클래스를 다시 불러올 수 없습니다.' })
            close()
            return
          }
          signal.throwIfAborted()
          layout = config.layout ?? await javaLayout(await vm.classPaths(), config.worktree)
        }
      } catch { /* The build or JVM may still be starting. */ }
      if (signal.aborted) return
      if (layout?.roots.length) {
        classpath = layout.classpath
        compile = makeCompiler({ env, signal, readClassInfo: readClassInfo ?? require('../runtimes/classFile.js').readClassInfo })
        for (const root of layout.roots) {
          const watcher = watchSource(root.source, { recursive: true, persistent: false }, (_event, filename) => changed(root, filename))
          watcher.on('error', () => {
            report({ status: 'failed', reason: 'Java 소스 폴더를 감시하지 못했습니다.' })
            close()
          })
          watchers.push(watcher)
        }
        report({ status: 'watching' })
        return
      }
      if (!warned && now() >= deadline) {
        warned = true
        report({ status: 'failed', reason: config.devtools ? 'DevTools의 클래스패스를 확인하지 못했습니다.' : '실행 중인 JVM의 클래스패스를 확인하지 못했습니다.' })
      }
      await delay(config.devtools ? 850 : 250, undefined, { signal, ref: false })
    }
  }

  void initialize().catch(() => {
    if (signal.aborted) return
    report({ status: 'failed', reason: 'Java 소스 폴더를 감시하지 못했습니다.' })
    close()
  })
  return { close }
}

module.exports = { prepareHotReload, prepareTomcatReload, startHotReload, portFilter, reloadLog, RESULTS, HOT_ARGS, MAVEN_ARGS, INIT_GRADLE }
