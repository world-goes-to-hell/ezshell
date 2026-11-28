// Which agent changed which uncommitted file (docs/plan/2026-11-28-agent-file-owners.md). Several agents work
// in the same folder; the workspace panel's change list shows, per file, the agents that wrote it.
// The hooks never send a tool's arguments (file paths included) to main (docs/architecture/agent-hooks.md),
// so the path comes from watching the repository and the agent from the time: a file that changed while
// one agent had a tool open belongs to that agent.
// Also (user decisions of 2026-11-28): the agent that changes a file another agent changed before is told
// once, and a frozen repository is announced to its agents (nothing is blocked).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const fs = require('fs')
const path = require('path')

// The installed and generated folders of src/localFiles/search.js (SKIPPED_DIRS), and Git's own folder
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'bower_components', '.gradle', 'build', 'dist', 'out', 'target',
  'release', 'coverage', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'obj'])
// Git writes these on a commit, an add or a checkout: the change list is read again then
const GIT_STATE_FILES = new Set(['index', 'head'])
// Tools that write files. Another tool (a shell command) open at the same time loses to these.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const CLOSE_TOOL = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])
const CLOSE_TURN = new Set(['Stop', 'StopFailure', 'SessionEnd', 'Interrupt'])
// The reporter's start time (startedAt) comes after the hook fired, and an async PreToolUse runs beside the
// tool: a write can come before it. A change this long before an opening still counts.
const LEAD_MS = 1500
const TAIL_MS = 300
// Hook reports come late; a change is assigned once the windows around it had time to close
const SETTLE_MS = 3000
const NOTIFY_MS = 500
const GIT_STATE_MS = 1000
const TOOL_KEEP_MS = 60_000
const TOOL_LIMIT = 200
const PENDING_LIMIT = 5000
const FILE_LIMIT = 20_000
const REPO_LIMIT = 8
const REASON_MAX = 200
const AGENT_ID = /^(?:codex|claude)-[1-9]\d{0,8}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const NOTICE = '[ezShell 자동 알림]'

const key = value => (process.platform === 'win32' ? value.toLowerCase() : value)
const inside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
const sameOrInside = (parent, child) => key(parent) === key(child) || inside(parent, child)
const related = (a, b) => sameOrInside(a, b) || sameOrInside(b, a)
const slashed = (top, file) => path.relative(top, file).split(path.sep).join('/')
const defaultWatch = (root, listener) => fs.watch(root, { recursive: true, persistent: false }, listener)

/**
 * `repoTopOf(folder)` is the repository top of a folder (null outside Git), `changedPaths(top)` the paths
 * `git status` lists (relative to the top, `/`), `agentOf(id)` the agent's `{ kind, role? }` now,
 * `listAgents()` the running agents (`{ id, kind, cwd }`), `send(id, text, { urgent })` a message to one of
 * them (from the user: the user froze the repository) and `notify(top)` tells the window a repository changed.
 */
function createAgentFileOwners({ repoTopOf, changedPaths, agentOf = () => null, listAgents = () => [], send = async () => {},
  notify = () => {}, watch = defaultWatch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const agents = new Map() // id → { kind, cwd, top, tools: Map(toolUseId → { start, end, edit }), turns: [{ start, end }] }
  const repos = new Map() // key(top) → { top, watcher, pending: [{ file, at }], timer, gitTimer }
  const files = new Map() // key(absolute path) → { file, owners: Map(id → lastAt), uncertain, told: Set('a>b') }
  const freezes = new Map() // key(top) → { top, since, except, reason, warned: Set(id) }
  const notices = new Map() // key(top) → timer
  let generation = 0

  const nameOf = id => {
    const role = agentOf(id)?.role
    return role ? `${role}(${id})` : id
  }
  const deliver = (id, text, urgent = false) => Promise.resolve().then(() => send(id, text, { urgent })).catch(() => {})

  function agentRecord(id, kind, cwd) {
    let agent = agents.get(id)
    if (!agent || agent.cwd !== cwd) {
      agent = { kind, cwd, top: null, tools: agent?.tools ?? new Map(), turns: agent?.turns ?? [] }
      agents.set(id, agent)
      const started = generation
      Promise.resolve(repoTopOf(cwd)).then(top => {
        if (started !== generation || agents.get(id) !== agent || !top) return
        agent.top = path.normalize(top)
        watchRepo(agent.top)
      }, () => {})
    }
    return agent
  }

  function watchRepo(top) {
    if (repos.has(key(top))) return
    if (repos.size >= REPO_LIMIT) closeRepo(repos.keys().next().value)
    const repo = { top, watcher: null, pending: [], timer: null, gitTimer: null }
    repos.set(key(top), repo)
    try {
      repo.watcher = watch(top, (_type, name) => changed(repo, name))
      repo.watcher.on?.('error', () => closeRepo(key(top)))
    } catch {
      repos.delete(key(top))
    }
  }

  function closeRepo(repoKey) {
    const repo = repos.get(repoKey)
    if (!repo) return
    repos.delete(repoKey)
    try { repo.watcher?.close() } catch {}
    if (repo.timer) clearTimer(repo.timer)
    if (repo.gitTimer) clearTimer(repo.gitTimer)
  }

  function changed(repo, name) {
    if (typeof name !== 'string' || !name) return
    const parts = name.split(/[\\/]/).filter(Boolean)
    if (parts.length === 2 && parts[0].toLowerCase() === '.git' && GIT_STATE_FILES.has(parts[1].toLowerCase())) return gitChanged(repo)
    if (!parts.length || parts.some(part => IGNORED_DIRS.has(part.toLowerCase()) || part === '..')) return
    if (repo.pending.length >= PENDING_LIMIT) return
    const file = path.join(repo.top, ...parts)
    const at = now()
    const last = repo.pending.at(-1)
    if (last && last.file === file && at - last.at < 50) return
    repo.pending.push({ file, at })
    schedule(repo)
  }

  // A commit takes files off the change list without touching them: forget their owners right away, so the
  // next agent to change one is not told about a change that is already committed
  function gitChanged(repo) {
    if (repo.gitTimer) return
    repo.gitTimer = setTimer(() => {
      repo.gitTimer = null
      const started = generation
      Promise.resolve(changedPaths(repo.top)).then(paths => {
        if (started === generation && forgetCommitted(repo.top, paths)) announce(repo.top)
      }, () => {})
    }, GIT_STATE_MS)
  }

  /** Drop the records under `top` that `git status` (`paths`) no longer lists; true when one went */
  function forgetCommitted(top, paths) {
    const listed = new Set(paths.map(key))
    const folders = paths.filter(file => file.endsWith('/')).map(key)
    let dropped = false
    for (const [fileKey, record] of files) {
      if (!inside(top, record.file)) continue
      const relative = key(slashed(top, record.file))
      // A nested repository shows as one `sub/` line: its files are its own repository's to judge
      if (listed.has(relative) || folders.some(folder => relative.startsWith(folder))) continue
      files.delete(fileKey)
      dropped = true
    }
    return dropped
  }

  function schedule(repo) {
    if (repo.timer || !repo.pending.length) return
    repo.timer = setTimer(() => {
      repo.timer = null
      settle(repo)
      schedule(repo)
    }, SETTLE_MS)
  }

  const covers = (start, end, at) => start - LEAD_MS <= at && at <= (end ?? Infinity) + TAIL_MS

  /** The agents that may have written a file at `at` in this repository */
  function candidates(repo, file, at) {
    const here = [...agents].filter(([, agent]) => agent.top && (key(agent.top) === key(repo.top) || inside(agent.top, file) || inside(repo.top, agent.top)))
    const byTool = here.filter(([, agent]) => [...agent.tools.values()].some(tool => covers(tool.start, tool.end, at)))
    const editing = byTool.filter(([, agent]) => [...agent.tools.values()].some(tool => tool.edit && covers(tool.start, tool.end, at)))
    const found = editing.length ? editing : byTool.length ? byTool
      : here.filter(([, agent]) => agent.turns.some(turn => covers(turn.start, turn.end, at)))
    return found.map(([id]) => id)
  }

  function settle(repo) {
    const due = now() - SETTLE_MS
    const keep = []
    const overlaps = []
    let touched = false
    for (const change of repo.pending) {
      if (change.at > due) { keep.push(change); continue }
      const ids = candidates(repo, change.file, change.at)
      if (!ids.length) continue
      const fileKey = key(change.file)
      let record = files.get(fileKey)
      if (!record) {
        if (files.size >= FILE_LIMIT) files.delete(files.keys().next().value)
        record = { file: change.file, owners: new Map(), uncertain: false, told: new Set() }
        files.set(fileKey, record)
      }
      // Only a sure answer tells an agent anything: a guess could name the wrong one
      if (ids.length === 1) {
        const [id] = ids
        const before = [...record.owners.keys()].filter(other => other !== id && !record.told.has(`${other}>${id}`))
        if (before.length) overlaps.push({ record, id, before })
        warnFrozen(change.file, id)
      }
      for (const id of ids) record.owners.set(id, Math.max(record.owners.get(id) ?? 0, change.at))
      record.uncertain = ids.length > 1
      touched = true
    }
    repo.pending = keep
    if (touched) announce(repo.top)
    if (overlaps.length) void tellOverlaps(repo.top, overlaps)
  }

  // The agent that just changed a file another agent changed before (still uncommitted): once per pair and file
  async function tellOverlaps(top, overlaps) {
    const started = generation
    const paths = await Promise.resolve(changedPaths(top)).catch(() => null)
    if (!paths || started !== generation) return
    forgetCommitted(top, paths)
    const listed = new Set(paths.map(key))
    const byAgent = new Map()
    for (const { record, id, before } of overlaps) {
      if (files.get(key(record.file)) !== record || !listed.has(key(slashed(top, record.file)))) continue
      const others = before.filter(other => record.owners.has(other) && !record.told.has(`${other}>${id}`))
      if (!others.length) continue
      for (const other of others) record.told.add(`${other}>${id}`)
      const lines = byAgent.get(id) ?? []
      lines.push(`- \`${slashed(top, record.file)}\`: ${others.map(nameOf).join(', ')}`)
      byAgent.set(id, lines)
    }
    for (const [id, lines] of byAgent) {
      deliver(id, `${NOTICE} 방금 고친 파일을 커밋 전에 다른 에이전트도 고쳤습니다 (저장소 \`${top}\`).\n${lines.slice(0, 20).join('\n')}\n` +
        '그쪽 변경을 덮어쓰지 않았는지 확인하고, 필요하면 그 에이전트와 조율해 주세요.')
    }
  }

  function freezeOf(file) {
    return [...freezes.values()].find(freeze => sameOrInside(freeze.top, file)) ?? null
  }

  // An agent that changed a file of a frozen repository is told again, once per freeze
  function warnFrozen(file, id) {
    const freeze = freezeOf(file)
    if (!freeze || freeze.except === id || freeze.warned.has(id)) return
    freeze.warned.add(id)
    deliver(id, `${NOTICE} 저장소 \`${freeze.top}\` 는 동결 중인데 \`${slashed(freeze.top, file)}\` 이 바뀌었습니다. ` +
      '해제 알림이 올 때까지 이 저장소의 파일을 고치지 말아 주세요.', true)
  }

  function freezeInfo(freeze) {
    if (!freeze) return null
    const except = freeze.except ? { id: freeze.except, ...(agentOf(freeze.except)?.role ? { role: agentOf(freeze.except).role } : {}) } : null
    return { since: freeze.since, ...(except ? { except } : {}), ...(freeze.reason ? { reason: freeze.reason } : {}) }
  }

  /** The running agents whose working folder is in (or holds) this repository, but `except` */
  async function agentsOf(top, except) {
    const found = []
    for (const agent of listAgents()) {
      if (!agent || agent.id === except || !AGENT_ID.test(agent.id) || typeof agent.cwd !== 'string' || !path.isAbsolute(agent.cwd)) continue
      const theirs = await Promise.resolve(repoTopOf(agent.cwd)).catch(() => null)
      if (theirs && related(path.normalize(theirs), top)) found.push(agent.id)
    }
    return found
  }

  function announce(top) {
    const topKey = key(top)
    if (notices.has(topKey)) return
    notices.set(topKey, setTimer(() => {
      notices.delete(topKey)
      notify(top)
    }, NOTIFY_MS))
  }

  function prune(agent, at) {
    for (const [id, tool] of agent.tools) if (tool.end !== null && at - tool.end > TOOL_KEEP_MS) agent.tools.delete(id)
    while (agent.tools.size > TOOL_LIMIT) agent.tools.delete(agent.tools.keys().next().value)
    agent.turns = agent.turns.filter(turn => turn.end === null || at - turn.end <= TOOL_KEEP_MS).slice(-20)
  }

  return {
    /** An accepted hook report of an agent working in `cwd` (localShell.reportAgentHook took it) */
    hook(id, { kind, cwd, report }) {
      if (typeof id !== 'string' || typeof cwd !== 'string' || !path.isAbsolute(cwd) || !report || report.subagent) return
      const agent = agentRecord(id, kind, cwd)
      const { event, startedAt: at, toolUseId, tool } = report
      if (event === 'PreToolUse' && toolUseId) {
        if (!agent.tools.has(toolUseId)) agent.tools.set(toolUseId, { start: at, end: null, edit: EDIT_TOOLS.has(tool) })
      } else if (CLOSE_TOOL.has(event) && toolUseId) {
        const open = agent.tools.get(toolUseId)
        if (open && at >= open.start) open.end = at
      } else if (event === 'UserPromptSubmit') {
        agent.turns.push({ start: at, end: null })
      } else if (CLOSE_TURN.has(event)) {
        for (const turn of agent.turns) if (turn.end === null && at >= turn.start) turn.end = at
        for (const open of agent.tools.values()) if (open.end === null && at >= open.start) open.end = at
      }
      prune(agent, now())
    },

    /** The uncommitted files of a repository top with the agents that changed them (newest first), and its freeze */
    async owners(top) {
      const base = path.normalize(top)
      const paths = await changedPaths(base)
      forgetCommitted(base, paths)
      const listed = new Map(paths.map(file => [key(file), file]))
      const result = []
      for (const record of files.values()) {
        if (!inside(base, record.file)) continue
        const shown = listed.get(key(slashed(base, record.file)))
        if (!shown) continue
        const owners = [...record.owners].sort((a, b) => b[1] - a[1]).map(([id, lastAt]) => {
          const agent = agentOf(id) ?? { kind: agents.get(id)?.kind }
          return { id, kind: agent.kind, ...(agent.role ? { role: agent.role } : {}), lastAt }
        }).filter(owner => owner.kind === 'claude' || owner.kind === 'codex')
        if (owners.length) result.push({ path: shown, agents: owners, uncertain: record.uncertain })
      }
      result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return { owners: result, freeze: freezeInfo(freezeOf(base)) }
    },

    /**
     * The user freezes a repository top (a merge): its other agents get an urgent message to stop changing
     * files, and one when it thaws. Nothing is blocked. `except` is the agent that keeps working.
     */
    async freeze(top, { frozen, except, reason } = {}) {
      const base = path.normalize(top)
      if (typeof frozen !== 'boolean') throw new Error('동결 여부를 확인해 주세요.')
      if (except !== undefined && except !== null && (typeof except !== 'string' || !AGENT_ID.test(except))) throw new Error('예외 에이전트를 확인해 주세요.')
      if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > REASON_MAX || CONTROL.test(reason))) {
        throw new Error(`이유는 ${REASON_MAX}자 이내 한 줄로 써 주세요.`)
      }
      const current = freezes.get(key(base))
      if (frozen) {
        const freeze = { top: base, since: current?.since ?? now(), except: except || null, reason: reason?.trim() || null, warned: new Set() }
        freezes.set(key(base), freeze)
        const keep = freeze.except ? ` ${nameOf(freeze.except)} 만 계속 작업합니다.` : ''
        const why = freeze.reason ? ` 이유: ${freeze.reason}` : ''
        for (const id of await agentsOf(base, freeze.except)) {
          deliver(id, `${NOTICE} 사용자가 저장소 \`${base}\` 를 동결했습니다.${keep}${why} ` +
            '해제 알림이 올 때까지 이 저장소의 파일을 고치지 말아 주세요 (읽기·조사·테스트는 괜찮습니다). 고치던 중이면 지금 멈추고, 이미 바꾼 것은 그대로 두세요.', true)
        }
      } else if (current) {
        freezes.delete(key(base))
        for (const id of await agentsOf(base, current.except)) {
          deliver(id, `${NOTICE} 저장소 \`${base}\` 의 동결이 풀렸습니다. 다시 파일을 고쳐도 됩니다.`)
        }
      }
      announce(base)
      return { freeze: freezeInfo(freezes.get(key(base))) }
    },

    /** Lock: forget who changed what and stop watching */
    clear() {
      generation++
      for (const repoKey of [...repos.keys()]) closeRepo(repoKey)
      for (const timer of notices.values()) clearTimer(timer)
      notices.clear()
      agents.clear()
      files.clear()
      // A freeze stays: its agents were told, and only the user's thaw tells them again
    }
  }
}

module.exports = { createAgentFileOwners, EDIT_TOOLS }
