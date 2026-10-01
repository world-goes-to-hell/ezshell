import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore, type TerminalInfo } from './terminalStore'

const tab = (id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  host: 'example.com',
  username: 'root',
  connected: true,
  ...overrides
})

const reset = () => useTerminalStore.setState({
  terminals: new Map(),
  activeTerminalId: null,
  focusRequest: null,
  layout: {
    mode: 'single',
    direction: 'horizontal',
    primary: { terminalIds: [], activeTerminalId: null },
    secondary: null,
    activePaneType: null
  }
})

describe('focusTerminal', () => {
  beforeEach(() => {
    reset()
    const { addTerminal } = useTerminalStore.getState()
    addTerminal('1', tab('1'))
    addTerminal('2', tab('2'))
    addTerminal('3', tab('3'))
  })

  it('activates the tab in single mode', () => {
    useTerminalStore.getState().focusTerminal('1')

    expect(useTerminalStore.getState().activeTerminalId).toBe('1')
  })

  it('clears the activity mark of the tab it moves to', () => {
    useTerminalStore.getState().setTerminalActivity('1', true)

    useTerminalStore.getState().focusTerminal('1')

    expect(useTerminalStore.getState().terminals.get('1')?.hasActivity).toBe(false)
  })

  it('activates the tab inside its pane without closing the split', () => {
    // '3' goes to the secondary pane, '1' and '2' stay in the primary pane
    useTerminalStore.getState().splitWithSession('3', 'horizontal', 'secondary')

    useTerminalStore.getState().focusTerminal('2')

    const { layout, activeTerminalId } = useTerminalStore.getState()
    expect(layout.mode).toBe('split')
    expect(layout.primary.activeTerminalId).toBe('2')
    expect(layout.activePaneType).toBe('primary')
    expect(activeTerminalId).toBe('2')
  })

  it('moves focus to the secondary pane when the tab lives there', () => {
    useTerminalStore.getState().splitWithSession('3', 'horizontal', 'secondary')
    useTerminalStore.getState().setActivePaneType('primary')

    useTerminalStore.getState().focusTerminal('3')

    const { layout, activeTerminalId } = useTerminalStore.getState()
    expect(layout.secondary?.activeTerminalId).toBe('3')
    expect(layout.activePaneType).toBe('secondary')
    expect(activeTerminalId).toBe('3')
  })

  it('does nothing for a tab that is no longer open', () => {
    useTerminalStore.getState().focusTerminal('gone')

    expect(useTerminalStore.getState().activeTerminalId).toBe('3')
    expect(useTerminalStore.getState().focusRequest).toBeNull()
  })

  it('asks the tab to take keyboard focus', () => {
    useTerminalStore.getState().focusTerminal('1')

    expect(useTerminalStore.getState().focusRequest?.sessionId).toBe('1')
  })

  it('asks again when the tab is already active, so focus can return from the sidebar', () => {
    useTerminalStore.getState().focusTerminal('3')
    const first = useTerminalStore.getState().focusRequest!.seq

    useTerminalStore.getState().focusTerminal('3')

    expect(useTerminalStore.getState().focusRequest).toEqual({ sessionId: '3', seq: first + 1 })
  })

  it('asks for focus in split mode too', () => {
    useTerminalStore.getState().splitWithSession('3', 'horizontal', 'secondary')

    useTerminalStore.getState().focusTerminal('3')

    expect(useTerminalStore.getState().focusRequest?.sessionId).toBe('3')
  })
})
