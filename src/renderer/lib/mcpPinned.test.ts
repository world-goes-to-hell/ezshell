import { describe, it, expect } from 'vitest'
import type { McpActivityItem } from '../types'
import { PIN_AFTER_MS, lastOutputLines, pinnedRequests } from './mcpPinned'

const item = (id: string, startedAt: number, state: McpActivityItem['state'] = 'running'): McpActivityItem => ({
  id, time: 't', sessionId: 's', sessionName: 'dev', command: 'ls', level: 'low', reasons: [], state, startedAt, finishedAt: null
})
const out = (...texts: string[]) => texts.map(text => ({ stream: 'stdout' as const, text }))

describe('pinnedRequests', () => {
  it('pins a request that is still active after a moment, waiting or running', () => {
    const now = 10000
    const old = now - PIN_AFTER_MS
    expect(pinnedRequests([item('a', old), item('b', old, 'waiting')], now).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('does not pin a request that only just started', () => {
    expect(pinnedRequests([item('a', 10000 - PIN_AFTER_MS + 1)], 10000)).toEqual([])
  })

  it('does not pin a finished request, however long it ran', () => {
    expect(pinnedRequests([item('a', 0, 'done'), item('b', 0, 'failed')], 10000)).toEqual([])
  })

  it('keeps the longest running first, so a new request does not move the others', () => {
    expect(pinnedRequests([item('new', 5000), item('old', 1000), item('mid', 3000)], 10000).map(entry => entry.id)).toEqual(['old', 'mid', 'new'])
  })

  it('does not change the list it was given', () => {
    const items = [item('b', 2000), item('a', 1000)]
    pinnedRequests(items, 10000)
    expect(items.map(entry => entry.id)).toEqual(['b', 'a'])
  })
})

describe('lastOutputLines', () => {
  it('gives nothing when there is no output', () => {
    expect(lastOutputLines(undefined)).toEqual([])
    expect(lastOutputLines([])).toEqual([])
  })

  it('gives the last three lines across pieces of output', () => {
    expect(lastOutputLines(out('one\ntwo\nth', 'ree\nfour\nfive\n'))).toEqual(['three', 'four', 'five'])
  })

  it('skips blank lines', () => {
    expect(lastOutputLines(out('one\n\n\ntwo\n  \n'))).toEqual(['one', 'two'])
  })

  it('treats carriage returns as line ends and removes control characters', () => {
    expect(lastOutputLines(out('10%\r20%\r\nd\u0007one\n'))).toEqual(['10%', '20%', 'done'])
  })

  it('reads only the end of a very long output', () => {
    const lines = lastOutputLines(out(`${'x'.repeat(100000)}\nend\n`))
    expect(lines[lines.length - 1]).toBe('end')
    expect(lines[0].length).toBeLessThan(20000)
  })
})
