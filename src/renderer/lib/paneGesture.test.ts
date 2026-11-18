import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConfirmStore } from '../stores/confirmStore'
import { useTerminalStore, type TerminalInfo } from '../stores/terminalStore'
import { adoptLocalPaneShell, releaseLocalPaneShell } from './localPaneShells'
import { commitPaneGesture, type PaneGestureAction } from './paneGesture'
import { mergePanes } from './paneToTab'
import { MAIN_PANE, paneId } from './splitTree'

vi.mock('./paneToTab', () => ({ mergePanes: vi.fn() }))

const tabId = 'local:tab'
const other = paneId(1)
const visible = () => true
const split = { kind: 'split', axis: 'row', ratio: 0.5 } satisfies PaneGestureAction
const merge = { kind: 'merge', to: MAIN_PANE, expanded: { x: 0, y: 0, w: 1, h: 1 } } satisfies PaneGestureAction
const query = vi.fn<(_: string[]) => Promise<boolean>>()
const store = useTerminalStore.getState
const terminal = () => store().terminals.get(tabId)
const question = () => useConfirmStore.getState().request
const answer = (value: boolean) => useConfirmStore.getState().answer(value)

function openLocal(shellId?: string) {
  const tab: TerminalInfo = { id: tabId, host: '이 PC', username: '', connected: true, local: { shell: 'pwsh', shellId } }
  store().addTerminal(tabId, tab)
}

function prepareMerge() {
  openLocal('local:promoted')
  store().splitTerminalPane(tabId, MAIN_PANE, 'row')
  adoptLocalPaneShell(tabId, other, 'local:adopted')
}

describe('Alt+drag session confirmation', () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState())
    query.mockReset().mockResolvedValue(false)
    vi.mocked(mergePanes).mockReset().mockResolvedValue({ ok: true, sessionId: tabId })
    vi.stubGlobal('window', { electronAPI: { localShellHasWorkingAgent: query } })
  })

  afterEach(() => {
    answer(false)
    releaseLocalPaneShell(tabId, other)
    vi.unstubAllGlobals()
  })

  it('splits an idle local shell without prompting, using the promoted main shell ID', async () => {
    openLocal('local:promoted')
    await commitPaneGesture(tabId, MAIN_PANE, split, visible)
    expect(query).toHaveBeenCalledWith(['local:promoted'])
    expect(terminal()?.splitTree?.kind).toBe('split')
    expect(question()).toBeNull()
  })

  it('asks before a split of a working shell and a cancellation changes nothing', async () => {
    openLocal()
    query.mockResolvedValue(true)
    const pending = commitPaneGesture(tabId, MAIN_PANE, split, visible)
    await vi.waitFor(() => expect(question()?.message).toBe('작업 중인 터미널이 있습니다. 정말 분할하시겠습니까?'))
    expect(query).toHaveBeenCalledWith([tabId])
    expect(terminal()?.splitTree).toBeUndefined()
    answer(false)
    await pending
    expect(terminal()?.splitTree).toBeUndefined()
  })

  it('checks the adopted source and promoted destination before merging', async () => {
    prepareMerge()
    query.mockImplementation(async shellIds => shellIds.includes('local:promoted'))
    const pending = commitPaneGesture(tabId, other, merge, visible)
    await vi.waitFor(() => expect(question()?.message).toBe('작업 중인 터미널이 있습니다. 정말 병합하시겠습니까?'))
    expect(query).toHaveBeenCalledWith(['local:adopted', 'local:promoted'])
    expect(mergePanes).not.toHaveBeenCalled()
    answer(true)
    await pending
    expect(mergePanes).toHaveBeenCalledWith(tabId, other, MAIN_PANE)
  })

  it('leaves both panes alone when a working merge is cancelled', async () => {
    prepareMerge()
    const tree = terminal()?.splitTree
    query.mockResolvedValue(true)
    const pending = commitPaneGesture(tabId, other, merge, visible)
    await vi.waitFor(() => expect(question()?.danger).toBe(true))
    answer(false)
    await pending
    expect(mergePanes).not.toHaveBeenCalled()
    expect(terminal()?.splitTree).toBe(tree)
  })

  it('discards an accepted merge if either pane has a different shell', async () => {
    prepareMerge()
    query.mockResolvedValue(true)
    const pending = commitPaneGesture(tabId, other, merge, visible)
    await vi.waitFor(() => expect(question()).not.toBeNull())
    adoptLocalPaneShell(tabId, other, 'local:new')
    answer(true)
    await pending
    expect(mergePanes).not.toHaveBeenCalled()
  })

  it('discards an accepted split if another layout replaced the original', async () => {
    openLocal()
    query.mockResolvedValue(true)
    const pending = commitPaneGesture(tabId, MAIN_PANE, split, visible)
    await vi.waitFor(() => expect(question()).not.toBeNull())
    store().splitTerminalPane(tabId, MAIN_PANE, 'col')
    const replacement = terminal()?.splitTree
    answer(true)
    await pending
    expect(terminal()?.splitTree).toBe(replacement)
  })

  it('discards an accepted merge if the tab is no longer visible', async () => {
    prepareMerge()
    query.mockResolvedValue(true)
    let tabVisible = true
    const pending = commitPaneGesture(tabId, other, merge, () => tabVisible)
    await vi.waitFor(() => expect(question()).not.toBeNull())
    tabVisible = false
    answer(true)
    await pending
    expect(mergePanes).not.toHaveBeenCalled()
  })

  it('leaves an SSH split independent of local activity', async () => {
    store().addTerminal(tabId, { id: tabId, host: 'example.test', username: 'ssh', connected: true })
    await commitPaneGesture(tabId, MAIN_PANE, split, visible)
    expect(terminal()?.splitTree?.kind).toBe('split')
    expect(query).not.toHaveBeenCalled()
    expect(question()).toBeNull()
  })
})
