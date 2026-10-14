import { describe, it, expect } from 'vitest'
import type { McpActivityItem } from '../types'
import { ACTIVITY_STATE_LABELS, DEFAULT_ACTIVITY_PREFS, MAX_ACTIVITY, appendOutputParts, cleanTerminalText, countActive, formatClock, formatDuration, formatElapsed, groupBySession, hasRun, isActiveState, mergeSnapshot, parseActivityPrefs, upsertActivity } from './mcpActivity'

const item = (id: string, startedAt: number, state: McpActivityItem['state'] = 'running'): McpActivityItem => ({
  id, time: 't', sessionId: 's', sessionName: 'dev', command: 'ls', level: 'low', reasons: [], state, startedAt, finishedAt: null
})

describe('mcpActivity', () => {
  it('labels every state', () => {
    expect(Object.keys(ACTIVITY_STATE_LABELS).sort()).toEqual(['blocked', 'cancelled', 'denied', 'done', 'expired', 'failed', 'running', 'timeout', 'waiting'])
  })

  it('treats waiting and running as active', () => {
    expect(isActiveState('waiting')).toBe(true)
    expect(isActiveState('running')).toBe(true)
    expect(isActiveState('done')).toBe(false)
  })

  it('inserts newest first and replaces by id', () => {
    const list = upsertActivity(upsertActivity([], item('a', 1)), item('b', 2))
    expect(list.map(entry => entry.id)).toEqual(['b', 'a'])
    const updated = upsertActivity(list, { ...item('a', 1), state: 'done' })
    expect(updated.map(entry => entry.id)).toEqual(['b', 'a'])
    expect(updated[1].state).toBe('done')
  })

  it('keeps at most the limit', () => {
    let list: McpActivityItem[] = []
    for (let i = 0; i < MAX_ACTIVITY + 5; i++) list = upsertActivity(list, item(`r${i}`, i))
    expect(list).toHaveLength(MAX_ACTIVITY)
    expect(list[0].id).toBe(`r${MAX_ACTIVITY + 4}`)
  })

  it('counts waiting and running requests', () => {
    expect(countActive([item('a', 1, 'waiting'), item('b', 2), item('c', 3, 'done')])).toEqual({ waiting: 1, running: 1 })
  })

  it('lets the snapshot replace stale items that saw no live event', () => {
    const stale = [item('a', 1, 'waiting')]
    const snapshot = [{ ...item('a', 1, 'cancelled'), finishedAt: 5 }]
    const merged = mergeSnapshot(stale, snapshot, new Set())
    expect(merged).toHaveLength(1)
    expect(merged[0].state).toBe('cancelled')
  })

  it('keeps items updated by a live event during this subscription', () => {
    const current = [{ ...item('b', 2, 'done'), finishedAt: 9 }, item('c', 3, 'waiting')]
    const snapshot = [item('b', 2, 'running')]
    const merged = mergeSnapshot(current, snapshot, new Set(['b']))
    expect(merged.map(entry => [entry.id, entry.state])).toEqual([['b', 'done']])
  })

  it('adds live items the snapshot does not have yet', () => {
    const merged = mergeSnapshot([item('n', 7)], [item('a', 1, 'done')], new Set(['n']))
    expect(merged.map(entry => entry.id)).toEqual(['n', 'a'])
  })

  it('appends live output to an active request, joining neighbours of the same stream', () => {
    const list = [item('b', 2), { ...item('a', 1), outputParts: [{ stream: 'stdout' as const, text: 'x' }] }]
    const next = appendOutputParts(list, 'a', [{ stream: 'stdout', text: 'y' }, { stream: 'stderr', text: 'e' }])
    expect(next[1].outputParts).toEqual([{ stream: 'stdout', text: 'xy' }, { stream: 'stderr', text: 'e' }])
    expect(next[0]).toBe(list[0])
    expect(list[1].outputParts).toEqual([{ stream: 'stdout', text: 'x' }])
  })

  it('drops the oldest finished request, never one that is still running', () => {
    const list = [item('job', 1), { ...item('a', 2, 'done'), finishedAt: 3 }, { ...item('b', 3, 'done'), finishedAt: 4 }]
    const next = upsertActivity(list, { ...item('c', 4, 'done'), finishedAt: 5 }, 3)
    expect(next.map(entry => entry.id)).toEqual(['c', 'b', 'job'])
  })

  it('keeps only the end of a long output and marks the item', () => {
    const list = [{ ...item('a', 1), outputParts: [{ stream: 'stdout' as const, text: 'abcd' }] }]
    const same = appendOutputParts(list, 'a', [{ stream: 'stderr', text: 'ef' }], 6)
    expect(same[0].outputParts).toEqual([{ stream: 'stdout', text: 'abcd' }, { stream: 'stderr', text: 'ef' }])
    expect(same[0].outputTrimmed).toBeUndefined()
    const trimmed = appendOutputParts(same, 'a', [{ stream: 'stdout', text: 'ghij' }], 6)
    expect(trimmed[0].outputParts).toEqual([{ stream: 'stderr', text: 'ef' }, { stream: 'stdout', text: 'ghij' }])
    expect(trimmed[0].outputTrimmed).toBe(true)
    const again = appendOutputParts(trimmed, 'a', [{ stream: 'stdout', text: 'klmnopqr' }], 6)
    expect(again[0].outputParts).toEqual([{ stream: 'stdout', text: 'mnopqr' }])
  })

  it('joins the oldest pieces when output keeps switching streams', () => {
    const list = [{ ...item('a', 1), outputParts: [{ stream: 'stdout' as const, text: 'a' }, { stream: 'stderr' as const, text: 'b' }] }]
    const next = appendOutputParts(list, 'a', [{ stream: 'stdout', text: 'c' }, { stream: 'stderr', text: 'd' }, { stream: 'stdout', text: 'e' }], 100, 3)
    expect(next[0].outputParts).toEqual([{ stream: 'stdout', text: 'abc' }, { stream: 'stderr', text: 'd' }, { stream: 'stdout', text: 'e' }])
    expect(next[0].outputTrimmed).toBeUndefined()
  })

  it('leaves the list untouched for an unknown or finished request', () => {
    const list = [{ ...item('a', 1, 'done'), finishedAt: 5 }]
    expect(appendOutputParts(list, 'a', [{ stream: 'stdout', text: 'late' }])).toBe(list)
    expect(appendOutputParts(list, 'nope', [{ stream: 'stdout', text: 'x' }])).toBe(list)
  })

  it('turns terminal output into plain text for display', () => {
    expect(cleanTerminalText('a\r\nb\rc\x1b\x07\td\u009be')).toBe('a\nb\nc\tde')
    // Bidi overrides and zero-width characters could make a line read differently from what it is
    expect(cleanTerminalText('ok‮gnp.exe⁦x⁩​﻿')).toBe('okgnp.exex')
  })

  it('formats elapsed time in Korean', () => {
    expect(formatElapsed(0)).toBe('0초')
    expect(formatElapsed(12_400)).toBe('12초')
    expect(formatElapsed(65_000)).toBe('1분 5초')
  })

  it('formats how long a finished request took', () => {
    expect(formatDuration(240)).toBe('0.2초')
    expect(formatDuration(-5)).toBe('0.0초')
    expect(formatDuration(12_400)).toBe('12초')
    expect(formatDuration(65_000)).toBe('1분 5초')
  })

  it('tells a request that ran from one that never reached the server', () => {
    expect(hasRun({ ...item('a', 1, 'done'), exitCode: 0 })).toBe(true)
    expect(hasRun({ ...item('a', 1, 'timeout'), exitCode: null })).toBe(true)
    expect(hasRun(item('a', 1, 'denied'))).toBe(false)
  })

  it('shows an unreadable timestamp as it is', () => {
    expect(formatClock('not a date')).toBe('not a date')
    expect(formatClock('2026-10-02T01:02:03')).toBe('01:02:03')
  })
})

describe('groupBySession', () => {
  const on = (sessionId: string, id: string, startedAt: number, state: McpActivityItem['state'] = 'done', sessionName = sessionId): McpActivityItem => ({
    ...item(id, startedAt, state), sessionId, sessionName
  })

  it('returns nothing for an empty list', () => {
    expect(groupBySession([])).toEqual([])
  })

  it('groups by session with the oldest request first inside a lane', () => {
    const lanes = groupBySession([on('web', 'c', 3), on('db', 'b', 2), on('web', 'a', 1)])
    expect(lanes.map(lane => lane.sessionId)).toEqual(['web', 'db'])
    expect(lanes[0].items.map(entry => entry.id)).toEqual(['a', 'c'])
    expect(lanes[1].items.map(entry => entry.id)).toEqual(['b'])
  })

  it('orders lanes by their oldest request, so a new request does not move them', () => {
    const before = groupBySession([on('db', 'b', 2), on('web', 'a', 1)])
    const after = groupBySession([on('db', 'c', 3), on('db', 'b', 2), on('web', 'a', 1)])
    expect(before.map(lane => lane.sessionId)).toEqual(['web', 'db'])
    expect(after.map(lane => lane.sessionId)).toEqual(['web', 'db'])
  })

  it('names a lane after its most recent request', () => {
    const [lane] = groupBySession([on('web', 'b', 2, 'done', 'web-new'), on('web', 'a', 1, 'done', 'web-old')])
    expect(lane.sessionName).toBe('web-new')
  })

  it('counts waiting and running requests per lane', () => {
    const lanes = groupBySession([on('web', 'c', 3, 'running'), on('web', 'b', 2, 'waiting'), on('db', 'a', 1)])
    expect(lanes.find(lane => lane.sessionId === 'web')).toMatchObject({ waiting: 1, running: 1 })
    expect(lanes.find(lane => lane.sessionId === 'db')).toMatchObject({ waiting: 0, running: 0 })
  })
})

describe('parseActivityPrefs', () => {
  it('reads a stored view and filter', () => {
    expect(parseActivityPrefs('{"view":"lanes","isActiveOnly":true}')).toEqual({ view: 'lanes', isActiveOnly: true })
  })

  it('uses the defaults when nothing is stored', () => {
    expect(parseActivityPrefs(null)).toEqual(DEFAULT_ACTIVITY_PREFS)
    expect(parseActivityPrefs('')).toEqual(DEFAULT_ACTIVITY_PREFS)
  })

  it('uses the defaults for text that is not JSON or not an object', () => {
    expect(parseActivityPrefs('{view')).toEqual(DEFAULT_ACTIVITY_PREFS)
    expect(parseActivityPrefs('null')).toEqual(DEFAULT_ACTIVITY_PREFS)
    expect(parseActivityPrefs('"lanes"')).toEqual(DEFAULT_ACTIVITY_PREFS)
  })

  it('replaces only the field it does not understand', () => {
    expect(parseActivityPrefs('{"view":"grid","isActiveOnly":true}')).toEqual({ view: 'terminal', isActiveOnly: true })
    expect(parseActivityPrefs('{"view":"list","isActiveOnly":"yes"}')).toEqual({ view: 'list', isActiveOnly: false })
  })
})
