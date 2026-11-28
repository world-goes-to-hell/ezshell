const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { inspectLocalProject } = require('./localProjects.js')
const { inspectDevelopmentTasks, prepareDevelopmentTask } = require('./localDevelopmentTasks.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { createDevelopmentErrors, MAX_LOG_LINES } = require('./developmentErrors.js')
const { describeRunFailure } = require('./runDiagnosis.js')
const { redactRunSecrets, redactRunOutput } = require('./runSecrets.js')
const { usesMaven, mavenFields, diagnosisContext, presetSuggestions, suggestedMavenFields, wrapperMavenVersion } = require('./runSuggestions.js')
const { prepareMavenRun } = require('./runMaven.js')
const { removeMavenSettings } = require('../runtimes/mavenSettings.js')
const { inspectMavenPin, exportMavenPin, mavenExportDestination, deleteMavenPin, cleanMavenPinRuns } = require('../runtimes/mavenPin.js')
const { selectMavenJdk } = require('../runtimes/mavenJdk.js')
const { allowedJar } = require('../runtimes/jarSearch.js')
const { tomcatInvocation, findJarCandidates, jarSuggestion, mcpJarSuggestion, selectedJarReferences, STALE_JAR } = require('./runJarSuggestions.js')
const { MAX_PROPOSALS, STALE_PROPOSAL, prepareProposal, proposalStillCurrent, approvedProposalStatus, pendingProposals, agentProposals } = require('./runProposals.js')
const { prepareHotReload, prepareTomcatReload, javaRunWithOptions, startHotReload, reloadLog, RESULTS: RELOAD_RESULTS } = require('./hotReload.js')
const { planTomcat, stageTomcat, webDirectory, antTargets, webappCandidates, validContextPath, vmOptionTokens, workspaceVmArguments, tomcatJars } = require('./tomcatRun.js')
const { createWorkspaceAccess, workspaceServers } = require('./workspaceServers.js')
const { javaVersionProbe, javaLogOptions } = require('./developmentEncoding.js')
const { loadEclipseProject } = require('./eclipseProject.js')
const { buildEclipse } = require('./eclipseBuild.js')
const { createRunPresetStore, validatePreset, presetName, presetRelative, publicPreset, presetApproval, projectKey, realDirectory, directoryInProject, isSpringBootTask } = require('./runPresetStore.js')
const { createRunBundleStore } = require('./runBundleStore.js')
const { validateStartOrder, selectStartStages, stopStages, runStartStages, legacyStartOrder } = require('./runStartOrder.js')

const USER = 'user'
const USER_STOP_MS = 30_000
const STOP_ALL_TRANSITION_MS = 10_000
const MAX_ACTIONS = 20
const MAX_RELOAD_RESULTS = 10
const MAX_SEND_NOTE = 4000
const MAX_SEND_BODY = 8000 - MAX_SEND_NOTE - '\n\n'.length
const MAX_SEND_PREVIEWS = 20
const MISSING_PREVIEW = '보낼 내용의 미리보기를 다시 열어 주세요.'
const ACTIVE = new Set(['preparing', 'starting', 'running'])
const NOT_ALLOWED = '잠금 해제 후 본창에서 이용할 수 있습니다.'
const MISSING = '실행 구성을 찾을 수 없습니다.'
const MOVED = '실행 구성이 바뀌었습니다. 다시 선택해 주세요.'
const idle = () => ({ status: 'idle', errors: 0 })
const optionsForTask = { includeSource: false, rootOnly: true, allowPendingInstall: true }
const failure = error => ({ ok: false, error: error?.code || typeof error?.message !== 'string'
  ? '실행 구성을 처리하지 못했습니다.' : redactRunSecrets(error.message) })
const noApproval = () => false
const runKey = (project, id) => `${project.worktreeKey}\0${id}`
const WINDOWS_RUN_FOLDER = 'run_*는 셸을 연 폴더 기준입니다. 다른 워크트리는 해당 폴더에서 새 로컬 셸을 열어 주세요.'
const runFolderHint = cwd => `이 셸은 ${path.basename(cwd) || path.parse(cwd).root}에서 열렸습니다. ${WINDOWS_RUN_FOLDER}`

// Same rule as the window's hasFinalConsonant (lib/runPresets.ts): a Hangul syllable by its own final
// consonant, a digit as it is read (영·일·삼·육·칠·팔 have one), anything else shows both particles
function withSubject(name) {
  const last = name.trim().slice(-1)
  const code = last.charCodeAt(0) - 0xac00
  const final = code >= 0 && code <= 11171 ? code % 28 !== 0 : /[0-9]/.test(last) ? '013678'.includes(last) : null
  return name + (final === null ? '이(가)' : final ? '이' : '가')
}

function portOf(address) {
  if (!address) return null
  const url = new URL(address)
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
}

function recentErrorGroups(logs, limit = MAX_LOG_LINES) {
  const groups = logs.groups()
  let count = 0
  let i = groups.length
  while (i > 0 && count + groups[i - 1].lines.length <= limit) count += groups[--i].lines.length
  return groups.slice(i)
}

class RunConfirmation extends Error {
  constructor(type, id, command, cwd, binding) {
    super('실행 카드에서 확인한 뒤 실행해 주세요.')
    this.type = type
    this.command = command
    this.key = JSON.stringify([id, command, cwd, binding])
  }
}

async function resolveProject(folder) {
  const cwd = await realDirectory(folder)
  if (cwd.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('프로젝트 폴더를 선택해 주세요.')
  const { repo } = await inspectLocalProject(cwd)
  const checkout = repo?.worktrees.some(tree => projectKey(tree.path) === projectKey(repo.root)) && await realDirectory(repo.root)
  const gitWorktree = Boolean(checkout && sameOrInside(checkout, cwd))
  const worktree = gitWorktree ? checkout : cwd
  const root = gitWorktree ? await realDirectory(repo.worktrees[0].path) : worktree
  return { root, key: projectKey(root), worktree, worktreeKey: projectKey(worktree), cwd, gitWorktree }
}

function createRunPresets({ store, file, getShells, getAgent, isLocked, javaHomeOf = () => null, listJdks = () => [],
  toolHomeOf = () => null, toolHomeFor = () => null, toolVersionOf = () => null,
  enhancedJvmArgs = () => null, userData = file && path.dirname(file), prepareReload = prepareHotReload, startReload = startHotReload,
  sendState = () => {}, notifyCrash = () => {}, sendAsUser, now = Date.now, projectOf = resolveProject,
  prepareTask = prepareDevelopmentTask, jarHome, bundleStore }) {
  store ??= createRunPresetStore(file)
  // Run bundles (part 3) are kept apart from the presets: saving a preset or the start order never drops them
  bundleStore ??= createRunBundleStore(userData && path.join(userData, 'run-bundles.json'))
  const workspaceAccess = createWorkspaceAccess(userData && path.join(userData, 'run-workspace-folders.json'))
  const javaVersion = javaVersionProbe()
  const mavenOptions = { userData, listJdks, javaHomeOf, javaVersion }
  const runs = new Map()
  const byShell = new Map()
  const batches = new Map()
  const stoppingAll = new Map()
  let reloadSequence = 0
  const getRun = (project, id) => runs.get(runKey(project, id))
  const orderOf = project => store.startOrder?.(project.key) ?? legacyStartOrder(store.list(project.key))
  const failedRun = run => run?.state.status === 'crashed' ||
    (!run?.intentionalExit && Number.isInteger(run?.state.exitCode) && run.state.exitCode !== 0)

  function find(project, id) {
    const preset = store.list(project.key).find(item => item.id === id)
    if (!preset) throw new Error(MISSING)
    return preset
  }

  function runFor(project, id) {
    let run = getRun(project, id)
    if (!run) {
      run = { id, project, state: idle(), actions: [], reloadResults: [], waiters: new Set(), logs: createDevelopmentErrors(now) }
      runs.set(runKey(project, id), run)
    }
    return run
  }

  function update(run, patch, firstAgentAction = false) {
    if (Object.entries(patch).every(([key, value]) => run.state[key] === value)) return
    run.state = { ...run.state, ...patch }
    for (const settle of run.waiters) settle()
    if (!isLocked()) sendState({ projectKey: run.project.key, worktreeKey: run.project.worktreeKey,
      id: run.id, state: run.state, ...(firstAgentAction && { firstAgentAction: true }) })
  }

  function publishProposals(run, proposals) {
    run.proposals = proposals
    update(run, { proposals: pendingProposals(proposals) })
  }

  function changeProposalStatuses(run, statusOf) {
    if (!run?.proposals?.some(item => item.status === 'pending')) return
    const updated = run.proposals.map(item => {
      const status = item.status === 'pending' ? statusOf(item) : item.status
      return status === item.status ? item : { ...item, status }
    })
    if (updated.some((item, index) => item !== run.proposals[index])) publishProposals(run, updated)
  }

  function expireProposals(run, preset, suggestions) {
    if (run?.proposals?.some(item => item.status === 'pending')) {
      const current = suggestions ?? presetSuggestions(preset, run)
      changeProposalStatuses(run, item => proposalStillCurrent(item, preset, run, current) ? 'pending' : 'dismissed')
    }
  }

  function record(run, by, action) {
    const lastAction = { by, action, at: now() }
    if (by === USER && action === 'stop') run.userStoppedAt = lastAction.at
    run.actions.push(lastAction)
    if (run.actions.length > MAX_ACTIONS) run.actions.shift()
    let firstAgentAction = false
    if (by !== USER && action !== 'stop' && !isLocked()) {
      try { firstAgentAction = store.markAgentAction(run.project.root, run.id) }
      catch { console.warn('[run presets] 첫 에이전트 조작을 저장하지 못했습니다.') }
    }
    update(run, { lastAction }, firstAgentAction)
  }

  function updateLogs(run) {
    const { address, readyAt, errors } = run.logs.state()
    update(run, { address: readyAt === undefined ? undefined : run.expectedUrl ?? address, readyAt, errors,
      ...(readyAt !== undefined && run.state.status === 'starting' ? { status: 'running' } : {}) })
  }

  function suspendReload(run) {
    run.reloadWorker?.suspend()
  }

  function recordReload(run, reload, diagnostics) {
    if (reload.status === 'compileError') run.logs.addError(`ERROR ${reload.reason}`, diagnostics)
    if (RELOAD_RESULTS.has(reload.status)) {
      run.reloadResults.unshift({ sequence: ++reloadSequence, reload })
      if (run.reloadResults.length > MAX_RELOAD_RESULTS) run.reloadResults.pop()
    }
    update(run, { reload: redactRunOutput(reload), errors: run.logs.state().errors })
  }

  function openReload(run) {
    if (!run.reloadLaunch || !ACTIVE.has(run.state.status)) return
    const paused = isLocked()
    if (run.reloadWorker) { if (!paused) run.reloadWorker.resume(); return }
    const { config, pid, env } = run.reloadLaunch
    run.reloadWorker = startReload(config, { pid, env, paused, running: () => run.state.status === 'running' && !isLocked(),
      onState: (reload, diagnostics) => recordReload(run, reload, diagnostics) })
  }

  function closeReload(run) {
    run.reloadWorker?.close()
    run.reloadWorker = undefined
    run.reloadLaunch = undefined
  }

  function onEvent(run, event, task, preset) {
    const { type, shellId } = event
    if (type === 'start') {
      closeReload(run)
      run.expectedUrl = undefined
      byShell.set(shellId, run)
      run.orderLogMatched = false
      run.intentionalExit = false
      run.logs = createDevelopmentErrors(now, { tomcat: task.tomcat === true, onOutputLine: line => {
        if (run.orderLog && line.includes(run.orderLog)) run.orderLogMatched = true
      } })
      run.jarDiagnosis?.search?.controller.abort(new Error(STALE_JAR))
      run.diagnosis = diagnosisContext(preset, task.mavenFeature)
      run.jarDiagnosis = { invocation: tomcatInvocation(preset), major: task.tomcatMajor }
      run.jarOffered = undefined
      run.proposals = []
      update(run, { status: event.phase === 'prepare' ? 'preparing' : 'starting', startedAt: now(), shellId,
        exitCode: null, failedAt: undefined, failureReason: undefined, address: undefined, readyAt: undefined, reload: undefined, proposals: undefined, errors: 0 })
      return
    }
    if (run.state.shellId !== shellId) return
    if (type === 'prepared' && run.state.status === 'preparing') {
      run.logs.finish(false)
      update(run, { status: 'starting', errors: run.logs.state().errors })
    } else if (type === 'launched' && ACTIVE.has(run.state.status)) {
      run.expectedUrl = task.expectedUrl
      for (const driver of task.missingJdbcDrivers ?? []) {
        run.logs.addError('ERROR Tomcat JNDI JDBC 드라이버를 찾을 수 없습니다.', [`java.lang.ClassNotFoundException: ${driver}`])
      }
      if (task.missingJdbcDrivers?.length) updateLogs(run)
      if (task.hotReload) {
        const env = task.projectJavaHome ? { ...event.env, JAVA_HOME: task.projectJavaHome } : event.env
        run.reloadLaunch = { config: task.hotReload, pid: event.pid, env }
        openReload(run)
      } else if (task.hotReloadFailure) recordReload(run, { status: 'failed', reason: task.hotReloadFailure, at: now() })
    } else if (type === 'data' && ACTIVE.has(run.state.status)) {
      run.logs.feed(event.data, event.phase !== 'prepare' && event.phase !== 'launch')
      updateLogs(run)
    } else if (type === 'interrupt') {
      record(run, USER, 'stop')
    } else if (type === 'closed') {
      closeReload(run)
      byShell.delete(shellId)
      if (event.wasRunning && !run.deleting) record(run, USER, 'stop')
      update(run, { shellId: undefined, ...(ACTIVE.has(run.state.status) && { status: 'stopped' }) })
    } else if (type === 'exit' && ACTIVE.has(run.state.status)) {
      closeReload(run)
      run.logs.finish(event.phase !== 'prepare' && event.phase !== 'launch')
      run.intentionalExit = Boolean(event.action)
      const crashed = !event.action && (event.failed || (typeof event.exitCode === 'number' && event.exitCode !== 0))
      const buildFailed = crashed && event.phase === 'prepare'
      const failureReason = crashed
        ? describeRunFailure({ lines: run.logs.lines(), exitCode: event.exitCode, maven: Boolean(run.diagnosis?.invocation) })
        : undefined
      if (buildFailed) run.logs.addError('ERROR 빌드 실패', run.logs.groups().at(-1)?.lines)
      const logState = run.logs.state()
      update(run, { ...logState, address: logState.readyAt !== undefined ? run.expectedUrl ?? logState.address : undefined,
        status: crashed ? 'crashed' : 'stopped', exitCode: event.exitCode, failureReason, ...(buildFailed && { failedAt: 'prepare' }) })
      const preset = store.list(run.project.key).find(item => item.id === run.id)
      if (preset) expireProposals(run, preset)
      if (crashed && preset?.notify && !isLocked()) notifyCrash(path.basename(run.project.root) || '로컬 프로젝트', preset.name)
    }
  }

  function ensureAllowed(allowed) {
    if (isLocked() || !allowed()) throw new Error(NOT_ALLOWED)
  }

  async function freshTask(project, preset, by, approve, allowed) {
    const cwd = await directoryInProject(project.worktree, preset.relative)
    const defined = preset.kind === 'task'
      ? await prepareTask(cwd, preset.taskId, { ...optionsForTask, allowed: () => !isLocked() && allowed() })
      : preset.kind === 'tomcat' ? { cwd, tomcat: true, tomcatPlan: await planTomcat(preset, cwd, { toolHomeOf, toolHomeFor, toolVersionOf }) }
        : { cwd, command: preset.command, custom: true }
    if (defined.cwd !== cwd) throw new Error(MOVED)
    const javaHome = preset.jdk === 'system' ? undefined : await javaHomeOf(preset.jdk)
    if (preset.jdk !== 'system' && (!javaHome || !path.isAbsolute(javaHome))) throw new Error('선택한 JDK를 찾을 수 없습니다.')
    const enhancedArgs = preset.hotReload === 'enhanced' ? await enhancedJvmArgs(preset.jdk) : undefined
    if (preset.hotReload === 'enhanced' && !Array.isArray(enhancedArgs)) throw new Error('확장 바로 반영에는 JetBrains Runtime과 HotswapAgent가 필요합니다.')
    if (await directoryInProject(project.worktree, preset.relative) !== cwd || find(project, preset.id) !== preset) throw new Error(MOVED)
    ensureAllowed(allowed)
    if (defined.installCommand) {
      if (by !== USER) throw new Error('의존성 설치가 필요합니다. 사용자가 카드에서 한 번 실행해 주세요.')
      const question = new RunConfirmation('needsInstall', preset.id, defined.installCommand, cwd)
      if (!approve(question)) throw question
    }
    const env = isSpringBootTask(preset) && preset.port !== undefined
      ? { ...preset.env, SERVER_PORT: String(preset.port) }
      : preset.env
    return { ...defined, id: `preset:${preset.id}`, relative: preset.relative, name: preset.name, label: preset.name,
      javaHome, env, enhancedArgs, logEncoding: preset.logEncoding }
  }

  function guardAgent(preset, run, action) {
    if (!preset.agentControl) throw new Error('이 실행 구성은 에이전트 조작이 꺼져 있습니다.')
    if ((action === 'start' || action === 'restart') && run?.userStoppedAt !== undefined && now() - run.userStoppedAt < USER_STOP_MS) {
      throw new Error('사용자가 방금 중지했습니다.')
    }
  }

  function confirmCommand(project, preset, by, approve) {
    const confirmation = presetApproval(preset)
    if (!confirmation || preset.confirmedHash === confirmation.hash) return preset
    if (by !== USER) throw new Error('먼저 사용자가 화면에서 이 실행 설정을 한 번 확인해야 합니다.')
    const question = new RunConfirmation('needsConfirm', preset.id, confirmation.command, confirmation.hash)
    if (!approve(question)) throw question
    const confirmed = { ...preset, confirmedHash: confirmation.hash }
    store.write(project.root, store.list(project.key).map(item => item.id === preset.id ? confirmed : item))
    return confirmed
  }

  async function buildTomcatTask(task, project, preset, withEvents) {
    const { tomcatPlan, ...base } = task
    base.tomcatMajor = tomcatPlan.major
    const extraLibraries = async () => {
      if (preset.extraLibs?.length && !(tomcatPlan.major >= 7)) throw new Error('JAR 연결에는 버전을 확인할 수 있는 Tomcat 7 이상이 필요합니다.')
      return Promise.all((preset.extraLibs ?? []).map(async reference => {
        const jar = await allowedJar({ projectRoot: project.worktree, home: jarHome, reference })
        if (!jar || jar.reference !== reference) throw new Error('연결한 JAR를 찾을 수 없습니다. 실행 구성이나 JAR 경로를 확인해 주세요.')
        return jar
      }))
    }
    const check = async signal => {
      signal?.throwIfAborted()
      if (await directoryInProject(project.worktree, preset.relative) !== base.cwd || find(project, preset.id) !== preset) throw new Error(MOVED)
      ensureAllowed(() => !signal?.aborted)
    }
    const finish = async (signal, eclipseBuild) => {
      await check(signal)
      const contextEntries = preset.contextXml ? await workspaceAccess.contextEntries(project, preset.contextXml) : undefined
      const javaFeature = tomcatPlan.effectiveEncoding === 'auto' ? undefined : await javaVersion(base.javaHome, base.env, base.cwd)
      await check(signal)
      const runtime = await stageTomcat(tomcatPlan, { preset, task: base, worktree: project.worktree, userData,
        prepareReload: prepareTomcatReload, eclipseBuild, contextEntries, javaFeature, extraLibraries: await extraLibraries(), signal })
      try { await check(signal); return runtime }
      catch (error) { await runtime.cleanup(); throw error }
    }
    if (preset.prepare?.tool === 'eclipse') {
      const run = async ({ signal, log, env }) => {
        await check(signal)
        if (!(tomcatPlan.major >= 7)) throw new Error('이클립스식 빌드를 실행하려면 버전을 확인할 수 있는 Tomcat 7 이상이 필요합니다.')
        const webapp = await webDirectory(project.worktree, preset.webapp)
        const eclipse = await loadEclipseProject(project.worktree, base.cwd)
        const webLibs = await tomcatJars(webapp, path.join('WEB-INF', 'lib'))
        const approved = (await extraLibraries()).map(jar => jar.path)
        const libs = [...new Set([...eclipse.libs, ...webLibs, ...approved, ...await tomcatJars(tomcatPlan.home, 'lib')])]
        const extraJars = eclipse.libs.filter(jar => !webLibs.includes(jar))
        const built = await buildEclipse({ eclipse, libs, webLibs, externalJars: tomcatPlan.major >= 8 ? extraJars : [], userData, id: preset.id, worktreeKey: project.worktreeKey,
          worktree: project.worktree, cwd: base.cwd, env, signal, log })
        return { ...built, major: tomcatPlan.major, extraJars }
      }
      return { ...base, preparation: { run, finish: async (signal, built) => withEvents(await finish(signal, built)) } }
    }
    if (!tomcatPlan.prepareCommand) return finish()
    const build = usesMaven(preset) ? await prepareMavenRun({ ...base, command: tomcatPlan.prepareCommand }, preset,
      { ...mavenOptions, mavenVersion: tomcatPlan.mavenVersion, platform: tomcatPlan.platform }) : { command: tomcatPlan.prepareCommand }
    return { ...base, mavenFeature: build.mavenFeature, cleanup: build.cleanup,
      preparation: { command: build.command, launch: { ...(build.javaHome && { javaHome: build.javaHome }), clearJavaCommand: build.clearJavaCommand },
        finish: async signal => {
          await build.cleanup?.(0, signal)
          return withEvents(await finish(signal))
        } } }
  }

  async function act(project, id, action, { by = USER, allowed, approve = noApproval, verifyActor } = {}) {
    ensureAllowed(allowed)
    if (action !== 'stop' && stoppingAll.has(project.worktreeKey)) throw new Error('이 워크트리의 실행을 중지하는 중입니다.')
    let preset = find(project, id)
    const run = runFor(project, id)
    if (by !== USER) guardAgent(preset, run, action)
    if (run.busy) throw new Error('이 실행 구성을 전환하는 중입니다.')
    if (action === 'start' && ACTIVE.has(run.state.status)) return { ok: true }
    if (action === 'stop' && !ACTIVE.has(run.state.status)) return { ok: true }
    if (action !== 'stop') preset = confirmCommand(project, preset, by, approve)
    let finishTransition
    run.busy = new Promise(resolve => { finishTransition = resolve })
    const canAct = () => {
      if (!allowed() || isLocked() || store.list(project.key).find(item => item.id === id) !== preset) return false
      if (by !== USER) guardAgent(preset, run, action)
      return true
    }
    const makeTask = async () => {
      const withEvents = task => ({ ...task, onEvent: event => onEvent(run, event, task, preset) })
      let task = await freshTask(project, preset, by, approve, canAct)
      try {
        if (preset.kind === 'tomcat') task = await buildTomcatTask(task, project, preset, withEvents)
        else {
          if (usesMaven(preset)) task = await prepareMavenRun(task, preset, { ...mavenOptions, mavenVersion: wrapperMavenVersion(task) })
          const javaTask = isSpringBootTask(preset)
          const logOptions = javaTask && preset.logEncoding !== 'auto' ? javaLogOptions(preset.logEncoding, await javaVersion(task.javaHome, task.env, task.cwd)) : []
          const jvmOptions = javaTask ? [...vmOptionTokens(preset.vmArgs ?? ''), ...logOptions] : []
          if (preset.hotReload && preset.hotReload !== 'off') {
            const { enhancedArgs, ...base } = task
            task = await prepareReload(base, { worktree: project.worktree, kind: preset.taskId, mode: preset.hotReload, args: enhancedArgs, jvmOptions, userData })
          } else if (jvmOptions.length) task = await javaRunWithOptions(task, { kind: preset.taskId, args: jvmOptions, userData })
        }
        if (verifyActor) await verifyActor()
        ensureAllowed(canAct)
        return withEvents(task)
      } catch (error) { await task.cleanup?.(); throw error }
    }
    try {
      if (action === 'stop') {
        if (verifyActor) await verifyActor()
        ensureAllowed(canAct)
        suspendReload(run)
        await getShells().changeDevelopmentTask(run.state.shellId, `preset:${id}`, 'stop', canAct)
        closeReload(run)
        update(run, { status: 'stopped' })
      } else if (run.state.shellId) {
        await freshTask(project, preset, by, approve, canAct)
        if (verifyActor) await verifyActor()
        ensureAllowed(canAct)
        suspendReload(run)
        await getShells().changeDevelopmentTask(run.state.shellId, `preset:${id}`, 'restart', canAct, makeTask)
      } else {
        const task = await makeTask()
        await getShells().openDevelopmentTask(task, { cols: 80, rows: 24 }, canAct)
      }
      record(run, by, action)
      return { ok: true }
    } catch (error) {
      openReload(run)
      throw error
    } finally {
      run.busy = null
      finishTransition()
    }
  }

  function wait(run, milliseconds, signal, until = 'ready', after = reloadSequence) {
    // Signals are tied to the request socket or the lifetime of the current batch.
    return new Promise(resolve => {
      let timer
      function finish(result, reload) {
        signal?.removeEventListener('abort', abort)
        run.waiters.delete(check)
        clearTimeout(timer)
        resolve({ result, status: run.state.status, ...(reload && { reload }) })
      }
      const abort = () => finish('cancelled')
      const check = () => {
        const next = until === 'reload' ? run.reloadResults.findLast(entry => entry.sequence > after) : null
        if (isLocked()) finish('cancelled')
        else if (next) finish(next.reload.status, next.reload)
        else if (until === 'ready' && run.state.status === 'running') finish('ready')
        else if (!ACTIVE.has(run.state.status)) finish(run.state.status)
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish('timeout'), milliseconds)
      timer.unref?.()
      run.waiters.add(check)
      check()
    })
  }

  async function agentProject(agent) {
    if (!agent?.active || agent.sleeping || !agent.shellId) throw new Error('프로젝트의 로컬 셸에 묶인 에이전트만 이용할 수 있습니다.')
    const cwd = await getShells().runAuthorityDirectory(agent.shellId)
    if (!cwd || getShells().chatAgentId(agent.shellId) !== agent.id) {
      throw new Error('에이전트의 로컬 작업 폴더를 확인하지 못했습니다.' + (process.platform === 'win32' ? ` ${WINDOWS_RUN_FOLDER}` : ''))
    }
    let project
    try { project = await projectOf(cwd) } catch (error) {
      if (process.platform === 'win32') throw new Error(runFolderHint(cwd))
      throw error
    }
    if (getShells().chatAgentId(agent.shellId) !== agent.id) throw new Error('에이전트의 로컬 작업 폴더를 확인하지 못했습니다.')
    if (project.gitWorktree || store.list(project.key).length) return project
    // A non-Git project can be the containing folder of a shell opened in one of its modules.
    const root = store.roots().filter(candidate => sameOrInside(candidate, project.cwd)).sort((a, b) => b.length - a.length)[0]
    if (!root) return project
    const key = projectKey(root)
    return { ...project, root, key, worktree: root, worktreeKey: key }
  }

  async function agentTool(by, request, allowed, signal) {
    const afterReload = reloadSequence
    ensureAllowed(allowed)
    const project = await agentProject(getAgent(by))
    ensureAllowed(allowed)
    if (request.method === 'run-list') {
      const presets = store.list(project.key).map(preset => {
        const state = getRun(project, preset.id)?.state ?? idle()
        return { name: preset.name, status: state.status, port: portOf(state.address),
          errors: state.errors, agentControl: preset.agentControl, ...(state.failedAt && { failedAt: state.failedAt }), ...(state.reload && { reload: state.reload }) }
      })
      const batch = batches.get(project.worktreeKey)?.state
      const bundles = bundleStore.list(project.key, store.list(project.key).map(preset => preset.id))
      return { presets, ...(bundles.length && { bundles: bundles.map(bundle => bundle.name) }), ...(batch && { startup: { status: batch.status, step: batch.index + 1, total: batch.total, reason: batch.reason } }),
        ...(process.platform === 'win32' && !presets.length && { message: runFolderHint(project.cwd) }) }
    }
    if (request.method === 'run-start-all' || request.method === 'run-stop-all') {
      const verifyActor = async () => {
        ensureAllowed(allowed)
        const current = await agentProject(getAgent(by))
        if (current.key !== project.key || current.worktreeKey !== project.worktreeKey) throw new Error(MOVED)
        ensureAllowed(allowed)
      }
      // A bundle by name: only its presets, in the project's start order
      const scope = request.bundle === undefined ? {} : { selected: bundleSelection(project, { name: request.bundle }) }
      return request.method === 'run-start-all'
        ? startAll(project, allowed, noApproval, { by, verifyActor, signal, detached: true, ...scope })
        : stopAll(project, () => allowed() && !signal?.aborted, { by, verifyActor, ...scope })
    }
    const preset = store.list(project.key).find(item => item.name === presetName(request.name))
    if (!preset) throw new Error(process.platform === 'win32' ? `${MISSING} ${runFolderHint(project.cwd)}` : MISSING)
    const operation = request.method.slice(4)
    const verifyActor = async () => {
      ensureAllowed(allowed)
      const current = await agentProject(getAgent(by))
      if (current.key !== project.key || current.worktreeKey !== project.worktreeKey || find(project, preset.id) !== preset) throw new Error(MOVED)
      ensureAllowed(allowed)
    }
    const run = runFor(project, preset.id)
    if (operation === 'propose') {
      if (typeof request.suggestion !== 'string' || !/^[a-f0-9]{64}$/.test(request.suggestion) || run.busy) throw new Error(STALE_PROPOSAL)
      const generation = run.diagnosis
      const current = presetSuggestions(preset, run).find(item => item.id === request.suggestion)
      if (!current) throw new Error(STALE_PROPOSAL)
      const candidates = current.kind === 'missingClass' ? await jarCandidates(project, preset, run) : new Map()
      const proposal = await prepareProposal({ by, request, preset, run, candidates, suggestions: presetSuggestions(preset, run),
        projectRoot: project.worktree, home: jarHome, now })
      await verifyActor()
      signal?.throwIfAborted()
      const suggestions = presetSuggestions(preset, run)
      if (getRun(project, preset.id) !== run || run.diagnosis !== generation || run.busy
        || !proposalStillCurrent(proposal, preset, run, suggestions)) throw new Error(STALE_PROPOSAL)
      expireProposals(run, preset, suggestions)
      publishProposals(run, [proposal, ...(run.proposals ?? [])].slice(0, MAX_PROPOSALS))
      return { id: proposal.id, status: proposal.status }
    }
    if (operation === 'wait') {
      const seconds = request.seconds ?? 30
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('대기 시간은 1~300초입니다.')
      const until = request.until ?? 'ready'
      if (!['ready', 'reload'].includes(until)) throw new Error('시작 완료 또는 바로 반영 결과를 기다릴 수 있습니다.')
      if (until === 'reload' && preset.hotReload === 'off') throw new Error('이 구성은 바로 반영이 꺼져 있습니다.')
      const result = await wait(run, seconds * 1000, signal, until, afterReload)
      await verifyActor()
      return result
    }
    if (operation === 'log') {
      const count = request.lines ?? MAX_LOG_LINES
      if (!Number.isInteger(count) || count < 1 || count > MAX_LOG_LINES || (request.errors !== undefined && (request.errors !== true || request.lines !== undefined))) {
        throw new Error('로그는 최대 400줄까지 볼 수 있습니다.')
      }
      const history = run.reloadResults.slice(0, count).map(entry => reloadLog(entry.reload))
      if (request.errors) {
        const candidates = await jarCandidates(project, preset, run)
        await verifyActor()
        const suggestions = presetSuggestions(preset, run)
        expireProposals(run, preset, suggestions)
        return { ...(history.length && { reload: history }), groups: recentErrorGroups(run.logs, MAX_LOG_LINES - history.length),
          suggestions: suggestions.map(item => mcpJarSuggestion(item, candidates, preset, run)), proposals: agentProposals(run.proposals, by) }
      }
      return { lines: [...history, ...(count > history.length ? run.logs.lines(count - history.length) : [])] }
    }
    if (!['start', 'restart', 'stop'].includes(operation)) throw new Error('지원하지 않는 조작입니다.')
    return act(project, preset.id, operation, { by, allowed, verifyActor })
  }

  function publishBatch(project, batch, phase) {
    if (batch) batch.state = { total: batch.stages.length, stages: batch.stages.map(stage => stage.ids), ...phase }
    if (!isLocked()) sendState({ projectKey: project.key, worktreeKey: project.worktreeKey, batch: batch?.state ?? null })
  }

  function finishBatch(project, batch, cancelled = false) {
    if (batches.get(project.worktreeKey) !== batch) return
    for (const { ids } of batch.stages) for (const id of ids) {
      const run = getRun(project, id)
      if (run) run.orderLog = undefined
    }
    if (cancelled && batch.state) {
      if (batch.state.status !== 'cancelled') {
        publishBatch(project, batch, { status: 'cancelled', reason: 'cancelled', index: batch.state.index })
      }
    } else {
      batches.delete(project.worktreeKey)
      publishBatch(project, null)
    }
  }

  async function driveBatch(project, batch, allowed, approve, { by = USER, verifyActor, signal } = {}) {
    const abort = () => batch.abort()
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const mayStart = () => allowed() && !batch.signal.aborted
    try {
      const fail = await runStartStages(batch, {
        signal: batch.signal, now, check: () => ensureAllowed(mayStart),
        start: id => act(project, id, 'start', { by, allowed: mayStart, approve, verifyActor }),
        active: id => ACTIVE.has(getRun(project, id)?.state.status),
        failed: id => failedRun(getRun(project, id)),
        meets(id, gate) {
          const run = getRun(project, id)
          return gate.kind === 'ready' ? run.state.status === 'running' : run.orderLogMatched
        },
        publish: phase => publishBatch(project, batch, phase)
      })
      batch.signal.throwIfAborted()
      if (!fail) {
        finishBatch(project, batch)
        return { ok: true }
      }
      const { index, ids, reason, error } = fail
      batch.failure = { index, ids, reason }
      publishBatch(project, batch, { index, ids, reason, status: 'paused',
        ...(error && { error: failure(error).error }) })
      return { ok: true, paused: true, reason, step: index + 1 }
    } catch (error) {
      const cancelled = batch.signal.aborted || isLocked()
      finishBatch(project, batch, cancelled)
      if (cancelled) return { ok: true, cancelled: true }
      throw error
    } finally { signal?.removeEventListener('abort', abort) }
  }

  async function prepareBatch(project, batch, allowed, approve, { by = USER, verifyActor } = {}) {
    for (const stage of batch.stages.slice(batch.index)) for (const id of stage.ids) {
      ensureAllowed(allowed)
      if (batch.ignored.has(id)) continue
      let preset = find(project, id)
      const run = runFor(project, id)
      if (by !== USER) guardAgent(preset, run, 'start')
      if (!ACTIVE.has(run.state.status) && (!batch.startedIds.has(id) || failedRun(run))) {
        preset = confirmCommand(project, preset, by, approve)
        await freshTask(project, preset, by, approve, allowed)
        if (verifyActor) await verifyActor()
      }
      if (stage.gate.kind === 'log' && run.orderLog !== stage.gate.value) {
        run.orderLog = stage.gate.value
        run.orderLogMatched = run.logs.hasOutputLine(run.orderLog)
      }
    }
  }

  async function startAll(project, allowed, approve, { selected, ...actor } = {}) {
    const key = project.worktreeKey
    if (stoppingAll.has(key)) throw new Error('이 워크트리의 실행을 중지하는 중입니다.')
    const previous = batches.get(key)
    if (previous && previous.state?.status !== 'cancelled') throw new Error('이 워크트리의 구성을 시작하는 중입니다.')
    const order = orderOf(project)
    const stages = selectStartStages(order, selected, presetIdsOf(project))
    if (!stages.length) return { ok: true }
    const controller = new AbortController()
    const batch = { ...order, stages, project, index: 0, ignored: new Set(), skippedGates: new Set(), startedIds: new Set(),
      signal: controller.signal, abort: () => controller.abort() }
    batches.set(key, batch)
    try {
      await actor.verifyActor?.()
      await prepareBatch(project, batch, () => allowed() && !batch.signal.aborted && !actor.signal?.aborted, approve, actor)
      actor.signal?.throwIfAborted()
    } catch (error) {
      finishBatch(project, batch)
      throw error
    }
    if (actor.detached) {
      // Authorization and folder are verified up front. The accepted run can outlive the agent's request or wake state.
      void driveBatch(project, batch, () => !isLocked(), approve, { by: actor.by }).catch(() => {})
      return { ok: true, stages: stages.length }
    }
    return driveBatch(project, batch, allowed, approve, actor)
  }

  async function resumeBatch(project, action, allowed, approve) {
    ensureAllowed(allowed)
    if (!['skip', 'retry', 'cancel'].includes(action)) throw new Error('기동 순서 조작을 확인해 주세요.')
    const batch = batches.get(project.worktreeKey)
    if (action === 'cancel' && (batch?.state?.status === 'paused' || batch?.state?.status === 'cancelled')) {
      batch.abort()
      finishBatch(project, batch)
      return { ok: true }
    }
    if (!batch?.failure || batch.resuming || batch.signal.aborted) throw new Error('멈춘 기동 순서를 찾을 수 없습니다.')
    const { index, ids, reason } = batch.failure
    batch.resuming = true
    const previousIndex = batch.index
    const previousIgnored = new Set(batch.ignored)
    const previousGates = new Set(batch.skippedGates)
    if (action === 'retry') batch.index = index
    else if (reason === 'timeout') batch.skippedGates.add(index)
    else ids.forEach(id => batch.ignored.add(id))
    try {
      // Repeat confirmation if a preset changed while the batch was paused.
      await prepareBatch(project, batch, () => allowed() && !batch.signal.aborted, approve)
    } catch (error) {
      batch.index = previousIndex
      batch.ignored = previousIgnored
      batch.skippedGates = previousGates
      throw error
    } finally { batch.resuming = false }
    batch.failure = null
    return driveBatch(project, batch, allowed, approve)
  }

  async function startOne(project, id, choice, allowed, approve) {
    ensureAllowed(allowed)
    find(project, id)
    if (choice !== undefined && !['include', 'only'].includes(choice)) throw new Error('앞 단계 실행 여부를 확인해 주세요.')
    const order = orderOf(project)
    const target = order.stages.findIndex(stage => stage.ids.includes(id))
    const previous = order.stages.slice(0, Math.max(0, target)).flatMap(stage => stage.ids)
    const missing = previous.filter(id => !ACTIVE.has(getRun(project, id)?.state.status))
    if (order.askDependencies && missing.length && choice === undefined) {
      return { needsDependencies: missing.map(id => find(project, id).name) }
    }
    return choice === 'include' && previous.length
      ? startAll(project, allowed, approve, { selected: [...previous, id] })
      : act(project, id, 'start', { allowed, approve })
  }

  async function waitForTransition(transition) {
    if (!transition) return
    let timer
    try {
      await Promise.race([transition, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('실행 구성의 전환을 10초 안에 마치지 못했습니다.')), STOP_ALL_TRANSITION_MS)
        timer.unref?.()
      })])
    } finally { clearTimeout(timer) }
  }

  async function stopAll(project, allowed, { by = USER, verifyActor, selected } = {}) {
    ensureAllowed(allowed)
    const key = project.worktreeKey
    if (stoppingAll.has(key)) throw new Error('이 워크트리의 실행을 중지하는 중입니다.')
    await verifyActor?.()
    const scope = selected && new Set(selected)
    const presets = store.list(project.key).filter(preset => !scope || scope.has(preset.id))
    const batch = batches.get(key)
    const affectedBatch = batch && (!scope || batch.stages.some(stage => stage.ids.some(id => scope.has(id))))
    if (by !== USER) {
      const affected = new Set(batch?.state?.status !== 'cancelled' && affectedBatch ? batch.stages.flatMap(stage => stage.ids) : [])
      for (const preset of presets) {
        const run = getRun(project, preset.id)
        if (scope || run?.busy || ACTIVE.has(run?.state.status)) affected.add(preset.id)
      }
      for (const id of affected) guardAgent(find(project, id), getRun(project, id), 'stop')
    }
    if (stoppingAll.has(key)) throw new Error('이 워크트리의 실행을 중지하는 중입니다.')
    stoppingAll.set(key, project.key)
    if (affectedBatch) {
      batch.abort()
      finishBatch(project, batch)
    }
    try {
      const stopOne = async id => {
        const run = getRun(project, id)
        if (!run) return
        const transition = run.busy
        const stop = async () => {
          if (ACTIVE.has(run.state.status)) await act(project, id, 'stop', { allowed, by, verifyActor })
        }
        try { await waitForTransition(transition) }
        catch (error) {
          // Keep the stop request for a start that passed the launch check before the timeout.
          void transition.then(stop).catch(() => {})
          throw error
        }
        await stop()
      }
      let firstError
      const order = orderOf(project)
      const steps = scope && order.reverseStop
        ? selectStartStages(order, selected, presets.map(preset => preset.id)).map(stage => stage.ids).reverse()
        : stopStages(order, presets)
      for (const ids of steps) {
        const failed = (await Promise.allSettled(ids.map(stopOne))).find(result => result.status === 'rejected')
        firstError ??= failed?.reason
      }
      if (firstError) throw firstError
      return { ok: true }
    } finally { stoppingAll.delete(key) }
  }

  async function remove(project, id, allowed) {
    const preset = find(project, id)
    const instances = [...runs.values()].filter(run => run.id === id && run.project.key === project.key)
    if (instances.some(run => run.busy || ACTIVE.has(run.state.status))) throw new Error('실행을 중지한 뒤 구성을 삭제해 주세요.')
    ensureAllowed(allowed)
    if (userData) await cleanMavenPinRuns({ userData, presetId: id }).catch(() => {})
    ensureAllowed(allowed)
    if (find(project, id) !== preset || [...runs.values()].some(run => run.id === id && run.project.key === project.key
      && (run.busy || ACTIVE.has(run.state.status)))) throw new Error(MOVED)
    if (userData) removeMavenSettings({ userData, presetId: id })
    store.write(project.root, store.list(project.key).filter(preset => preset.id !== id))
    for (const run of instances) {
      closeReload(run)
      if (run.state.shellId) {
        run.deleting = true
        getShells().close(run.state.shellId)
      }
      runs.delete(runKey(run.project, id))
    }
    return { ok: true }
  }

  async function mavenPinStatus(project, id) {
    find(project, id)
    const pinned = Boolean(userData && await inspectMavenPin({ userData, presetId: id }))
    return { ok: true, pinned }
  }

  async function changeMavenPin(project, id, action, allowed, approve) {
    const preset = find(project, id)
    const pinned = userData && await inspectMavenPin({ userData, presetId: id })
    const authorize = () => {
      ensureAllowed(allowed)
      if (find(project, id) !== preset) throw new Error(MOVED)
      if (action === 'delete' && [...runs.values()].some(run => run.id === id && run.project.key === project.key
        && (run.busy || ACTIVE.has(run.state.status)))) throw new Error('실행을 중지한 뒤 Maven 보관본을 삭제해 주세요.')
    }
    authorize()
    if (!pinned) throw new Error('이 실행 구성의 Maven 보관본이 없습니다.')
    const destination = action === 'export' ? await mavenExportDestination(project.worktree) : null
    authorize()
    const binding = destination && [destination.stat.dev, destination.stat.ino, destination.stat.birthtimeMs]
    const question = new RunConfirmation('needsConfirm', id, action === 'export'
      ? `${preset.name}의 Maven 보관본을 현재 워크트리의 .mvn-repo/에 내보내기`
      : `${preset.name}의 Maven 보관본 삭제`, project.worktree, binding)
    if (!approve(question)) throw question
    const request = { userData, presetId: id, approved: true, authorize }
    if (action === 'export') await exportMavenPin({ ...request, worktree: project.worktree, expectedWorktree: destination.stat })
    else await deleteMavenPin(request)
    return { ok: true }
  }

  async function save(project, input, allowed) {
    const id = input?.id ?? randomUUID()
    // Execute-time Maven settings change only through an approved, current diagnosis.
    const draft = input && typeof input === 'object' && !Array.isArray(input)
      ? { ...input, mavenMirrors: undefined, mavenUserSettings: undefined } : input
    const next = validatePreset(draft, id)
    const cwd = await directoryInProject(project.worktree, next.relative)
    if (next.kind === 'task') {
      const { tasks } = await inspectDevelopmentTasks(cwd, process.platform, { rootOnly: true })
      if (!tasks.some(task => task.id === next.taskId)) throw new Error('선택한 폴더의 실행 후보를 다시 선택해 주세요.')
    }
    if (next.kind === 'tomcat' && !next.prepare) await webDirectory(project.worktree, next.webapp)
    if (next.contextXml) next.contextXml = (await workspaceAccess.contextFile(project, next.contextXml)).reference
    ensureAllowed(allowed)
    const current = store.list(project.key)
    const previous = input?.id === undefined ? null : find(project, id)
    if (next.extraLibs?.some(reference => !previous?.extraLibs?.includes(reference))) throw new Error(STALE_JAR)
    if (current.some(item => item.name === next.name && item.id !== id)) throw new Error('같은 이름의 실행 구성이 있습니다.')
    Object.assign(next, mavenFields({ ...next, mavenMirrors: previous?.mavenMirrors, mavenUserSettings: previous?.mavenUserSettings }))
    const approval = presetApproval(next)
    if (approval && previous?.confirmedHash === approval.hash) next.confirmedHash = previous.confirmedHash
    if (previous?.agentActionNotified) next.agentActionNotified = true
    store.write(project.root, previous ? current.map(item => item.id === id ? next : item) : [...current, next])
    if (previous) for (const run of runs.values()) {
      if (run.id === id && run.project.key === project.key) expireProposals(run, next)
    }
    return { preset: publicPreset(next) }
  }

  async function jarCandidates(project, preset, run) {
    const diagnosis = run?.jarDiagnosis
    const suggestions = presetSuggestions(preset, run)
    if (!diagnosis || !suggestions.some(item => item.kind === 'missingClass')) return new Map()
    const key = suggestions.filter(item => item.kind === 'missingClass').map(item => item.id).join(':')
    let search = diagnosis.search
    if (search?.key !== key || search.expires <= now()) {
      if (search?.key !== key) search?.controller.abort(new Error(STALE_JAR))
      const controller = new AbortController()
      search = { key, controller, expires: Infinity }
      diagnosis.search = search
      search.result = findJarCandidates(suggestions, project.worktree, jarHome, controller.signal).finally(() => { search.expires = now() + 15_000 })
    }
    return search.result
  }

  async function diagnosis(project, id, allowed) {
    const preset = find(project, id)
    const run = getRun(project, id)
    const currentDiagnosis = run?.jarDiagnosis
    const mavenDiagnosis = run?.diagnosis
    const [candidates] = await Promise.all([jarCandidates(project, preset, run), refreshMavenDiagnosis(preset, mavenDiagnosis)])
    ensureAllowed(allowed)
    if (getRun(project, id) !== run || run?.jarDiagnosis !== currentDiagnosis || run?.diagnosis !== mavenDiagnosis || find(project, id) !== preset) throw new Error(MOVED)
    if (run) run.jarOffered = candidates
    const suggestions = presetSuggestions(preset, run)
    expireProposals(run, preset, suggestions)
    return { ok: true, suggestions: redactRunOutput(suggestions.map(item => jarSuggestion(item, candidates, preset, run))) }
  }

  async function refreshMavenDiagnosis(preset, diagnosis) {
    if (!diagnosis?.invocation) return
    const [pinned, runner] = await Promise.all([
      userData && inspectMavenPin({ userData, presetId: preset.id }).catch(() => false),
      diagnosis.mavenFeature && diagnosis.mavenFeature < 17
        ? Promise.resolve(listJdks()).then(jdks => selectMavenJdk({ jdks: jdks.filter(jdk => jdk.feature === 17), javaHomeOf })).catch(() => null)
        : null
    ])
    diagnosis.pinned = Boolean(pinned)
    diagnosis.mavenRunner17 = runner?.id
  }

  async function applySuggestion(project, id, request, allowed) {
    ensureAllowed(allowed)
    const preset = find(project, id)
    const run = getRun(project, id)
    if (run?.busy) throw new Error('이 실행 구성을 전환하는 중입니다.')
    let fields
    if (request?.jarId !== undefined) {
      const generation = run?.jarDiagnosis
      const offered = run?.jarOffered
      const extraLibs = await selectedJarReferences({ preset, run, suggestions: presetSuggestions(preset, run), request,
        projectRoot: project.worktree, home: jarHome })
      ensureAllowed(allowed)
      if (getRun(project, id) !== run || run.jarDiagnosis !== generation || run.jarOffered !== offered || run.busy || find(project, id) !== preset
        || !presetSuggestions(preset, run).some(item => item.id === request.id)) throw new Error(STALE_JAR)
      fields = { extraLibs }
    } else {
      const context = run?.diagnosis
      const selected = presetSuggestions(preset, run).find(item => item.id === request?.id)
      if (selected?.apply === 'mavenPinned' || selected?.apply === 'mavenRunner') {
        await refreshMavenDiagnosis(preset, context)
        ensureAllowed(allowed)
        if (getRun(project, id) !== run || run.diagnosis !== context || run.busy || find(project, id) !== preset) throw new Error(MOVED)
      }
      fields = suggestedMavenFields(preset, run, request)
    }
    const { confirmedHash: _confirmedHash, ...next } = { ...preset, ...fields }
    store.write(project.root, store.list(project.key).map(item => item.id === id ? next : item))
    changeProposalStatuses(run, item => approvedProposalStatus(item, request, next))
    return { ok: true, preset: publicPreset(next) }
  }

  function dismissProposal(project, id, proposalId, allowed) {
    ensureAllowed(allowed)
    find(project, id)
    const run = getRun(project, id)
    if (!run?.proposals?.some(item => item.id === proposalId && item.status !== 'applied')) throw new Error(STALE_PROPOSAL)
    changeProposalStatuses(run, item => item.id === proposalId ? 'dismissed' : 'pending')
    return { ok: true }
  }

  function sendPreview(project, id, note = '') {
    if (typeof note !== 'string' || note.length > MAX_SEND_NOTE) throw new Error('덧붙일 말을 확인해 주세요.')
    const preset = find(project, id)
    const run = getRun(project, id)
    const kind = preset.kind === 'task' ? { node: 'Node', gradle: 'Spring Boot (Gradle)', maven: 'Spring Boot (Maven)' }[preset.taskId.slice(2)]
      : preset.kind === 'tomcat' ? 'Tomcat' : '직접 입력'
    const folder = preset.relative.length <= 1500 ? `${preset.relative}/` : `${preset.relative.slice(0, 1500)}…`
    const summary = redactRunSecrets([preset.name, `폴더 ${folder}`, `실행 방식 ${kind}`,
      `종료 코드 ${run?.state.exitCode ?? '—'}`].join('\n'))
    // Reserve room for the longest note so the message body stays as shown in the preview.
    const logs = run?.logs.groups().at(-1)?.lines.join('\n') ?? ''
    const detail = redactRunSecrets(logs).slice(0, MAX_SEND_BODY - summary.length - '\n\n'.length).trimEnd()
    const extra = redactRunSecrets(note.trim()).slice(0, MAX_SEND_NOTE)
    return [summary, detail, extra].filter(Boolean).join('\n\n')
  }

  async function send(project, id, agentId, allowed, takePreview) {
    if (typeof agentId !== 'string') throw new Error('받는 에이전트를 확인해 주세요.')
    if ((await agentProject(getAgent(agentId))).key !== project.key) throw new Error('같은 프로젝트의 에이전트만 선택할 수 있습니다.')
    ensureAllowed(allowed)
    find(project, id)
    sendAsUser({ to: agentId, text: takePreview() })
    return { ok: true }
  }

  const presetIdsOf = project => store.list(project.key).map(preset => preset.id)
  /** The presets a bundle starts (by id from the screen, by name from the MCP tools) */
  const bundleSelection = (project, which) => bundleStore.selection(project.key, presetIdsOf(project), which)

  return {
    projectOf, act, save, remove, send, sendPreview, startOne, startAll, resumeBatch, stopAll, applySuggestion, dismissProposal, mavenPinStatus, changeMavenPin,
    bundleSelection,
    saveBundle(project, input, allowed) {
      ensureAllowed(allowed)
      return { ok: true, bundles: bundleStore.save(project.key, input, presetIdsOf(project)) }
    },
    removeBundle(project, id, allowed) {
      ensureAllowed(allowed)
      if (typeof id !== 'string') throw new Error('묶음을 찾지 못했습니다.')
      return { ok: true, bundles: bundleStore.remove(project.key, id, presetIdsOf(project)) }
    },
    saveOrder(project, input, allowed, knownIds) {
      ensureAllowed(allowed)
      if ([...stoppingAll.values()].includes(project.key) ||
        [...batches.values()].some(batch => batch.project.key === project.key && batch.state?.status !== 'cancelled')) {
        throw new Error('실행이 끝난 뒤 기동 순서를 저장해 주세요.')
      }
      const presets = store.list(project.key)
      if (knownIds !== undefined && (!Array.isArray(knownIds) || knownIds.length !== presets.length
        || new Set(knownIds).size !== presets.length || presets.some(preset => !knownIds.includes(preset.id)))) {
        throw new Error('실행 구성이 바뀌었습니다. 기동 순서 창을 다시 열어 주세요.')
      }
      const order = validateStartOrder(input, presets)
      const ids = new Set(order.stages.flatMap(stage => stage.ids))
      store.write(project.root, presets.map(preset => preset.inAll === ids.has(preset.id) ? preset : { ...preset, inAll: ids.has(preset.id) }), order)
      return { ok: true }
    },
    async agentTool(...args) {
      try { return redactRunOutput(await agentTool(...args)) }
      catch (error) {
        if (typeof error?.message !== 'string') throw error
        const message = redactRunSecrets(error.message)
        if (message !== error.message) throw new Error(message)
        throw error
      }
    },
    list(project) {
      const presets = store.list(project.key)
      return { projectKey: project.key, worktreeKey: project.worktreeKey, presets: presets.map(publicPreset),
        bundles: bundleStore.list(project.key, presets.map(preset => preset.id)),
        startOrder: orderOf(project), batch: batches.get(project.worktreeKey)?.state ?? null,
        states: Object.fromEntries(presets.map(preset => [preset.id, getRun(project, preset.id)?.state ?? idle()])) }
    },
    async candidates(project, relative) {
      const cwd = await directoryInProject(project.worktree, relative)
      const { tasks } = await inspectDevelopmentTasks(cwd, process.platform, { rootOnly: true })
      return { candidates: tasks.map(({ id, name, command }) => ({ taskId: id, name, command })) }
    },
    async antTargets(project, relative) { return { ok: true, targets: await antTargets(await directoryInProject(project.worktree, relative)) } },
    async webapps(project) { return { ok: true, folders: await webappCandidates(project.worktree) } },
    async workspaceServers(project, folder, allowed) {
      ensureAllowed(allowed)
      const root = await workspaceAccess.selectedRoot(folder)
      const result = await workspaceServers(root, { launchArguments: workspaceVmArguments, validContextPath })
      ensureAllowed(allowed)
      workspaceAccess.grant(project, root)
      for (const server of result.servers) {
        if (server.contextXml) server.contextXml = (await workspaceAccess.contextFile(project, server.contextXml)).reference
      }
      return { ok: true, workspace: path.basename(root) || '이클립스 워크스페이스', ...result }
    },
    /** Where the folder dialog opens: the folder already typed when it is inside the worktree, else the worktree */
    folderDialogStart(project, relative) {
      return directoryInProject(project.worktree, relative).catch(() => project.worktree)
    },
    /** The folder the user picked in that dialog, as the preset's relative path; checked like a saved one */
    async chooseFolder(project, chosen, allowed) {
      ensureAllowed(allowed)
      const real = await realDirectory(chosen)
      const relative = path.relative(project.worktree, real)
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('프로젝트 안의 폴더를 선택해 주세요.')
      const stored = presetRelative(relative || '.')
      if (await directoryInProject(project.worktree, stored) !== real) throw new Error('프로젝트 안의 폴더를 선택해 주세요.')
      ensureAllowed(allowed)
      return { ok: true, relative: stored }
    },
    async chooseContextXml(project, file, allowed) {
      ensureAllowed(allowed)
      const { reference } = await workspaceAccess.contextFile(project, file)
      return { ok: true, contextXml: reference, label: path.basename(file) }
    },
    async eclipseImport(project, relative) {
      const { draft, notes } = await loadEclipseProject(project.worktree, await directoryInProject(project.worktree, relative))
      if (!validContextPath(draft.contextPath)) {
        draft.contextPath = '/'
        notes.push('가져온 컨텍스트 경로를 사용할 수 없어 기본 경로 /를 표시합니다.')
      }
      return { ok: true, draft, notes }
    },
    reorder(project, ids) {
      const current = store.list(project.key)
      if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length) throw new Error('구성 순서를 확인해 주세요.')
      store.write(project.root, ids.map(id => find(project, id)))
      return { ok: true }
    },
    errors(project, id) { return { groups: redactRunOutput(getRun(project, find(project, id).id)?.logs.groups() ?? []) } },
    diagnosis,
    async changeFromShell(shellId, taskId, action, allowed) {
      const run = byShell.get(shellId)
      if (!run) return getShells().changeDevelopmentTask(shellId, taskId, action, allowed)
      if (taskId !== `preset:${run.id}` || !['restart', 'stop'].includes(action)) throw new Error(MISSING)
      return act(run.project, run.id, action, { allowed })
    },
    cancelBatches() {
      for (const batch of batches.values()) {
        batch.abort()
        finishBatch(batch.project, batch, true)
      }
    },
    suspendReloads() {
      for (const run of runs.values()) {
        suspendReload(run)
        for (const settle of run.waiters) settle()
      }
    },
    resumeReloads() { for (const run of runs.values()) openReload(run) },
    stopReloads() {
      for (const run of runs.values()) closeReload(run)
    }
  }
}

function registerRunPresetIpc({ ipcMain, controller, fromMainWindow, isLocked, chooseWorkspaceFolder = async () => null, chooseContextFile = async () => null, chooseProjectFolder = async () => null }) {
  // Accept only the command shown to this frame. Keep earlier install approvals for this batch retry.
  const confirms = new Map()
  // A preview is a snapshot, including the note. Only its originating frame can send it once.
  const previews = new Map()
  const previewKey = (project, id) => JSON.stringify([project.key, project.worktreeKey, id])
  function handle(channel, run) {
    ipcMain.handle(channel, async (event, projectFolder, ...args) => {
      const allowed = () => !isLocked() && fromMainWindow(event) && event.senderFrame && event.senderFrame === event.sender.mainFrame
      try {
        if (!allowed()) throw new Error(NOT_ALLOWED)
        const project = await controller.projectOf(projectFolder)
        if (!allowed()) throw new Error(NOT_ALLOWED)
        const result = await run(project, allowed, event.senderFrame, ...args)
        if (!allowed()) throw new Error(NOT_ALLOWED)
        return result
      } catch (error) { return failure(error) }
    })
  }
  handle('run-presets-list', project => controller.list(project))
  handle('run-presets-candidates', (project, _allowed, _frame, relative) => controller.candidates(project, relative))
  handle('run-preset-ant-targets', (project, _allowed, _frame, relative) => controller.antTargets(project, relative))
  handle('run-preset-webapps', project => controller.webapps(project))
  handle('run-preset-workspace-servers', async (project, allowed) => {
    const folder = await chooseWorkspaceFolder(project.worktree)
    return folder ? controller.workspaceServers(project, folder, allowed) : { ok: false, cancelled: true }
  })
  handle('run-preset-choose-context-xml', async (project, allowed) => {
    const file = await chooseContextFile(project.worktree)
    return file ? controller.chooseContextXml(project, file, allowed) : { ok: false, cancelled: true }
  })
  handle('run-preset-choose-folder', async (project, allowed, _frame, relative) => {
    const chosen = await chooseProjectFolder(await controller.folderDialogStart(project, relative))
    return chosen ? controller.chooseFolder(project, chosen, allowed) : { ok: false, cancelled: true }
  })
  handle('run-preset-eclipse-import', (project, _allowed, _frame, relative) => controller.eclipseImport(project, relative))
  handle('run-presets-save', (project, allowed, _frame, preset) => controller.save(project, preset, allowed))
  handle('run-presets-delete', (project, allowed, _frame, id) => controller.remove(project, id, allowed))
  handle('run-presets-reorder', (project, _allowed, _frame, ids) => controller.reorder(project, ids))
  handle('run-start-order-save', (project, allowed, _frame, input, knownIds) => controller.saveOrder(project, input, allowed, knownIds))
  handle('run-start-order-resume', (project, allowed, frame, action, config) => withConfirmation(project, allowed, frame, 'resume-order', action, config,
    approve => controller.resumeBatch(project, action, allowed, approve)))
  async function withConfirmation(project, allowed, frame, action, id, config, execute) {
    const key = JSON.stringify([project.worktreeKey, action, id])
    const previous = confirms.get(key)
    confirms.delete(key)
    const confirmed = previous?.frame === frame && config?.[previous.question.type === 'needsConfirm' ? 'confirmCustom' : 'confirmInstall'] === true
    const approved = confirmed ? previous.approved : new Set()
    if (confirmed) approved.add(`${previous.question.type}:${previous.question.key}`)
    const approve = question => approved.has(`${question.type}:${question.key}`)
    try { return await execute(approve) }
    catch (error) {
      if (!(error instanceof RunConfirmation) || !allowed()) throw error
      confirms.set(key, { approved, frame, question: error })
      return { [error.type]: { command: error.command } }
    }
  }
  for (const action of ['start', 'restart', 'stop']) handle(`run-preset-${action}`, (project, allowed, frame, id, config) => {
    return withConfirmation(project, allowed, frame, action, id, config, approve => action === 'start'
      ? controller.startOne(project, id, config?.dependencies, allowed, approve)
      : controller.act(project, id, action, { allowed, approve }))
  })
  // config.bundleId: only that run bundle's presets (part 3); a question asked for one bundle is not answered for another
  const bundleScope = (project, config) => config?.bundleId === undefined ? {} : { selected: controller.bundleSelection(project, { id: config.bundleId }) }
  handle('run-preset-start-all', (project, allowed, frame, config) => withConfirmation(project, allowed, frame, 'start-all', config?.bundleId ?? null, config,
    approve => controller.startAll(project, allowed, approve, bundleScope(project, config))))
  handle('run-preset-stop-all', (project, allowed, _frame, config) => controller.stopAll(project, allowed, bundleScope(project, config)))
  handle('run-preset-bundle-save', (project, allowed, _frame, bundle) => controller.saveBundle(project, bundle, allowed))
  handle('run-preset-bundle-delete', (project, allowed, _frame, id) => controller.removeBundle(project, id, allowed))
  handle('run-preset-errors', (project, _allowed, _frame, id) => controller.errors(project, id))
  handle('run-preset-diagnosis', (project, allowed, _frame, id) => controller.diagnosis(project, id, allowed))
  handle('run-preset-apply-suggestion', (project, allowed, _frame, id, request) => controller.applySuggestion(project, id, request, allowed))
  handle('run-preset-maven-pin-status', (project, _allowed, _frame, id) => controller.mavenPinStatus(project, id))
  for (const action of ['export', 'delete']) handle(`run-preset-${action}-maven-pin`, (project, allowed, frame, id, config) =>
    withConfirmation(project, allowed, frame, `${action}-maven-pin`, id, config,
      approve => controller.changeMavenPin(project, id, action, allowed, approve)))
  handle('run-preset-dismiss-proposal', (project, allowed, _frame, id, proposalId) => controller.dismissProposal(project, id, proposalId, allowed))
  handle('run-preset-send-preview', (project, _allowed, frame, id, note) => {
    const text = controller.sendPreview(project, id, note)
    const key = previewKey(project, id)
    const token = createHash('sha256').update(JSON.stringify([randomUUID(), key, text])).digest('hex')
    previews.set(token, { frame, key, text })
    if (previews.size > MAX_SEND_PREVIEWS) previews.delete(previews.keys().next().value)
    return { text, token }
  })
  handle('run-preset-send', (project, allowed, frame, id, agentId, token) => {
    const preview = previews.get(token)
    if (!preview || preview.frame !== frame || preview.key !== previewKey(project, id)) throw new Error(MISSING_PREVIEW)
    return controller.send(project, id, agentId, allowed, () => {
      if (!previews.delete(token)) throw new Error(MISSING_PREVIEW)
      return preview.text
    })
  })
  return { clearConfirmations() { confirms.clear(); previews.clear() } }
}

module.exports = { createRunPresets, registerRunPresetIpc, resolveProject, withSubject }
