const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { inspectLocalProject } = require('./localProjects.js')
const { inspectDevelopmentTasks, prepareDevelopmentTask } = require('./localDevelopmentTasks.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { createDevelopmentErrors, MAX_LOG_LINES } = require('./developmentErrors.js')
const { prepareHotReload, startHotReload, reloadLog, RESULTS: RELOAD_RESULTS } = require('./hotReload.js')
const { createRunPresetStore, validatePreset, presetName, publicPreset, commandHash, projectKey, realDirectory, directoryInProject } = require('./runPresetStore.js')

const READY_TIMEOUT = 300_000
const USER = 'user'
const USER_STOP_MS = 30_000
const STOP_ALL_TRANSITION_MS = 10_000
const MAX_ACTIONS = 20
const MAX_RELOAD_RESULTS = 10
const MAX_SEND_NOTE = 4000
const MAX_SEND_BODY = 8000 - MAX_SEND_NOTE - '\n\n'.length
const ACTIVE = new Set(['starting', 'running'])
const NOT_ALLOWED = '잠금 해제 후 본창에서 이용할 수 있습니다.'
const MISSING = '실행 구성을 찾을 수 없습니다.'
const MOVED = '실행 구성이 바뀌었습니다. 다시 선택해 주세요.'
const idle = () => ({ status: 'idle', errors: 0 })
const optionsForTask = { includeSource: false, rootOnly: true, allowPendingInstall: true }
const failure = error => ({ ok: false, error: error.code ? '실행 구성을 처리하지 못했습니다.' : error.message })
const noApproval = () => false
const runKey = (project, id) => `${project.worktreeKey}\0${id}`

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
  constructor(type, id, command, cwd) {
    super('실행 카드에서 확인한 뒤 실행해 주세요.')
    this.type = type
    this.command = command
    this.key = JSON.stringify([id, command, cwd])
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

function createRunPresets({ store, file, getShells, getAgent, isLocked, javaHomeOf = () => null,
  enhancedJvmArgs = () => null, userData = file && path.dirname(file), prepareReload = prepareHotReload, startReload = startHotReload,
  sendState = () => {}, notifyCrash = () => {}, sendAsUser, now = Date.now, projectOf = resolveProject,
  prepareTask = prepareDevelopmentTask }) {
  store ??= createRunPresetStore(file)
  const runs = new Map()
  const byShell = new Map()
  const batches = new Map()
  const stoppingAll = new Set()
  let reloadSequence = 0
  const getRun = (project, id) => runs.get(runKey(project, id))

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
    update(run, { address, readyAt, errors, ...(readyAt !== undefined && run.state.status === 'starting' ? { status: 'running' } : {}) })
  }

  function suspendReload(run) {
    run.reloadWorker?.suspend()
  }

  function openReload(run) {
    if (!run.reloadLaunch || !ACTIVE.has(run.state.status)) return
    const paused = isLocked()
    if (run.reloadWorker) { if (!paused) run.reloadWorker.resume(); return }
    const { config, pid, env } = run.reloadLaunch
    run.reloadWorker = startReload(config, { pid, env, paused, running: () => run.state.status === 'running' && !isLocked(),
      onState(reload, diagnostics) {
        if (reload.status === 'compileError') run.logs.addError(`ERROR ${reload.reason}`, diagnostics)
        if (RELOAD_RESULTS.has(reload.status)) {
          run.reloadResults.unshift({ sequence: ++reloadSequence, reload })
          if (run.reloadResults.length > MAX_RELOAD_RESULTS) run.reloadResults.pop()
        }
        update(run, { reload, errors: run.logs.state().errors })
      } })
  }

  function closeReload(run) {
    run.reloadWorker?.close()
    run.reloadWorker = undefined
    run.reloadLaunch = undefined
  }

  function onEvent(run, event, hotReload) {
    const { type, shellId } = event
    if (type === 'start') {
      closeReload(run)
      byShell.set(shellId, run)
      run.logs = createDevelopmentErrors(now)
      update(run, { status: 'starting', startedAt: now(), shellId, exitCode: null, address: undefined, readyAt: undefined, reload: undefined, errors: 0 })
      return
    }
    if (run.state.shellId !== shellId) return
    if (type === 'launched' && hotReload && ACTIVE.has(run.state.status)) {
      run.reloadLaunch = { config: hotReload, pid: event.pid, env: event.env }
      openReload(run)
    } else if (type === 'data' && ACTIVE.has(run.state.status)) {
      run.logs.feed(event.data)
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
      run.logs.finish()
      const logState = run.logs.state()
      const crashed = !event.action && (event.failed || (typeof event.exitCode === 'number' && event.exitCode !== 0))
      update(run, { ...logState, status: crashed ? 'crashed' : 'stopped', exitCode: event.exitCode })
      const preset = store.list(run.project.key).find(item => item.id === run.id)
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
    return { ...defined, id: `preset:${preset.id}`, relative: preset.relative, name: preset.name, label: preset.name,
      javaHome, env: preset.env, enhancedArgs }
  }

  function guardAgent(preset, run, action) {
    if (!preset.agentControl) throw new Error('이 실행 구성은 에이전트 조작이 꺼져 있습니다.')
    if ((action === 'start' || action === 'restart') && run?.userStoppedAt !== undefined && now() - run.userStoppedAt < USER_STOP_MS) {
      throw new Error('사용자가 방금 중지했습니다.')
    }
  }

  function confirmCommand(project, preset, by, approve) {
    if (preset.kind !== 'custom' || preset.confirmedHash === commandHash(preset.command)) return preset
    if (by !== USER) throw new Error('먼저 사용자가 화면에서 실행 명령을 확인해야 합니다.')
    const question = new RunConfirmation('needsConfirm', preset.id, preset.command)
    if (!approve(question)) throw question
    const confirmed = { ...preset, confirmedHash: commandHash(preset.command) }
    store.write(project.root, store.list(project.key).map(item => item.id === preset.id ? confirmed : item))
    return confirmed
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
      let task = await freshTask(project, preset, by, approve, canAct)
      if (preset.hotReload && preset.hotReload !== 'off') {
        const { enhancedArgs, ...base } = task
        task = await prepareReload(base, { worktree: project.worktree, kind: preset.taskId, mode: preset.hotReload, args: enhancedArgs, userData })
      }
      if (verifyActor) await verifyActor()
      ensureAllowed(canAct)
      return { ...task, onEvent: event => onEvent(run, event, task.hotReload) }
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
    const cwd = await getShells().currentDirectory(agent.shellId)
    if (!cwd || getShells().chatAgentId(agent.shellId) !== agent.id) throw new Error('에이전트의 로컬 작업 폴더를 확인하지 못했습니다.')
    const project = await projectOf(cwd)
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
      return { presets: store.list(project.key).map(preset => {
        const state = getRun(project, preset.id)?.state ?? idle()
        return { name: preset.name, status: state.status, port: portOf(state.address),
          errors: state.errors, agentControl: preset.agentControl, ...(state.reload && { reload: state.reload }) }
      }) }
    }
    const preset = store.list(project.key).find(item => item.name === presetName(request.name))
    if (!preset) throw new Error(MISSING)
    const operation = request.method.slice(4)
    const verifyActor = async () => {
      ensureAllowed(allowed)
      const current = await agentProject(getAgent(by))
      if (current.key !== project.key || current.worktreeKey !== project.worktreeKey || find(project, preset.id) !== preset) throw new Error(MOVED)
      ensureAllowed(allowed)
    }
    const run = runFor(project, preset.id)
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
      if (request.errors) return { ...(history.length && { reload: history }), groups: recentErrorGroups(run.logs, MAX_LOG_LINES - history.length) }
      return { lines: [...history, ...(count > history.length ? run.logs.lines(count - history.length) : [])] }
    }
    if (!['start', 'restart', 'stop'].includes(operation)) throw new Error('지원하지 않는 조작입니다.')
    return act(project, preset.id, operation, { by, allowed, verifyActor })
  }

  async function startAll(project, allowed, approve) {
    const key = project.worktreeKey
    if (stoppingAll.has(key)) throw new Error('이 워크트리의 실행을 중지하는 중입니다.')
    if (batches.has(key)) throw new Error('이 워크트리의 구성을 시작하는 중입니다.')
    const presets = store.list(project.key).filter(preset => preset.inAll)
    const batch = new AbortController()
    batches.set(key, batch)
    const mayStart = () => allowed() && !batch.signal.aborted
    let previous
    try {
      for (const listed of presets) {
        if (ACTIVE.has(getRun(project, listed.id)?.state.status)) continue
        ensureAllowed(mayStart)
        const preset = confirmCommand(project, find(project, listed.id), USER, approve)
        await freshTask(project, preset, USER, approve, mayStart)
      }
      for (const preset of presets) {
        if (previous && preset.waitReady) {
          const { result } = await wait(previous, READY_TIMEOUT, batch.signal)
          if (result !== 'ready') throw new Error('앞 실행 구성의 시작 완료를 확인하지 못했습니다.')
        }
        await act(project, preset.id, 'start', { by: USER, allowed: mayStart, approve })
        previous = getRun(project, preset.id)
      }
      return { ok: true }
    } finally { batches.delete(key) }
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

  async function stopAll(project, allowed) {
    ensureAllowed(allowed)
    const key = project.worktreeKey
    if (stoppingAll.has(key)) throw new Error('이 워크트리의 실행을 중지하는 중입니다.')
    stoppingAll.add(key)
    batches.get(key)?.abort()
    try {
      const results = await Promise.allSettled(store.list(project.key).map(async preset => {
        const run = getRun(project, preset.id)
        if (!run) return
        const transition = run.busy
        const stop = async () => {
          if (ACTIVE.has(run.state.status)) await act(project, preset.id, 'stop', { allowed })
        }
        try { await waitForTransition(transition) }
        catch (error) {
          // Keep the stop request for a start that passed the launch check before the timeout.
          void transition.then(stop).catch(() => {})
          throw error
        }
        await stop()
      }))
      const failure = results.find(result => result.status === 'rejected')
      if (failure) throw failure.reason
      return { ok: true }
    } finally { stoppingAll.delete(key) }
  }

  async function remove(project, id, allowed) {
    find(project, id)
    const instances = [...runs.values()].filter(run => run.id === id && run.project.key === project.key)
    if (instances.some(run => run.busy || ACTIVE.has(run.state.status))) throw new Error('실행을 중지한 뒤 구성을 삭제해 주세요.')
    ensureAllowed(allowed)
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

  async function save(project, input, allowed) {
    const id = input?.id ?? randomUUID()
    const next = validatePreset(input, id)
    const cwd = await directoryInProject(project.worktree, next.relative)
    if (next.kind === 'task') {
      const { tasks } = await inspectDevelopmentTasks(cwd, process.platform, { rootOnly: true })
      if (!tasks.some(task => task.id === next.taskId)) throw new Error('선택한 폴더의 실행 후보를 다시 선택해 주세요.')
    }
    ensureAllowed(allowed)
    const current = store.list(project.key)
    const previous = input?.id === undefined ? null : find(project, id)
    if (current.some(item => item.name === next.name && item.id !== id)) throw new Error('같은 이름의 실행 구성이 있습니다.')
    if (next.kind === 'custom' && previous?.confirmedHash === commandHash(next.command)) next.confirmedHash = previous.confirmedHash
    if (previous?.agentActionNotified) next.agentActionNotified = true
    store.write(project.root, previous ? current.map(item => item.id === id ? next : item) : [...current, next])
    return { preset: publicPreset(next) }
  }

  function sendPreview(project, id) {
    const preset = find(project, id)
    const run = getRun(project, id)
    const kind = preset.kind === 'task' ? { node: 'Node', gradle: 'Spring Boot (Gradle)', maven: 'Spring Boot (Maven)' }[preset.taskId.slice(2)] : '직접 입력'
    const folder = preset.relative.length <= 1500 ? `${preset.relative}/` : `${preset.relative.slice(0, 1500)}…`
    const summary = [preset.name, `폴더 ${folder}`, `실행 방식 ${kind}`,
      `종료 코드 ${run?.state.exitCode ?? '—'}`].join('\n')
    // Reserve room for the longest note so the message body stays as shown in the preview.
    const logs = run?.logs.groups().at(-1)?.lines.join('\n') ?? ''
    const detail = logs.slice(0, MAX_SEND_BODY - summary.length - '\n\n'.length).trimEnd()
    return detail ? `${summary}\n\n${detail}` : summary
  }

  async function send(project, id, agentId, note, allowed, preview) {
    if (typeof agentId !== 'string' || (note !== undefined && (typeof note !== 'string' || note.length > MAX_SEND_NOTE))) throw new Error('받는 에이전트와 메모를 확인해 주세요.')
    if ((await agentProject(getAgent(agentId))).key !== project.key) throw new Error('같은 프로젝트의 에이전트만 선택할 수 있습니다.')
    ensureAllowed(allowed)
    find(project, id)
    const text = preview ?? sendPreview(project, id)
    const extra = note?.trim()
    sendAsUser({ to: agentId, text: extra ? `${text}\n\n${extra}` : text })
    return { ok: true }
  }

  return {
    projectOf, act, save, remove, send, sendPreview, startAll, stopAll, agentTool,
    list(project) {
      const presets = store.list(project.key)
      return { projectKey: project.key, worktreeKey: project.worktreeKey, presets: presets.map(publicPreset),
        states: Object.fromEntries(presets.map(preset => [preset.id, getRun(project, preset.id)?.state ?? idle()])) }
    },
    async candidates(project, relative) {
      const cwd = await directoryInProject(project.worktree, relative)
      const { tasks } = await inspectDevelopmentTasks(cwd, process.platform, { rootOnly: true })
      return { candidates: tasks.map(({ id, name, command }) => ({ taskId: id, name, command })) }
    },
    reorder(project, ids) {
      const current = store.list(project.key)
      if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length) throw new Error('구성 순서를 확인해 주세요.')
      store.write(project.root, ids.map(id => find(project, id)))
      return { ok: true }
    },
    errors(project, id) { return { groups: getRun(project, find(project, id).id)?.logs.groups() ?? [] } },
    async changeFromShell(shellId, taskId, action, allowed) {
      const run = byShell.get(shellId)
      if (!run) return getShells().changeDevelopmentTask(shellId, taskId, action, allowed)
      if (taskId !== `preset:${run.id}` || !['restart', 'stop'].includes(action)) throw new Error(MISSING)
      return act(run.project, run.id, action, { allowed })
    },
    cancelBatches() { for (const batch of batches.values()) batch.abort() },
    suspendReloads() {
      for (const run of runs.values()) {
        suspendReload(run)
        for (const settle of run.waiters) settle()
      }
    },
    resumeReloads() { for (const run of runs.values()) openReload(run) },
    stopReloads() { for (const run of runs.values()) closeReload(run) }
  }
}

function registerRunPresetIpc({ ipcMain, controller, fromMainWindow, isLocked }) {
  // Accept only the command shown to this frame. Keep earlier install approvals for this batch retry.
  const confirms = new Map()
  // Keep the text displayed by the send dialog if the run changes while it is open.
  let pendingPreview
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
  handle('run-presets-save', (project, allowed, _frame, preset) => controller.save(project, preset, allowed))
  handle('run-presets-delete', (project, allowed, _frame, id) => controller.remove(project, id, allowed))
  handle('run-presets-reorder', (project, _allowed, _frame, ids) => controller.reorder(project, ids))
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
    return withConfirmation(project, allowed, frame, action, id, config, approve => controller.act(project, id, action, { allowed, approve }))
  })
  handle('run-preset-start-all', (project, allowed, frame, config) => withConfirmation(project, allowed, frame, 'start-all', null, config,
    approve => controller.startAll(project, allowed, approve)))
  handle('run-preset-stop-all', (project, allowed) => controller.stopAll(project, allowed))
  handle('run-preset-errors', (project, _allowed, _frame, id) => controller.errors(project, id))
  handle('run-preset-send-preview', (project, _allowed, frame, id) => {
    const text = controller.sendPreview(project, id)
    pendingPreview = { frame, key: previewKey(project, id), text }
    return { text }
  })
  handle('run-preset-send', async (project, allowed, frame, id, agentId, note) => {
    const preview = pendingPreview?.frame === frame && pendingPreview.key === previewKey(project, id) ? pendingPreview : undefined
    const result = await controller.send(project, id, agentId, note, allowed, preview?.text)
    if (pendingPreview === preview) pendingPreview = undefined
    return result
  })
  return { clearConfirmations() { confirms.clear(); pendingPreview = undefined } }
}

module.exports = { createRunPresets, registerRunPresetIpc, resolveProject, withSubject }
