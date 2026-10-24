import { describe, it, expect, beforeEach } from 'vitest'
import { useMcpActivityStore } from './mcpActivityStore'

const state = () => useMcpActivityStore.getState()

describe('MCP activity panel open and collapsed state', () => {
  beforeEach(() => useMcpActivityStore.setState({ isPanelOpen: false, isPanelCollapsed: false }))

  it('opens the panel expanded, even if it was collapsed when it closed', () => {
    useMcpActivityStore.setState({ isPanelCollapsed: true })
    state().setPanelOpen(true)
    expect(state()).toMatchObject({ isPanelOpen: true, isPanelCollapsed: false })
  })

  it('toggles: closed opens, collapsed expands, expanded closes', () => {
    state().togglePanel()
    expect(state()).toMatchObject({ isPanelOpen: true, isPanelCollapsed: false })
    state().setPanelCollapsed(true)
    state().togglePanel()
    expect(state()).toMatchObject({ isPanelOpen: true, isPanelCollapsed: false })
    state().togglePanel()
    expect(state().isPanelOpen).toBe(false)
  })

  it('does not collapse a closed panel', () => {
    state().setPanelCollapsed(true)
    expect(state().isPanelCollapsed).toBe(false)
  })
})
