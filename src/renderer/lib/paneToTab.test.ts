import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore, type TerminalInfo } from '../stores/terminalStore'
import { adoptLocalPaneShell, releaseLocalPaneShell } from './localPaneShells'
import { closeTabPane } from './paneToTab'
import { MAIN_PANE, paneId, paneIds } from './splitTree'

const tabId = 'local:tab'
const second = paneId(1)
const store = useTerminalStore.getState
const terminal = () => store().terminals.get(tabId)
const closeShell = vi.fn()
// One pane left: the store drops the tree and the tab is no longer split
const panes = () => { const tree = terminal()?.splitTree; return tree ? paneIds(tree) : [MAIN_PANE] }

function openSplitLocal() {
  const tab: TerminalInfo = { id: tabId, host: '이 PC', username: '', connected: true, local: { shell: 'pwsh', shellId: 'local:1' } }
  store().addTerminal(tabId, tab)
  store().splitTerminalPane(tabId, MAIN_PANE, 'row')
}

describe('closeTabPane (이 칸 닫기)', () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState())
    closeShell.mockReset()
    vi.stubGlobal('window', { electronAPI: { localShellClose: closeShell }, setTimeout: () => 0 })
  })

  afterEach(() => {
    releaseLocalPaneShell(tabId, second)
    vi.unstubAllGlobals()
  })

  it('closes a pane that is not the first terminal', async () => {
    openSplitLocal()
    const result = await closeTabPane(tabId, second)
    expect(result.ok).toBe(true)
    expect(panes()).toEqual([MAIN_PANE])
    expect(terminal()?.isSplit).not.toBe(true)
    expect(closeShell).not.toHaveBeenCalled()
  })

  it('closes the first terminal: the other shell becomes the main one and the old main shell ends', async () => {
    openSplitLocal()
    adoptLocalPaneShell(tabId, second, 'local:2')
    const result = await closeTabPane(tabId, MAIN_PANE)
    expect(result.ok).toBe(true)
    expect(terminal()?.local?.shellId).toBe('local:2')
    expect(closeShell).toHaveBeenCalledWith('local:1')
    expect(panes()).toEqual([MAIN_PANE])
    expect(terminal()?.isSplit).not.toBe(true)
  })

  it('keeps the first terminal while no other shell of the tab is open yet', async () => {
    openSplitLocal()
    const before = terminal()?.splitTree
    const result = await closeTabPane(tabId, MAIN_PANE)
    expect(result.ok).toBe(false)
    expect(terminal()?.splitTree).toBe(before)
    expect(closeShell).not.toHaveBeenCalled()
  })
})
