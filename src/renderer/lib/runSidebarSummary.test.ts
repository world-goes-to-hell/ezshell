import { expect, it } from 'vitest'
import { sidebarRunSummary } from './runSidebarSummary'
import type { RunPreset } from '../types'

const preset = (id: string): RunPreset => ({
  id, name: id, relative: '.', kind: 'custom', command: `node ${id}.js`, jdk: 'system',
  env: {}, notify: true, agentControl: false, inAll: true, waitReady: false,
})

it('counts each problem separately and shows each problem or pinned preset once', () => {
  const results = sidebarRunSummary(['pinned', 'running', 'slow', 'failed', 'idle'].map(preset), {
    running: { status: 'running', errors: 0 },
    slow: { status: 'running', errors: 0, unresponsive: { since: 100 } },
    failed: { status: 'crashed', errors: 1 },
  }, ['failed', 'pinned', 'removed'])

  expect(results.counts).toEqual({ running: 2, crashed: 1, unresponsive: 1 })
  expect(results.visible.map(item => item.id)).toEqual(['failed', 'slow', 'pinned'])
})

it('stops showing an unpinned service when it responds again', () => {
  const presets = [preset('slow')]
  expect(sidebarRunSummary(presets, { slow: { status: 'running', errors: 0, unresponsive: { since: 100 } } }, []).visible).toEqual(presets)
  expect(sidebarRunSummary(presets, { slow: { status: 'running', errors: 0 } }, []).visible).toEqual([])
})
