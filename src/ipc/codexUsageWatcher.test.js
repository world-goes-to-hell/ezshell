import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexUsageWatcher, dayFolders } from './codexUsageWatcher.js'

const jsonl = lines => lines.map(line => JSON.stringify(line)).join('\n') + '\n'
const START = new Date(2026, 10, 19, 10, 0, 0).getTime()
let home
let work

const tokenCount = (used, total) => ({ type: 'event_msg', payload: {
  type: 'token_count',
  info: { last_token_usage: { total_tokens: total }, model_context_window: 200000 },
  rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1795000000 }, secondary: null }
} })
const largeOutput = { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300 * 1024) } }
const turnEvent = (type, at, turn_id = 't1', root_turn_id = turn_id) =>
  ({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type, turn_id, root_turn_id } })

function rollout(name, { cwd = work, at = START + 1000, lines = [], meta = {} } = {}) {
  const dir = path.join(home, 'sessions', '2026', '11', '19')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${name}.jsonl`)
  fs.writeFileSync(file, jsonl([{ type: 'session_meta', payload: { id: name, cwd, timestamp: new Date(at).toISOString(), ...meta } }, { type: 'turn_context', payload: { model: 'gpt-6', effort: 'xhigh' } }, ...lines]))
  const seconds = (at + 500) / 1000
  fs.utimesSync(file, seconds, seconds)
  return file
}

function setup(agentList, options = {}) {
  const reports = []
  const verifiedSessions = []
  const roleSessions = []
  const turns = []
  const watcher = createCodexUsageWatcher({
    agents: () => agentList,
    setUsage: (agentId, usage) => { reports.push({ agentId, usage }); return true },
    setVerifiedSession: (agentId, sessionId) => verifiedSessions.push({ agentId, sessionId }),
    setFreshRoleSession: (agentId, sessionId, startedAt) => { roleSessions.push({ agentId, sessionId, startedAt }); return true },
    setTurnStatus: (shellId, agentId, sessionId, turn) => turns.push({ shellId, agentId, sessionId, turn }),
    codexHome: home,
    now: () => START + 60_000,
    ...options
  })
  return { watcher, reports, verifiedSessions, roleSessions, turns }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-work-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(work, { recursive: true, force: true })
})

describe('dayFolders', () => {
  it('covers the start day, the day before and today', () => {
    expect(dayFolders(new Date(2026, 10, 19, 0, 30).getTime(), new Date(2026, 10, 20, 9).getTime()))
      .toEqual([['2026', '11', '18'], ['2026', '11', '19'], ['2026', '11', '20']])
  })
})

describe('createCodexUsageWatcher', () => {
  const agent = { id: 'codex-1', kind: 'codex', active: true, shellId: 'local:1', startedAt: START }
  const firstId = '01a1ec18-0000-7000-8000-000000000001'
  const secondId = '01a1ec18-0000-7000-8000-000000000002'
  const freshWithHook = () => ({ ...agent, cwd: work, roleCwd: work, roleStartedAt: START, hookSessionId: firstId })

  it.each([false, true])('uses the main-owned folder for role discovery (available but different: %s)', async mismatch => {
    rollout(firstId)
    const fresh = freshWithHook()
    fresh.roleCwd = mismatch ? os.tmpdir() : undefined
    const { watcher, roleSessions } = setup([fresh])
    await watcher.tick()
    expect(roleSessions).toEqual([])
  })

  it('counts a rollout claimed by another agent through usage estimation as an ambiguous candidate', async () => {
    const guess = { ...agent, id: 'codex-2', shellId: 'local:2', cwd: work, startedAt: START - 1000 }
    const guessed = rollout(secondId)
    rollout(firstId, { at: START + 2000 })
    const { watcher, roleSessions } = setup([guess, freshWithHook()])
    await watcher.tick()
    expect(watcher.fileOf(guess.id)).toBe(guessed)
    expect(roleSessions).toEqual([])
  })

  it('excludes a rollout owned by another agent through a verified explicit resume', async () => {
    const resumed = { ...agent, id: 'codex-2', shellId: 'local:2', cwd: work, startedAt: START - 1000, resumeId: secondId }
    rollout(secondId)
    rollout(firstId, { at: START + 2000 })
    const { watcher, roleSessions } = setup([resumed, freshWithHook()])
    await watcher.tick()
    expect(roleSessions).toEqual([{ agentId: agent.id, sessionId: firstId, startedAt: START }])
  })

  it('rechecks the evidence on the next poll after a lock and unlock during file verification', async () => {
    const file = rollout(firstId)
    let epoch = 0
    const { watcher, roleSessions } = setup([freshWithHook()], { freshRoleEpoch: () => epoch })
    const stat = fs.promises.stat.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (...args) => {
      const result = await stat(...args)
      if (args[0] === file && epoch === 0) epoch++
      return result
    })
    try {
      await watcher.tick()
      expect(roleSessions).toEqual([])
      await watcher.tick()
      expect(roleSessions).toEqual([{ agentId: agent.id, sessionId: firstId, startedAt: START }])
    } finally { spy.mockRestore() }
  })

  it.each(['replaced file', 'rewritten header'])('rejects a %s after the usage watcher has sampled its identity', async mutation => {
    const file = rollout(firstId)
    const replacement = file + '.replacement'
    if (mutation === 'replaced file') fs.copyFileSync(file, replacement)
    const stat = fs.promises.stat.bind(fs.promises)
    let changed = false
    const spy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (...args) => {
      const result = await stat(...args)
      if (!changed && args[0] === file) {
        changed = true
        if (mutation === 'replaced file') fs.renameSync(replacement, file)
        else rollout(firstId, { cwd: os.tmpdir() })
      }
      return result
    })
    try {
      const { watcher, roleSessions } = setup([freshWithHook()])
      await watcher.tick()
      expect(changed).toBe(true)
      expect(roleSessions).toEqual([])
    } finally { spy.mockRestore() }
  })

  it('refuses to prove uniqueness when the time window exceeds the day-folder scan', async () => {
    rollout(firstId)
    const { watcher, roleSessions } = setup([freshWithHook()], { now: () => START + 8 * 86_400_000 })
    await watcher.tick()
    expect(roleSessions).toEqual([])
  })

  it('confirms the fresh role key with one independently found matching rollout, leaving resume unverified', async () => {
    const file = rollout(firstId)
    const fresh = { ...freshWithHook(), hookSessionId: null }
    const { watcher, verifiedSessions, roleSessions } = setup([fresh])
    await watcher.tick()
    expect(watcher.fileOf(agent.id)).toBe(file)
    expect(roleSessions).toEqual([])
    fresh.hookSessionId = firstId
    await watcher.tick()
    await watcher.tick()
    expect(roleSessions).toEqual([{ agentId: agent.id, sessionId: firstId, startedAt: START }])
    expect(verifiedSessions).toEqual([])
    expect(watcher.verifiedSessionOf(agent.id)).toBeNull()
  })

  it.each(['hook only', 'mismatch', 'two files', 'different cwd', 'prelaunch', 'filename mismatch', 'no verified start'])(
    'keeps a fresh role in memory with %s', async mode => {
      const fresh = freshWithHook()
      if (mode === 'mismatch') rollout(secondId)
      else if (mode === 'prelaunch') rollout(firstId, { at: START - 10 })
      else if (mode === 'different cwd') rollout(firstId, { cwd: os.tmpdir() })
      else if (mode === 'filename mismatch') rollout(secondId, { meta: { id: firstId } })
      else if (mode === 'no verified start') { delete fresh.roleStartedAt; rollout(firstId) }
      else if (mode === 'two files') { rollout(firstId); rollout(secondId) }
      const { watcher, roleSessions } = setup([fresh])
      await watcher.tick()
      // Ambiguity observed while running cannot be erased by removing the other candidate.
      if (mode === 'two files') {
        fs.unlinkSync(path.join(home, 'sessions', '2026', '11', '19', `rollout-${secondId}.jsonl`))
        await watcher.tick()
      }
      expect(roleSessions).toEqual([])
    }
  )

  it('rejects a second rollout even when the new file and a later hook agree', async () => {
    const first = rollout(firstId)
    const fresh = { ...freshWithHook(), hookSessionId: null }
    const { watcher, roleSessions } = setup([fresh])
    await watcher.tick()
    fs.unlinkSync(first)
    rollout(secondId)
    fresh.hookSessionId = secondId
    await watcher.tick()
    expect(roleSessions).toEqual([])
  })

  it('waits for every fresh rollout header before deciding that one file is eligible', async () => {
    rollout(firstId)
    const incomplete = rollout(secondId)
    fs.writeFileSync(incomplete, '')
    const recent = new Date(START + 2000)
    fs.utimesSync(incomplete, recent, recent)
    const fresh = freshWithHook()
    const { watcher, roleSessions } = setup([fresh])
    await watcher.tick()
    expect(roleSessions).toEqual([])
    rollout(secondId, { cwd: os.tmpdir() })
    await watcher.tick()
    expect(roleSessions).toEqual([{ agentId: agent.id, sessionId: firstId, startedAt: START }])
  })

  it('reads the last token count of the session the agent started in its folder', async () => {
    rollout('mine', { lines: [tokenCount(10, 20000), tokenCount(12, 50000)] })
    const { watcher, reports } = setup([{ ...agent, cwd: work }])
    await watcher.tick()
    expect(reports).toEqual([{ agentId: 'codex-1', usage: expect.objectContaining({ agent: 'codex', model: 'gpt-6', effort: 'xhigh', fiveHour: { percent: 12, resetsAt: 1795000000000 }, context: { percent: 25, size: 200000 } }) }])
  })

  it('ignores sessions of another folder, from before the start, or taken by another agent', async () => {
    rollout('other-folder', { cwd: os.tmpdir(), lines: [tokenCount(1, 1)] })
    rollout('older', { at: START - 3600_000, lines: [tokenCount(2, 1)] })
    rollout('subagent', { at: START + 500, meta: { source: { subagent: { thread_spawn: { parent_thread_id: 'older' } } } }, lines: [tokenCount(5, 1)] })
    rollout('first', { at: START + 1000, lines: [tokenCount(3, 1)] })
    rollout('second', { at: START + 2000, lines: [tokenCount(4, 1)] })
    const { watcher, reports } = setup([
      { ...agent, cwd: work },
      { ...agent, id: 'codex-2', shellId: 'local:2', cwd: work, startedAt: START + 1500 }
    ])
    await watcher.tick()
    expect(reports.map(r => [r.agentId, r.usage.fiveHour.percent])).toEqual([['codex-1', 3], ['codex-2', 4]])
  })

  it('reads the file again only when it grew', async () => {
    const file = rollout('mine', { lines: [tokenCount(10, 1)] })
    const { watcher, reports } = setup([{ ...agent, cwd: work }])
    await watcher.tick()
    await watcher.tick()
    expect(reports).toHaveLength(1)
    fs.appendFileSync(file, jsonl([tokenCount(20, 1)]))
    await watcher.tick()
    expect(reports.map(r => r.usage.fiveHour.percent)).toEqual([10, 20])
  })

  it('recovers the model and effort when the first read follows a large tool output', async () => {
    rollout('mine', { lines: [largeOutput, tokenCount(20, 4000)] })
    const { watcher, reports } = setup([{ ...agent, cwd: work }])
    await watcher.tick()

    expect(reports.at(-1).usage).toMatchObject({ model: 'gpt-6', effort: 'xhigh', fiveHour: { percent: 20 } })
  })

  it('finds a changed model and effort before a large tool output appended between polls', async () => {
    const file = rollout('mine', { lines: [tokenCount(10, 1)] })
    const { watcher, reports } = setup([{ ...agent, cwd: work }])
    await watcher.tick()

    fs.appendFileSync(file, jsonl([
      { type: 'turn_context', payload: { model: 'gpt-6-codex', effort: 'medium' } },
      largeOutput,
      tokenCount(20, 4000)
    ]))
    await watcher.tick()

    expect(reports.at(-1).usage).toMatchObject({ model: 'gpt-6-codex', effort: 'medium', fiveHour: { percent: 20 } })
  })

  it('reports the session id from the file, before the first answer too', async () => {
    rollout('01a1ec18-9b8a-71c1-839d-2e31c010300f')
    const { watcher, reports } = setup([{ ...agent, cwd: work }])
    await watcher.tick()
    expect(reports).toEqual([{ agentId: 'codex-1', usage: { agent: 'codex', model: 'gpt-6', effort: 'xhigh', sessionId: '01a1ec18-9b8a-71c1-839d-2e31c010300f', context: null, fiveHour: null, sevenDay: null } }])
  })

  it('follows new hook session usage and file without changing the verified resume ID', async () => {
    const resumeId = '01a1ec18-0000-7000-8000-000000000001'
    const nextId = '01a1ec18-0000-7000-8000-000000000002'
    const old = rollout(`initial-${resumeId}`, { meta: { id: resumeId } })
    const next = rollout(`after-clear-${nextId}`, { meta: { id: nextId }, lines: [tokenCount(10, 30)] })
    const running = { ...agent, cwd: work, resumeId }
    const { watcher, reports, verifiedSessions } = setup([running])
    await watcher.tick()
    expect(watcher.fileOf(agent.id)).toBe(old)
    running.hookSessionId = nextId
    expect(watcher.fileOf(agent.id, nextId)).toBeNull()
    await watcher.tick()
    expect(watcher.fileOf(agent.id, nextId)).toBe(next)
    expect(reports.at(-1).usage.sessionId).toBe(nextId)
    expect(watcher.verifiedSessionOf(agent.id)).toBe(resumeId)
    expect(verifiedSessions).toEqual([{ agentId: agent.id, sessionId: resumeId }])
  })

  it('finds a resumed session by its id, so it does not take a new file of another Codex in the same folder', async () => {
    // Resumed with codex resume: it writes on in its old file (created long before it started)
    const old = '01a1ec18-0000-7000-8000-000000000001'
    const fresh = '01a1ec18-0000-7000-8000-000000000002'
    rollout(old, { at: START - 3 * 86400_000, lines: [tokenCount(40, 4000)] })
    const oldFile = path.join(home, 'sessions', '2026', '11', '19', `rollout-${old}.jsonl`)
    const dir = path.join(home, 'sessions', '2026', '11', '16')
    fs.mkdirSync(dir, { recursive: true })
    fs.renameSync(oldFile, path.join(dir, `rollout-2026-11-16T09-00-00-${old}.jsonl`))
    rollout(fresh, { at: START + 2000, lines: [tokenCount(7, 700)] })
    const { watcher, reports, verifiedSessions } = setup([
      { ...agent, id: 'codex-1', cwd: work, resumeId: old },
      { ...agent, id: 'codex-2', shellId: 'local:2', cwd: work, startedAt: START + 1000 }
    ])
    await watcher.tick()
    const byAgent = Object.fromEntries(reports.map(report => [report.agentId, report.usage]))
    expect(byAgent['codex-1']).toMatchObject({ sessionId: old, fiveHour: { percent: 40 } })
    expect(byAgent['codex-2']).toMatchObject({ sessionId: fresh, fiveHour: { percent: 7 } })
    expect(verifiedSessions).toEqual([{ agentId: 'codex-1', sessionId: old }])
    expect(watcher.verifiedSessionOf('codex-1')).toBe(old)
    expect(watcher.verifiedSessionOf('codex-2')).toBeNull()
  })

  it('replaces an earlier usage estimate when the same agent resumes a known session', async () => {
    const estimated = '01a1ec18-0000-7000-8000-000000000001'
    const resumed = '01a1ec18-0000-7000-8000-000000000002'
    rollout(estimated)
    rollout(resumed, { at: START - 3600_000 })
    const running = { ...agent, cwd: work }
    const { watcher, reports, verifiedSessions } = setup([running])
    await watcher.tick()
    expect(reports[0].usage.sessionId).toBe(estimated)
    expect(verifiedSessions).toEqual([])

    running.resumeId = resumed
    await watcher.tick()
    await watcher.tick()
    expect(reports.map(report => report.usage.sessionId)).toEqual([estimated, resumed])
    expect(verifiedSessions).toEqual([
      { agentId: agent.id, sessionId: resumed },
      { agentId: agent.id, sessionId: resumed }
    ])
  })

  it('reports only the latest root turn event from the verified resumed rollout', async () => {
    const sessionId = '01a1ec18-0000-7000-8000-000000000001'
    const file = rollout(sessionId, { at: START - 3600_000, lines: [
      turnEvent('task_started', START + 1000),
      turnEvent('task_complete', START + 2000),
      turnEvent('task_started', START + 3000, 't2'),
      turnEvent('task_complete', START + 4000, 't1'),
      turnEvent('task_complete', START + 4100, 'child', 't2')
    ] })
    rollout('01a1ec18-0000-7000-8000-000000000002', { lines: [turnEvent('task_complete', START + 5000)] })
    const { watcher, turns } = setup([
      { ...agent, cwd: work, resumeId: sessionId },
      { ...agent, id: 'codex-2', shellId: 'local:2', cwd: work }
    ])
    await watcher.tick()
    const identity = { shellId: agent.shellId, agentId: agent.id, sessionId }
    expect(turns).toEqual([{ ...identity, turn: { status: 'working', at: START + 3000 } }])

    fs.appendFileSync(file, jsonl([turnEvent('task_complete', START + 6000, 't2'), largeOutput]))
    await watcher.tick()
    expect(turns.at(-1)).toEqual({ ...identity, turn: { status: 'idle', at: START + 6000 } })

    fs.appendFileSync(file, jsonl([turnEvent('task_started', START + 7000, 't3'), largeOutput]))
    await watcher.tick()
    expect(turns.at(-1)).toEqual({ ...identity, turn: { status: 'working', at: START + 7000 } })

    fs.appendFileSync(file, jsonl([turnEvent('turn_aborted', START + 8000, 't3')]))
    await watcher.tick()
    expect(turns.at(-1)).toEqual({ ...identity, turn: { status: 'idle', at: START + 8000 } })
  })

  it('requires the resumed UUID to match the file metadata', async () => {
    const sessionId = '01a1ec18-0000-7000-8000-000000000001'
    rollout(sessionId, { meta: { id: 'other-session' }, lines: [turnEvent('task_complete', START + 2000)] })
    const { watcher, verifiedSessions, turns } = setup([{ ...agent, cwd: work, resumeId: sessionId }])
    await watcher.tick()
    expect(verifiedSessions).toEqual([])
    expect(turns).toEqual([])
  })

  it('does not drive turn state when two active agents resumed the same session', async () => {
    const sessionId = '01a1ec18-0000-7000-8000-000000000001'
    rollout(sessionId, { lines: [turnEvent('task_complete', START + 2000)] })
    const { watcher, turns } = setup([
      { ...agent, cwd: work, resumeId: sessionId },
      { ...agent, id: 'codex-2', shellId: 'local:2', cwd: work, resumeId: sessionId }
    ])
    await watcher.tick()
    expect(turns).toEqual([])
  })

  it('does nothing for Claude or ended agents', async () => {
    rollout('mine', { lines: [tokenCount(10, 1)] })
    const { watcher, reports } = setup([{ ...agent, kind: 'claude', cwd: work }, { ...agent, id: 'codex-9', active: false, cwd: work }])
    await watcher.tick()
    expect(reports).toEqual([])
  })
})
