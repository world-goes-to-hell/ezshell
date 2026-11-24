import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore } from '../stores/terminalStore'
import { NOT_LOCAL, resumeIntoPane } from './agentSessionDrop'
import { getLocalPaneShellId, releaseLocalPaneShell } from './localPaneShells'
import { MAIN_PANE, paneIds, singlePane } from './splitTree'
import type { MergePlace } from './tabToPane'

vi.mock('./tabHosts', () => ({
  tabHost: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ width: 600, height: 400 }) }) })
}))

const tabId = 'local:1'
const request = { key: 'codex:01a1ec18-9b8a-71c1-839d-2e31c010300f', agent: 'codex' as const, label: '기록' }
const open = vi.fn()

describe('resuming a conversation into a pane', () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState())
    open.mockReset().mockResolvedValue({ success: true, id: 'local:42', name: 'PowerShell' })
    vi.stubGlobal('window', { electronAPI: { localShellOpen: open } })
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.stubGlobal('CSS', { escape: (value: string) => value })
  })

  afterEach(() => {
    releaseLocalPaneShell(tabId, 'split-6')
    vi.unstubAllGlobals()
  })

  it.each<MergePlace | undefined>([undefined, { pane: MAIN_PANE, isVacant: false, side: 'left' }])(
    'adds a seventh local pane when dropped at %j', async place => {
      const store = useTerminalStore.getState()
      store.addTerminal(tabId, { id: tabId, host: '이 PC', username: '', connected: true, local: { shell: 'PowerShell' } })
      for (let index = 0; index < 5; index++) store.splitTerminalPane(tabId, MAIN_PANE, 'row')

      expect(await resumeIntoPane(request, tabId, place)).toEqual({ ok: true })
      expect(open).toHaveBeenCalledWith({ cols: 80, rows: 24, resume: request.key })
      expect(paneIds(store.getTerminal(tabId)?.splitTree ?? singlePane())).toHaveLength(7)
      expect(getLocalPaneShellId(tabId, 'split-6')).toBe('local:42')
    }
  )

  it('refuses SSH tabs before opening a shell', async () => {
    const id = 'ssh:1'
    useTerminalStore.getState().addTerminal(id, { id, host: 'host', username: 'user', connected: true })
    expect(await resumeIntoPane(request, id)).toEqual({ ok: false, error: NOT_LOCAL })
    expect(open).not.toHaveBeenCalled()
  })
})
