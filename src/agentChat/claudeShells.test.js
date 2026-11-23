import { describe, expect, it } from 'vitest'
import { createClaudeShellTracker } from './claudeShells.js'

const call = (id, command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command, run_in_background: true } }] } })
const started = (toolUseId, taskId) => ({
  type: 'user', toolUseResult: { backgroundTaskId: taskId },
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Command running in background' }] }
})
const stop = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } })
const stopped = (id, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'stopped' }] } })

describe('the background shells of a Claude transcript', () => {
  it('drops a shell the agent stopped itself: no completion notice comes for it (2026-11-23 user report)', () => {
    const tracker = createClaudeShellTracker()
    for (const line of [call('t1', 'npm run e2e'), started('t1', 'bh61'), call('t2', 'gh run watch'), started('t2', 'b5sj')]) tracker.feed(line)
    expect(tracker.running().map(job => job.id)).toEqual(['bh61', 'b5sj'])
    tracker.feed(stop('s1', 'TaskStop', { task_id: 'bh61' }))
    tracker.feed(stopped('s1'))
    expect(tracker.running()).toEqual([{ id: 'b5sj', command: 'gh run watch', description: '' }])
    // Older Claude Code names: KillShell / KillBash with shell_id
    tracker.feed(stop('s2', 'KillShell', { shell_id: 'b5sj' }))
    tracker.feed(stopped('s2'))
    expect(tracker.running()).toEqual([])
  })

  it('keeps a shell whose stop failed', () => {
    const tracker = createClaudeShellTracker()
    for (const line of [call('t1', 'npm run dev'), started('t1', 'srv'), stop('s1', 'TaskStop', { task_id: 'srv' }), stopped('s1', true)]) tracker.feed(line)
    expect(tracker.running().map(job => job.id)).toEqual(['srv'])
  })
})
