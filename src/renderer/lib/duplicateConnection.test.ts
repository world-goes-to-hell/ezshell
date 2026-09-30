import { describe, it, expect } from 'vitest'
import { getDuplicateConfig } from './duplicateConnection'
import type { TerminalInfo } from '../stores/terminalStore'
import type { SSHConnectConfig } from '../hooks/useSSH'

const connectConfig: SSHConnectConfig = {
  host: 'example.com',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'secret',
  sessionName: 'web',
  savedSessionId: 's1'
}

const terminal = (overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: 't1',
  host: 'example.com',
  username: 'root',
  connected: true,
  ...overrides
})

describe('getDuplicateConfig', () => {
  it('returns null when there is no terminal', () => {
    expect(getDuplicateConfig(undefined)).toBeNull()
  })

  it('returns null when the terminal has no stored connect config', () => {
    expect(getDuplicateConfig(terminal())).toBeNull()
  })

  it('returns a copy of the stored connect config', () => {
    const result = getDuplicateConfig(terminal({ connectConfig }))
    expect(result).toEqual(connectConfig)
    expect(result).not.toBe(connectConfig)
  })

  it('keeps the current tab color and title so the new tab looks the same', () => {
    const result = getDuplicateConfig(terminal({ connectConfig, color: '#ff0000', title: 'renamed' }))
    expect(result?.color).toBe('#ff0000')
    expect(result?.sessionName).toBe('renamed')
  })
})
