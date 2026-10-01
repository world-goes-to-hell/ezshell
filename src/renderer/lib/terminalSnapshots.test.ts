import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerTerminalSerializer, captureTerminalSnapshot, setPendingSnapshot, takePendingSnapshot, resetTerminalSnapshots
} from './terminalSnapshots'

beforeEach(() => resetTerminalSnapshots())

describe('captureTerminalSnapshot', () => {
  it('returns null when no terminal is registered for the session', () => {
    expect(captureTerminalSnapshot('s1')).toBeNull()
  })

  it('returns what the registered terminal serializes', () => {
    registerTerminalSerializer('s1', () => 'prompt$ ls')
    expect(captureTerminalSnapshot('s1')).toBe('prompt$ ls')
  })

  it('stops capturing after the terminal unregisters', () => {
    const unregister = registerTerminalSerializer('s1', () => 'x')
    unregister()
    expect(captureTerminalSnapshot('s1')).toBeNull()
  })

  it('keeps a newer registration when an older terminal unregisters late', () => {
    const unregisterOld = registerTerminalSerializer('s1', () => 'old')
    registerTerminalSerializer('s1', () => 'new')
    unregisterOld()
    expect(captureTerminalSnapshot('s1')).toBe('new')
  })

  it('returns null instead of throwing when serializing fails', () => {
    registerTerminalSerializer('s1', () => { throw new Error('disposed') })
    expect(captureTerminalSnapshot('s1')).toBeNull()
  })

  it('treats an empty screen as nothing to restore', () => {
    registerTerminalSerializer('s1', () => '')
    expect(captureTerminalSnapshot('s1')).toBeNull()
  })
})

describe('pending snapshots', () => {
  it('hands a pending snapshot out once', () => {
    setPendingSnapshot('s1', 'screen')
    expect(takePendingSnapshot('s1')).toBe('screen')
    expect(takePendingSnapshot('s1')).toBeNull()
  })

  it('keeps sessions separate', () => {
    setPendingSnapshot('s1', 'a')
    setPendingSnapshot('s2', 'b')
    expect(takePendingSnapshot('s2')).toBe('b')
    expect(takePendingSnapshot('s1')).toBe('a')
  })

  it('ignores empty snapshots', () => {
    setPendingSnapshot('s1', '')
    expect(takePendingSnapshot('s1')).toBeNull()
  })
})
