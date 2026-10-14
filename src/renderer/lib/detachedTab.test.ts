import { describe, it, expect } from 'vitest'
import { detachTab, restoreMergedTab } from './detachedTab'
import type { TerminalInfo } from '../stores/terminalStore'
import type { SSHConnectConfig } from '../hooks/useSSH'

const connectConfig: SSHConnectConfig = {
  host: 'example.com',
  port: 22,
  username: 'root',
  authType: 'password',
  sessionName: 'web',
  color: '#00ff00'
}

const terminal = (overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: 't1',
  host: 'example.com',
  username: 'root',
  connected: true,
  ...overrides
})

const merged = { sessionId: 't1', title: 'web', host: 'example.com', username: 'root' }

describe('detachTab', () => {
  it('keeps the color of the tab', () => {
    expect(detachTab(terminal({ color: '#ff0000', connectConfig }))).toEqual({ connectConfig, color: '#ff0000' })
  })

  it('falls back to the color the tab connected with', () => {
    expect(detachTab(terminal({ connectConfig })).color).toBe('#00ff00')
  })

  it('has no color for a tab without one', () => {
    expect(detachTab(terminal())).toEqual({ connectConfig: undefined, color: undefined })
  })
})

describe('restoreMergedTab', () => {
  it('gives the tab its color and connect config back', () => {
    const restored = restoreMergedTab(merged, detachTab(terminal({ color: '#ff0000', connectConfig })))
    expect(restored).toEqual({
      id: 't1',
      host: 'example.com',
      username: 'root',
      title: 'web',
      connected: true,
      color: '#ff0000',
      connectConfig
    })
  })

  it('restores a connected tab without color when nothing was kept', () => {
    const restored = restoreMergedTab(merged, undefined)
    expect(restored.connected).toBe(true)
    expect(restored.color).toBeUndefined()
    expect(restored.connectConfig).toBeUndefined()
  })
})
