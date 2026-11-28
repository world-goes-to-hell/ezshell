// Closing the tab in front shows the tab seen just before it (lib/tabRecency.ts), 2026-11-28 user request:
// tabs A B C, look at B then C, close C → B (it used to show A or the last tab)
import { beforeEach, describe, expect, it } from 'vitest'
import { buildScreens } from '../lib/screenPanes'
import { resetTabRecency } from '../lib/tabRecency'
import { useTerminalStore, type TerminalInfo } from './terminalStore'

const tab = (id: string): TerminalInfo => ({ id, host: 'example.com', username: 'root', connected: true })
const store = () => useTerminalStore.getState()

beforeEach(() => {
  useTerminalStore.setState({ terminals: new Map(), activeTerminalId: null, focusRequest: null, layout: buildScreens({ panes: [] }) })
  resetTabRecency()
  for (const id of ['A', 'B', 'C']) store().addTerminal(id, tab(id))
})

describe('closing the tab in front', () => {
  it('goes back to the tab seen just before it', () => {
    store().setActiveTerminal('A')
    store().setActiveTerminal('B')
    store().setActiveTerminal('C')
    store().removeTerminal('C')
    expect(store().activeTerminalId).toBe('B')
  })

  it('keeps going back through the tabs in the order they were seen', () => {
    store().setActiveTerminal('B')
    store().setActiveTerminal('A')
    store().setActiveTerminal('C')
    store().removeTerminal('C')
    expect(store().activeTerminalId).toBe('A')
    store().removeTerminal('A')
    expect(store().activeTerminalId).toBe('B')
  })

  it('leaves the front tab alone when another tab closes', () => {
    store().setActiveTerminal('B')
    store().removeTerminal('A')
    expect(store().activeTerminalId).toBe('B')
  })

  it('in a split, picks the tab seen last in the closed tab\u2019s screen', () => {
    store().addTerminal('D', tab('D'))
    // Screens: [A B] | [C D]
    useTerminalStore.setState(state => ({ layout: buildScreens({ panes: [{ terminalIds: ['A', 'B'], activeTerminalId: 'A' }, { terminalIds: ['C', 'D'], activeTerminalId: 'C' }], activePane: 1, allIds: [...state.terminals.keys()] }) }))
    store().setActiveTerminal('D')
    store().setActiveTerminal('A')
    store().setActiveTerminal('C')
    store().removeTerminal('C')
    expect(store().activeTerminalId).toBe('D')
    expect(store().layout.panes[1]?.activeTerminalId).toBe('D')
  })
})
