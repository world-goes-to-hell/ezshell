import { describe, it, expect } from 'vitest'
import type { McpActivityItem } from '../types'
import { ACTIVITY_STATE_LABELS, MAX_ACTIVITY, countActive, formatElapsed, isActiveState, mergeSnapshot, upsertActivity } from './mcpActivity'

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

  it('formats elapsed time in Korean', () => {
    expect(formatElapsed(0)).toBe('0초')
    expect(formatElapsed(12_400)).toBe('12초')
    expect(formatElapsed(65_000)).toBe('1분 5초')
  })
})
