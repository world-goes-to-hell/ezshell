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
const TAIL_BYTES = 256 * 1024
const TURN_CONTEXT_LOOKBACK_BYTES = 2 * 1024 * 1024
const pad = n => String(n).padStart(2, '0')
const modelFromContext = line => line.type === 'turn_context' && typeof line.payload?.model === 'string' ? line.payload.model.trim() : null

/** Codex files sessions by local date: the start day (and the day before, near midnight) up to today */
function dayFolders(startedAt, now) {
  const days = []
  const day = new Date(startedAt - 86400_000)
  day.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  for (let guard = 0; day <= end && guard < 7; guard++) {
    days.push([String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())])
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

async function sessionMeta(file) {
  let meta = null
  await readLinesFromStart(file, line => {
    if (line.type === 'session_meta') meta = line.payload ?? null
    return true
  }, { maxBytes: 256 * 1024 })
  return meta
}

function createCodexUsageWatcher({ agents, setUsage, setVerifiedSession = () => {}, codexHome, now = () => Date.now(), platform = process.platform, env = process.env }) {
  const home = codexHome ?? (env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(os.homedir(), '.codex'))
  // agent id → { file, size }
  const bound = new Map()
  // Agents whose resumed session file was not found yet: which ID was checked and when
  const missed = new Map()
  let timer = null
  let running = false

  async function findFile(agent, taken) {
    const candidates = []
    for (const parts of dayFolders(agent.startedAt, now())) {
      const dir = path.join(home, 'sessions', ...parts)
      let names
      try { names = await fs.promises.readdir(dir) } catch { continue }
      for (const name of names) {
        if (!/^rollout-.+\.jsonl$/.test(name)) continue
        const file = path.join(dir, name)
        if (taken.has(file)) continue
        try {
          const stat = await fs.promises.stat(file)
          if (stat.mtimeMs < agent.startedAt - EARLY_MS) continue
          const meta = await sessionMeta(file)
          const created = Date.parse(meta?.timestamp ?? '')
          // A child can have the exact same cwd and a newer timestamp than a newly started CLI.
          if (meta?.thread_source === 'subagent' || meta?.source?.subagent || meta?.source?.sub_agent) continue
          if (!meta || !sameFolder(meta.cwd, agent.cwd, platform) || !(created >= agent.startedAt - EARLY_MS)) continue
          candidates.push({ file, created, id: meta.id })
        } catch { /* gone or unreadable */ }
      }
    }
    candidates.sort((a, b) => a.created - b.created)
    return candidates[0] ?? null
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
          if (name) return { file: path.join(dir, name), id }
        }
      }
    }
    return null
  }

  /** The last usage in the file; before the first answer just the session (its id lets a restart resume it) */
  async function readUsage(file, sessionId, size, previousSize) {
    const lines = (await readLinesFromEnd(file, { maxBytes: TAIL_BYTES })) ?? []
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
    if (size - Math.max(previousSize, 0) > TAIL_BYTES && !lines.some(modelFromContext)) {
      // A resumed session or a large append can have settings just before the usage window.
      // Start at the previous newline when available, so the first newly appended record is read.
      await readLinesFromStart(file, readContext, {
        start: Math.max(0, previousSize - 1, size - TURN_CONTEXT_LOOKBACK_BYTES),
        end: size - 1,
        matchLine: line => line.includes('"turn_context"')
      })
    }
    let usage = null
    for (const line of lines) {
      readContext(line)
      if (line.type === 'event_msg' && line.payload?.type === 'token_count' && line.payload.rate_limits) usage = line.payload
    }
    return codexUsageFromTokenCount(usage ?? {}, model, effort, sessionId)
  }

  async function tick() {
    if (running) return
    running = true
    try {
      const live = agents().filter(agent => agent.kind === 'codex' && agent.active && agent.shellId && agent.cwd && agent.startedAt)
      const liveIds = new Set(live.map(agent => agent.id))
      for (const id of bound.keys()) if (!liveIds.has(id)) bound.delete(id)
      for (const id of missed.keys()) if (!liveIds.has(id)) missed.delete(id)
      // Earlier agents pick first, so two Codex started in one folder get their own files in order
      for (const agent of [...live].sort((a, b) => a.startedAt - b.startedAt)) {
        const resumeId = agent.resumeId ?? null
        let entry = bound.get(agent.id)
        if (entry && entry.resumeId !== resumeId) {
          bound.delete(agent.id)
          entry = undefined
        }
        if (!entry) {
          // A resumed session not found: look again only now and then (the search walks the day folders)
          const previous = missed.get(agent.id)
          if (resumeId && previous?.resumeId === resumeId && now() - previous.at < RESUME_RETRY_MS) continue
          const taken = new Set([...bound.values()].map(item => item.file))
          const found = resumeId ? await findResumed(resumeId) : await findFile(agent, taken)
          if (!found) {
            if (resumeId) missed.set(agent.id, { resumeId, at: now() })
            continue
          }
          missed.delete(agent.id)
          entry = { file: found.file, id: found.id, size: -1, resumeId }
          bound.set(agent.id, entry)
        }
        const stat = await fs.promises.stat(entry.file).catch(() => null)
        if (!stat?.isFile()) {
          bound.delete(agent.id)
          continue
        }
        const { size } = stat
        if (entry.resumeId) setVerifiedSession(agent.id, entry.resumeId)
        if (size === entry.size) continue
        const usage = await readUsage(entry.file, entry.id, size, entry.size)
        entry.size = size
        if (usage) setUsage(agent.id, usage)
      }
    } finally {
      running = false
    }
  }

  return {
    tick,
    /** The session file found for an agent (the chat view follows it), or null */
    fileOf: agentId => bound.get(agentId)?.file ?? null,
    /** A time-based match is insufficient for resuming a conversation. */
    verifiedSessionOf: agentId => bound.get(agentId)?.resumeId ?? null,
    start() {
      if (timer) return
      timer = setInterval(() => { void tick().catch(() => {}) }, INTERVAL_MS)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
      bound.clear()
    }
  }
}

module.exports = { createCodexUsageWatcher, dayFolders, sessionMeta }
