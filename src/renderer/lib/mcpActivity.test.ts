import { describe, it, expect } from 'vitest'
import type { McpActivityItem } from '../types'
import { ACTIVITY_STATE_LABELS, MAX_ACTIVITY, appendOutputParts, cleanTerminalText, countActive, formatClock, formatDuration, formatElapsed, hasRun, isActiveState, mergeSnapshot, upsertActivity } from './mcpActivity'

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
