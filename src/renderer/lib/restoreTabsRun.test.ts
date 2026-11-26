import { beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreTabs } from './restoreTabsRun'
import { useTerminalStore } from '../stores/terminalStore'
import type { RestoreRecord } from './restoreTabs'

describe('restoring after an update that kept local shells', () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminals: new Map() })
  })

  it('opens only the tabs whose shell did not go on, and counts only those', async () => {
    const record: RestoreRecord = {
      version: 1,
      tabs: [
        { kind: 'local', cwd: 'C:\\kept', shellId: 'local:3' },
        { kind: 'local', cwd: 'C:\\gone', shellId: 'local:5' }
      ]
    }
    const openLocal = vi.fn(async () => null)
    const progress: Array<[number, number]> = []
    const outcome = await restoreTabs(record, {
      openSaved: async () => ({ error: 'none' }),
      openLocal,
      onProgress: (done, total) => progress.push([done, total]),
      keptTabOf: shellId => (shellId === 'local:3' ? 'local:3' : null)
    })
    expect(openLocal).toHaveBeenCalledTimes(1)
    expect(openLocal).toHaveBeenCalledWith(expect.objectContaining({ shellId: 'local:5' }))
    expect(progress).toEqual([[1, 1]])
    expect(outcome.opened).toBe(0)
    expect(outcome.failed).toHaveLength(1)
  })
})
