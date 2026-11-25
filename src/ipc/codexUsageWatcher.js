const fs = require('fs')
const os = require('os')
const path = require('path')
const { readLinesFromStart, readLinesFromEnd } = require('../agentHistory/boundedRead.js')
const { codexUsageFromTokenCount } = require('./agentUsage.js')

// Codex writes its usage (subscription windows, context) to its session file as `token_count` events.
// For each Codex agent ezShell launched, the file is the one Codex starts in the agent's folder after
// the agent started (and no other agent took). It is read only when it grew, from its end.

const INTERVAL_MS = 3000
const EARLY_MS = 5000
// A resumed session's file is looked for this many day folders back, and again this often when not found
const RESUME_SEARCH_DAYS = 400
const RESUME_RETRY_MS = 30000
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = value => typeof value === 'string' && SESSION_ID.test(value) ? value.toLowerCase() : null
const TAIL_BYTES = 256 * 1024
const ROLE_HEADER_BYTES = 256 * 1024
const TURN_CONTEXT_LOOKBACK_BYTES = 2 * 1024 * 1024
const TURN_STATUS = { task_started: 'working', task_complete: 'idle', turn_aborted: 'idle' }
const pad = n => String(n).padStart(2, '0')
const dayParts = date => [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())]
const modelFromContext = line => line.type === 'turn_context' && typeof line.payload?.model === 'string' ? line.payload.model.trim() : null

/** Codex files sessions by local date: the start day (and the day before, near midnight) up to today */
function dayFolders(startedAt, now) {
  const days = []
  const day = new Date(startedAt - 86400_000)
  day.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  for (let guard = 0; day <= end && guard < 7; guard++) {
    days.push(dayParts(day))
    day.setDate(day.getDate() + 1)
  }
  return days
}

const sameFolder = (a, b, platform) => {
  const norm = value => {
    const text = path.normalize(String(value ?? '')).replace(/[\\/]+$/, '')
    return platform === 'win32' ? text.toLowerCase() : text
  }
  return norm(a) === norm(b)
}

function sameRoleFolder(a, b, platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  return typeof a === 'string' && typeof b === 'string' &&
    paths.isAbsolute(a) && paths.isAbsolute(b) && paths.relative(a, b) === ''
}

async function sessionMeta(file) {
  let meta = null
  await readLinesFromStart(file, line => {
    if (line.type === 'session_meta') meta = line.payload ?? null
    return true
  }, { maxBytes: 256 * 1024 })
  return meta
}

const exactStats = { bigint: true }
const sameIdentity = (a, b) => a.ino > 0n && a.dev === b.dev && a.ino === b.ino
const sameFile = (a, b) => a.file === b.file && sameIdentity(a, b)
const isSubagent = meta => meta?.thread_source === 'subagent' || meta?.source?.subagent || meta?.source?.sub_agent

// Read the first JSONL record from the exact file whose identity was checked. Keep the handle
// open until useHeader finishes so the final check can revalidate the name before committing.
async function readRoleHeader(file, expected, useHeader = meta => meta) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const stat = await handle.stat(exactStats)
    if (!stat.isFile() || !sameIdentity(stat, expected)) return null
    const buffer = Buffer.alloc(Math.min(Number(stat.size), ROLE_HEADER_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end < 0) return null
    const line = JSON.parse(buffer.toString('utf8', 0, end))
    if (line?.type !== 'session_meta' || !line.payload) return null
    return await useHeader(line.payload, stat)
  } finally {
    await handle.close()
  }
}

function createCodexUsageWatcher({ agents, setUsage, setVerifiedSession = () => {}, setFreshRoleSession = () => false,
  freshRoleEpoch = () => 0, setTurnStatus = () => {}, codexHome, now = () => Date.now(), platform = process.platform, env = process.env }) {
  const home = codexHome ?? (env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(os.homedir(), '.codex'))
  // agent id → { file, size }
  const bound = new Map()
  const verified = new Map()
  const freshRoles = new Map()
  // Agents whose resumed session file was not found yet: which ID was checked and when
  const missed = new Map()
  let timer = null
  let running = false

  async function findFiles(agent, taken, strict = false) {
    const candidates = []
    const matchesFolder = strict ? sameRoleFolder : sameFolder
    const until = now()
    const earliest = agent.startedAt - (strict ? 0 : EARLY_MS)
    const days = dayFolders(agent.startedAt, until)
    if (strict && days.at(-1)?.join('/') !== dayParts(new Date(until)).join('/')) return null
    for (const parts of days) {
      const dir = path.join(home, 'sessions', ...parts)
      let names
      try { names = await fs.promises.readdir(dir) } catch (error) {
        if (strict && error.code !== 'ENOENT') return null
        continue
      }
      for (const name of names) {
        if (!/^rollout-.+\.jsonl$/.test(name)) continue
        const file = path.join(dir, name)
        if (!strict && taken.has(file)) continue
        try {
          const stat = await (strict ? fs.promises.lstat(file, exactStats) : fs.promises.stat(file))
          if (!stat.isFile() || (!strict && stat.mtimeMs < earliest)) continue
          const meta = strict ? await readRoleHeader(file, stat) : await sessionMeta(file)
          const created = Date.parse(meta?.timestamp ?? '')
          // A child can have the exact same cwd and a newer timestamp than a newly started CLI.
          if (isSubagent(meta)) continue
          // The CLI can create the file before writing the first complete line.
          if (strict && (typeof meta?.cwd !== 'string' || !Number.isFinite(created) || created > until)) return null
          if (typeof meta?.cwd !== 'string' || !matchesFolder(meta.cwd, agent.cwd, platform) || !(created >= earliest)) continue
          const fileId = name.slice(-42, -6).toLowerCase()
          const roleId = uuid(meta.id) === fileId && name.toLowerCase().endsWith(`-${fileId}.jsonl`) ? fileId : null
          const owner = strict ? taken.get(file) : null
          if (owner && sameIdentity(owner, stat) && roleId && uuid(owner.id) === roleId) continue
          candidates.push({ file, created, id: meta.id, roleId, dev: stat.dev, ino: stat.ino })
        } catch {
          if (strict) return null
        }
      }
    }
    candidates.sort((a, b) => a.created - b.created)
    return candidates
  }

  function roleEvidence(agent, resumeId) {
    if (resumeId || agent.sleeping || !Number.isSafeInteger(agent.roleStartedAt) || agent.roleStartedAt <= 0 ||
        !sameRoleFolder(agent.roleCwd, agent.cwd, platform)) return null
    let evidence = freshRoles.get(agent.id)
    if (!evidence || evidence.startedAt !== agent.roleStartedAt || evidence.shellId !== agent.shellId) {
      evidence = { startedAt: agent.roleStartedAt, shellId: agent.shellId, cwd: agent.roleCwd, candidate: null, rejected: false, confirmed: false }
      freshRoles.set(agent.id, evidence)
    }
    if (!sameRoleFolder(evidence.cwd, agent.roleCwd, platform)) evidence.rejected = true
    return evidence
  }

  async function observeRoleCandidates(agent, evidence) {
    // Search by launch time and cwd, independently of the hook UUID. Usage-only assignments
    // still count toward ambiguity until the other agent's session has been verified.
    const taken = new Map()
    for (const [id, item] of bound) {
      if (id === agent.id) continue
      const explicitlyResumed = item.resumeId && verified.get(id) === item.resumeId && uuid(item.id) === item.resumeId
      const other = freshRoles.get(id)
      const confirmedFresh = other?.confirmed && !other.rejected && sameFile(item, other.candidate)
      if (explicitlyResumed || confirmedFresh) taken.set(item.file, item)
    }
    const files = await findFiles({ cwd: evidence.cwd, startedAt: evidence.startedAt }, taken, true)
    if (!files) return false
    const [candidate] = files
    if (files.length > 1 || (candidate && !candidate.roleId) ||
        (evidence.candidate && (!candidate || !sameFile(evidence.candidate, candidate) || evidence.candidate.roleId !== candidate.roleId))) {
      evidence.rejected = true
    } else if (candidate) {
      evidence.candidate = candidate
    }
    return true
  }

  async function confirmFreshRoles(checkedHooks, epoch) {
    for (const [id, hookId] of checkedHooks) {
      if (freshRoleEpoch() !== epoch) return
      const evidence = freshRoles.get(id)
      const candidate = evidence?.candidate
      if (!candidate || evidence.rejected || evidence.confirmed || hookId !== candidate.roleId) continue
      const entry = bound.get(id)
      if (!entry || !sameFile(entry, candidate) || uuid(entry.id) !== candidate.roleId) continue
      try {
        const valid = await readRoleHeader(candidate.file, candidate, async (meta, stat) => {
          if (isSubagent(meta) || uuid(meta.id) !== candidate.roleId ||
              !sameRoleFolder(meta.cwd, evidence.cwd, platform) ||
              Date.parse(meta.timestamp) !== candidate.created) return false
          const named = await fs.promises.lstat(candidate.file, exactStats)
          if (!named.isFile() || !sameIdentity(named, stat)) return false
          if (freshRoleEpoch() !== epoch) return true
          const live = agents().filter(agent => agent.kind === 'codex' && agent.active && agent.shellId)
          const agent = live.find(item => item.id === id)
          if (!agent || agent.sleeping || agent.resumeId || agent.roleStartedAt !== evidence.startedAt ||
              agent.shellId !== evidence.shellId || !sameRoleFolder(agent.roleCwd, evidence.cwd, platform) ||
              !sameRoleFolder(agent.cwd, evidence.cwd, platform) || uuid(agent.hookSessionId) !== hookId) return true
          if (live.some(other => other.id !== id && (
            bound.get(other.id)?.file === candidate.file ||
            uuid(other.resumeId) === candidate.roleId || uuid(other.hookSessionId) === candidate.roleId
          ))) return true
          evidence.confirmed = setFreshRoleSession(id, candidate.roleId, evidence.startedAt, epoch) === true
          return true
        })
        if (!valid) evidence.rejected = true
      } catch { /* the file can disappear before the final recheck */ }
    }
  }

  /**
   * The file of a resumed session (codex resume writes on in its old file, made long before this agent
   * started), found by the id in its name: newest day folders first, up to a year back. Matching it by
   * time instead took the new file of another Codex in the same folder (2026-11-19).
   */
  async function findResumed(id) {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return null
    const sessions = path.join(home, 'sessions')
    const newestFirst = async dir => (await fs.promises.readdir(dir).catch(() => [])).filter(name => /^\d+$/.test(name)).sort().reverse()
    let days = 0
    for (const year of await newestFirst(sessions)) {
      for (const month of await newestFirst(path.join(sessions, year))) {
        for (const day of await newestFirst(path.join(sessions, year, month))) {
          if (++days > RESUME_SEARCH_DAYS) return null
          const dir = path.join(sessions, year, month, day)
          const names = await fs.promises.readdir(dir).catch(() => [])
          const name = names.find(item => item.startsWith('rollout-') && item.toLowerCase().endsWith(`-${id.toLowerCase()}.jsonl`))
          if (name) {
            const file = path.join(dir, name)
            const meta = await sessionMeta(file).catch(() => null)
            if (typeof meta?.id === 'string' && meta.id.toLowerCase() === id.toLowerCase()) {
              return { file, id: id.toLowerCase() }
            }
          }
        }
      }
    }
    return null
  }

  /** Read usage and, for an explicitly resumed session, the latest root turn event. */
  async function readSession({ file, id, resumeId, size: previousSize }, size) {
    const lines = (await readLinesFromEnd(file, { maxBytes: TAIL_BYTES })) ?? []
    const turnStatus = line => {
      const payload = line.payload
      if (line.type !== 'event_msg' || !Object.hasOwn(TURN_STATUS, payload?.type)) return null
      if (payload.root_turn_id && payload.root_turn_id !== payload.turn_id) return null
      return TURN_STATUS[payload.type]
    }
    let turn
    let turnId
    const readTurn = line => {
      const status = turnStatus(line)
      if (!status) return
      const at = Date.parse(line.timestamp)
      const eventTurnId = line.payload.turn_id
      if (status === 'idle' && turn?.status === 'working' && turnId && eventTurnId && turnId !== eventTurnId) return
      if (turn && at < turn.at) return
      turnId = eventTurnId
      turn = Number.isFinite(at) ? { status, at } : null
    }
    let model = null
    let effort = null
    const readContext = line => {
      if (line.type !== 'turn_context') return
      const nextModel = modelFromContext(line)
      if (nextModel && nextModel !== model) {
        model = nextModel
        effort = null
      }
      if (typeof line.payload?.effort === 'string' && line.payload.effort.trim()) effort = line.payload.effort
    }
    const grewBy = size - Math.max(previousSize, 0)
    const lookForContext = grewBy > TAIL_BYTES && !lines.some(modelFromContext)
    const lookForTurn = resumeId && grewBy > TAIL_BYTES && !lines.some(turnStatus)
    if (lookForContext || lookForTurn) {
      // A resumed session or a large append can have settings just before the usage window.
      // Start at the previous newline when available, so the first newly appended record is read.
      await readLinesFromStart(file, line => {
        if (lookForContext) readContext(line)
        if (lookForTurn) readTurn(line)
      }, {
        start: Math.max(0, previousSize - 1, size - TURN_CONTEXT_LOOKBACK_BYTES),
        end: size - 1,
        matchLine: line => (lookForContext && line.includes('"turn_context"'))
          || (lookForTurn && /"(?:task_started|task_complete|turn_aborted)"/.test(line))
      })
    }
    let usage = null
    for (const line of lines) {
      readContext(line)
      if (resumeId) readTurn(line)
      if (line.type === 'event_msg' && line.payload?.type === 'token_count' && line.payload.rate_limits) usage = line.payload
    }
    // An oversized append or a replaced file can leave a gap in the turn history.
    if (!turn && (grewBy > TURN_CONTEXT_LOOKBACK_BYTES || size < previousSize)) turn = null
    return { usage: codexUsageFromTokenCount(usage ?? {}, model, effort, id), turn }
  }

  async function tick() {
    if (running) return
    running = true
    try {
      const live = agents().filter(agent => agent.kind === 'codex' && agent.active && agent.shellId && agent.cwd && agent.startedAt)
      const epoch = freshRoleEpoch()
      const resumeCounts = new Map()
      const checkedHooks = new Map()
      for (const { resumeId, sleeping } of live) {
        if (typeof resumeId === 'string' && !sleeping) {
          const id = resumeId.toLowerCase()
          resumeCounts.set(id, (resumeCounts.get(id) ?? 0) + 1)
        }
      }
      const liveIds = new Set(live.map(agent => agent.id))
      for (const id of bound.keys()) if (!liveIds.has(id)) bound.delete(id)
      for (const id of verified.keys()) if (!liveIds.has(id)) verified.delete(id)
      for (const id of missed.keys()) if (!liveIds.has(id)) missed.delete(id)
      for (const id of freshRoles.keys()) if (!liveIds.has(id)) freshRoles.delete(id)
      // Earlier agents pick first, so two Codex started in one folder get their own files in order
      for (const agent of [...live].sort((a, b) => a.startedAt - b.startedAt)) {
        const resumeId = typeof agent.resumeId === 'string' ? agent.resumeId.toLowerCase() : null
        const hookId = uuid(agent.hookSessionId)
        const targetId = hookId ?? resumeId
        const role = roleEvidence(agent, resumeId)
        if (verified.get(agent.id) !== resumeId) verified.delete(agent.id)
        let entry = bound.get(agent.id)
        if (entry && (entry.resumeId !== resumeId || (targetId && uuid(entry.id) !== targetId) || (entry.targetId && !targetId))) {
          if (role) role.rejected = true // the usage watcher had to reselect the file
          bound.delete(agent.id)
          entry = undefined
        }
        if (epoch !== null && role && !role.rejected && !role.confirmed && hookId) {
          const complete = await observeRoleCandidates(agent, role)
          if (complete) checkedHooks.set(agent.id, hookId)
        }
        if (!entry) {
          // A resumed session not found: look again only now and then (the search walks the day folders)
          const previous = missed.get(agent.id)
          if (targetId && previous?.targetId === targetId && now() - previous.at < RESUME_RETRY_MS) continue
          const taken = new Set([...bound.values()].map(item => item.file))
          const found = targetId ? await findResumed(targetId) : (await findFiles(agent, taken))[0]
          if (!found) {
            if (targetId) missed.set(agent.id, { targetId, at: now() })
            continue
          }
          if (epoch !== null && role && !hookId && !role.rejected && !role.candidate) await observeRoleCandidates(agent, role)
          missed.delete(agent.id)
          entry = { file: found.file, id: found.id, size: -1, resumeId, targetId }
          bound.set(agent.id, entry)
        }
        const stat = await fs.promises.stat(entry.file, exactStats).catch(() => null)
        const size = Number(stat?.size)
        if (role && entry.ino !== undefined && stat &&
            (entry.dev !== stat.dev || entry.ino !== stat.ino || size < entry.size)) role.rejected = true
        if (!stat?.isFile() || (targetId && entry.ino !== undefined &&
          (entry.dev !== stat.dev || entry.ino !== stat.ino || size < entry.size))) {
          if (entry.canReportTurn) setTurnStatus(agent.shellId, agent.id, entry.id, null)
          if (entry.id === resumeId) verified.delete(agent.id)
          if (role) role.rejected = true
          bound.delete(agent.id)
          continue
        }
        entry.dev = stat.dev
        entry.ino = stat.ino
        const explicitSession = resumeId && entry.id === resumeId
        if (explicitSession) {
          verified.set(agent.id, resumeId)
          setVerifiedSession(agent.id, resumeId)
        }
        const canReportTurn = explicitSession && !agent.sleeping && resumeCounts.get(resumeId) === 1
        const refreshTurn = canReportTurn && !entry.canReportTurn
        if (entry.canReportTurn && !canReportTurn) setTurnStatus(agent.shellId, agent.id, entry.id, null)
        entry.canReportTurn = canReportTurn
        if (size === entry.size && !refreshTurn) continue
        const { usage, turn } = await readSession({ ...entry, resumeId: canReportTurn ? resumeId : null, size: refreshTurn ? -1 : entry.size }, size)
        // Wait for the next poll if the writer appended another event during this read.
        if (canReportTurn && turn !== undefined) {
          const latest = await fs.promises.stat(entry.file, exactStats).catch(() => null)
          if (latest?.size !== stat.size || latest.mtimeNs !== stat.mtimeNs || latest.ino !== stat.ino || latest.dev !== stat.dev) {
            if (refreshTurn) entry.canReportTurn = false
            continue
          }
          if (!turn || turn.at <= now()) setTurnStatus(agent.shellId, agent.id, entry.id, turn)
        }
        entry.size = size
        if (usage) setUsage(agent.id, usage)
      }
      if (checkedHooks.size) await confirmFreshRoles(checkedHooks, epoch)
    } finally {
      running = false
    }
  }

  return {
    tick,
    /** The session file found for an agent (the chat view follows it), or null */
    fileOf(agentId, sessionId) {
      const entry = bound.get(agentId)
      return entry && (!sessionId || entry.id === sessionId) ? entry.file : null
    },
    /** A time-based match is insufficient for resuming a conversation. */
    verifiedSessionOf: agentId => verified.get(agentId) ?? null,
    start() {
      if (timer) return
      timer = setInterval(() => { void tick().catch(() => {}) }, INTERVAL_MS)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
      bound.clear()
      freshRoles.clear()
    }
  }
}

module.exports = { createCodexUsageWatcher, dayFolders, sessionMeta }
