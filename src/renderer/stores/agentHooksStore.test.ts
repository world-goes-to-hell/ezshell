import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyImportedAgentHooks, writeAgentHooksPrefs } from '../lib/agentHooksPrefs'
import { startAgentHooks, useAgentHooksStore } from './agentHooksStore'

describe('startAgentHooks', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useAgentHooksStore.setState({ codexMode: null, reverted: 0 })
  })

  const start = () => {
    const configure = vi.fn(async () => ({ success: true, codexMode: 'disabled' }))
    const target = new EventTarget()
    vi.stubGlobal('window', Object.assign(target, { electronAPI: { agentHooksConfigure: configure } }))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    return { configure, stop: startAgentHooks() }
  }

  it('sends the switch at start-up without resetting Codex’s decline', async () => {
    const { configure, stop } = start()
    expect(configure).toHaveBeenCalledWith({ enabled: true })
    await vi.waitFor(() => expect(useAgentHooksStore.getState().codexMode).toBe('disabled'))
    stop()
  })

  it('asks main to forget the decline only when the user turns the switch back on', () => {
    const { configure, stop } = start()
    configure.mockClear()
    writeAgentHooksPrefs({ enabled: false })
    writeAgentHooksPrefs({ enabled: true }, { resetCodexDecline: true })
    // A backup import or the same value sent again carries no reset
    writeAgentHooksPrefs({ enabled: true })
    expect(configure.mock.calls).toEqual([[{ enabled: false }], [{ enabled: true, resetCodexDecline: true }], [{ enabled: true }]])
    stop()
  })

  it('puts the switch back when main could not apply a change', async () => {
    const stored = new Map<string, string>()
    const configure = vi.fn(async (request: { enabled: boolean }) => ({ success: request.enabled }))
    vi.stubGlobal('window', Object.assign(new EventTarget(), { electronAPI: { agentHooksConfigure: configure } }))
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
    const stop = startAgentHooks()
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    writeAgentHooksPrefs({ enabled: false })
    await vi.waitFor(() => expect(useAgentHooksStore.getState().reverted).toBe(1))
    expect(stored.get('agentHooks')).toBe('{"enabled":true}')
    stop()
  })

  it('turns the switch on from a settings backup without resetting the decline', () => {
    const { configure, stop } = start()
    configure.mockClear()
    writeAgentHooksPrefs({ enabled: false })
    applyImportedAgentHooks('{"enabled":true}')
    expect(configure.mock.calls).toEqual([[{ enabled: false }], [{ enabled: true }]])
    stop()
  })
})
