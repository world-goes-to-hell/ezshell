import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalStore, type TerminalInfo } from './terminalStore'

const tab = (id: string): TerminalInfo => ({ id, host: 'example.com', username: 'root', connected: true })
const get = (id: string) => useTerminalStore.getState().terminals.get(id)!

describe('connection state of a tab', () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminals: new Map() })
    useTerminalStore.getState().addTerminal('1', tab('1'))
  })

  it('shows the automatic reconnect attempts', () => {
    useTerminalStore.getState().setReconnecting('1', 2, 5)
    expect(get('1')).toMatchObject({ connected: false, reconnect: { attempt: 2, maxAttempts: 5 }, disconnectNote: null })
  })

  it('keeps the reason a reconnect gave up when the close that follows has none', () => {
    const { setReconnecting, setDisconnected } = useTerminalStore.getState()
    setReconnecting('1', 5, 5)
    setDisconnected('1', '자동 재연결을 5번 시도했지만 실패했습니다.')
    setDisconnected('1')
    expect(get('1')).toMatchObject({ connected: false, reconnect: null, disconnectNote: '자동 재연결을 5번 시도했지만 실패했습니다.' })
  })

  it('clears the attempts and the reason once connected again', () => {
    const { setDisconnected, setConnected } = useTerminalStore.getState()
    setDisconnected('1', '끊김')
    setConnected('1')
    expect(get('1')).toMatchObject({ connected: true, reconnect: null, disconnectNote: null })
  })

  it('ignores a tab that is not open', () => {
    useTerminalStore.getState().setReconnecting('missing', 1, 5)
    expect(useTerminalStore.getState().terminals.has('missing')).toBe(false)
  })
})
