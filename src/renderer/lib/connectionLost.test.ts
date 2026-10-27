import { describe, it, expect } from 'vitest'
import { describeConnectionLost, linkConnected, linkDisconnected, linkReconnecting, reconnectFailureText } from './connectionLost'

describe('connection link of a terminal', () => {
  it('records the automatic reconnect attempts', () => {
    expect(linkReconnecting(2, 5)).toEqual({ connected: false, reconnect: { attempt: 2, maxAttempts: 5 }, disconnectNote: null })
  })

  it('keeps the reason already shown when a close without one follows', () => {
    const failed = linkDisconnected(linkReconnecting(5, 5), '실패')
    expect(failed).toEqual({ connected: false, reconnect: null, disconnectNote: '실패' })
    expect(linkDisconnected(failed)).toEqual(failed)
  })

  it('starts without a reason when nothing was shown before', () => {
    expect(linkDisconnected({})).toEqual({ connected: false, reconnect: null, disconnectNote: null })
  })

  it('clears everything once connected again', () => {
    expect(linkConnected()).toEqual({ connected: true, reconnect: null, disconnectNote: null })
  })
})

describe('describeConnectionLost', () => {
  it('says the connection dropped and what can be done', () => {
    expect(describeConnectionLost({})).toEqual({
      title: '연결 끊김',
      detail: '서버와의 연결이 끊겼습니다. 다시 연결하거나 탭을 닫으세요.',
      isWorking: false,
      canAct: true
    })
  })

  it('shows the automatic reconnect attempt while still letting the user act', () => {
    expect(describeConnectionLost({ reconnect: { attempt: 2, maxAttempts: 5 } })).toEqual({
      title: '연결 끊김',
      detail: '자동으로 다시 연결하는 중입니다 (2/5).',
      isWorking: true,
      canAct: true
    })
  })

  it('shows why the last try failed', () => {
    expect(describeConnectionLost({ note: '인증에 실패했습니다.' }).detail).toBe('인증에 실패했습니다.')
  })

  it('blocks the buttons while the user asked to reconnect', () => {
    expect(describeConnectionLost({ isReconnecting: true, reconnect: { attempt: 1, maxAttempts: 5 } })).toEqual({
      title: '연결 끊김',
      detail: '다시 연결하는 중입니다.',
      isWorking: true,
      canAct: false
    })
  })
})

describe('reconnectFailureText', () => {
  it('turns the main process message about giving up into Korean', () => {
    expect(reconnectFailureText('Maximum reconnection attempts reached (5)')).toBe('자동 재연결을 5번 시도했지만 실패했습니다.')
  })

  it('keeps a Korean message as it is and has a fallback', () => {
    expect(reconnectFailureText('호스트 키가 바뀌었습니다.')).toBe('호스트 키가 바뀌었습니다.')
    expect(reconnectFailureText(undefined)).toBe('자동 재연결에 실패했습니다.')
  })
})
