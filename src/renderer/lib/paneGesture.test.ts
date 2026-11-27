import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConfirmStore } from '../stores/confirmStore'
import { useTerminalStore, type TerminalInfo } from '../stores/terminalStore'
import { adoptLocalPaneShell, releaseLocalPaneShell } from './localPaneShells'
import { CLOSE_TAB_EVENT, commitPaneGesture, type PaneGestureAction } from './paneGesture'
import { closeTabPane, mergePanes } from './paneToTab'
import { MAIN_PANE, paneId, paneIds, singlePane } from './splitTree'
import { useAgentMessagesStore } from '../components/Terminal/AgentMessages'
import type { AgentMessageSession } from '../types'

vi.mock('./paneToTab', () => ({ mergePanes: vi.fn(), closeTabPane: vi.fn() }))

const tabId = 'local:tab'
const other = paneId(1)
const visible = () => true
const split = { kind: 'split', axis: 'row', ratio: 0.5 } satisfies PaneGestureAction
const merge = { kind: 'merge', to: MAIN_PANE, expanded: { x: 0, y: 0, w: 1, h: 1 } } satisfies PaneGestureAction
const close = { kind: 'close' } satisfies PaneGestureAction
const closeTab = { kind: 'close-tab' } satisfies PaneGestureAction
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
    useAgentMessagesStore.setState({ snapshot: { revision: -1, agents: [], messages: [] } })
    query.mockReset().mockResolvedValue(false)
    vi.mocked(mergePanes).mockReset().mockResolvedValue({ ok: true, sessionId: tabId })
    vi.mocked(closeTabPane).mockReset().mockResolvedValue({ ok: true, sessionId: tabId })
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

  it('adds a seventh local pane by Alt+drag and stops at six SSH panes', async () => {
    openLocal()
    const sshTab = 'ssh:tab'
    store().addTerminal(sshTab, { id: sshTab, host: 'host', username: 'user', connected: true })
    for (let index = 0; index < 5; index++) {
      store().splitTerminalPane(tabId, MAIN_PANE, 'row')
      store().splitTerminalPane(sshTab, MAIN_PANE, 'row')
    }
    await commitPaneGesture(tabId, MAIN_PANE, split, visible)
    await commitPaneGesture(sshTab, MAIN_PANE, split, visible)
    expect(paneIds(terminal()?.splitTree ?? singlePane())).toHaveLength(7)
    expect(paneIds(store().getTerminal(sshTab)?.splitTree ?? singlePane())).toHaveLength(6)
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

  it('closes a scribbled pane the way 이 칸 닫기 does', async () => {
    prepareMerge()
    await commitPaneGesture(tabId, other, close, visible)
    expect(query).toHaveBeenCalledWith(['local:adopted'])
    expect(closeTabPane).toHaveBeenCalledWith(tabId, other)
    expect(question()).toBeNull()
  })

  it('asks before closing a working shell, as a danger, and a cancellation keeps it', async () => {
    prepareMerge()
    query.mockResolvedValue(true)
    const pending = commitPaneGesture(tabId, other, close, visible)
    await vi.waitFor(() => expect(question()?.message).toBe('작업 중인 터미널이 있습니다. 정말 닫으시겠습니까?'))
    expect(question()?.danger).toBe(true)
    answer(false)
    await pending
    expect(closeTabPane).not.toHaveBeenCalled()
  })

  it('asks before closing a pane whose shell runs an idle agent (design review D9)', async () => {
    prepareMerge()
    useAgentMessagesStore.setState({ snapshot: { revision: 1, agents: [{ id: 'claude-1', kind: 'claude', active: true, shellId: 'local:adopted' } as AgentMessageSession], messages: [] } })
    const pending = commitPaneGesture(tabId, other, close, visible)
    await vi.waitFor(() => expect(question()?.message).toBe('이 칸에서 Claude 세션이 실행 중입니다. 칸을 닫으면 셸과 그 안의 프로그램이 함께 종료됩니다. 닫을까요?'))
    expect(question()?.danger).toBe(true)
    answer(true)
    await pending
    expect(closeTabPane).toHaveBeenCalledWith(tabId, other)
  })

  it('a merge asks about the pane it closes (dragged onto), not the one it keeps', async () => {
    prepareMerge()
    // The agent is in the pane the drag starts from: it stays
    useAgentMessagesStore.setState({ snapshot: { revision: 1, agents: [{ id: 'claude-1', kind: 'claude', active: true, shellId: 'local:adopted' } as AgentMessageSession], messages: [] } })
    await commitPaneGesture(tabId, other, merge, visible)
    expect(question()).toBeNull()
    expect(mergePanes).toHaveBeenCalledWith(tabId, other, MAIN_PANE)

    vi.mocked(mergePanes).mockClear()
    useAgentMessagesStore.setState({ snapshot: { revision: 2, agents: [{ id: 'codex-1', kind: 'codex', active: true, shellId: 'local:promoted' } as AgentMessageSession], messages: [] } })
    const pending = commitPaneGesture(tabId, other, merge, visible)
    await vi.waitFor(() => expect(question()?.message).toContain('Codex 세션이 실행 중입니다'))
    answer(false)
    await pending
    expect(mergePanes).not.toHaveBeenCalled()
  })

  it('a scribble over the only pane closes the tab the way 탭 닫기 does (2026-11-27 user request)', async () => {
    openLocal('local:only')
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { electronAPI: { localShellHasWorkingAgent: query }, dispatchEvent })
    await commitPaneGesture(tabId, MAIN_PANE, closeTab, visible)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<string>
    expect(event.type).toBe(CLOSE_TAB_EVENT)
    expect(event.detail).toBe(tabId)
    // 탭 닫기 asks about agents itself: no second question here
    expect(query).not.toHaveBeenCalled()
    expect(question()).toBeNull()
    expect(closeTabPane).not.toHaveBeenCalled()
  })

  it('leaves the agent question of a scribbled single-pane tab to 탭 닫기', async () => {
    openLocal('local:only')
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { electronAPI: { localShellHasWorkingAgent: query }, dispatchEvent })
    useAgentMessagesStore.setState({ snapshot: { revision: 1, agents: [{ id: 'claude-1', kind: 'claude', active: true, shellId: 'local:only' } as AgentMessageSession], messages: [] } })
    await commitPaneGesture(tabId, MAIN_PANE, closeTab, visible)
    expect(question()).toBeNull()
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('does not close a single-pane tab that changed while the scribble was released', async () => {
    openLocal('local:only')
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { electronAPI: { localShellHasWorkingAgent: query }, dispatchEvent })
    await commitPaneGesture(tabId, MAIN_PANE, closeTab, () => false)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('leaves an SSH split independent of local activity', async () => {
    store().addTerminal(tabId, { id: tabId, host: 'example.test', username: 'ssh', connected: true })
    await commitPaneGesture(tabId, MAIN_PANE, split, visible)
    expect(terminal()?.splitTree?.kind).toBe('split')
    expect(query).not.toHaveBeenCalled()
    expect(question()).toBeNull()
  })
})
