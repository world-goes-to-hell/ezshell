import { describe, expect, it } from 'vitest'
import { developmentRunLabel, developmentRunPort } from './developmentRun'

describe('development server status', () => {
  it('keeps the process state separate from the discovered address', () => {
    expect(developmentRunLabel({ status: 'running', exitCode: null })).toBe('실행 중')
    expect(developmentRunLabel({ status: 'starting', exitCode: null })).toBe('시작 중')
    expect(developmentRunLabel({ status: 'stopping', exitCode: null })).toBe('중지 중')
    expect(developmentRunLabel({ status: 'exited', exitCode: 23 })).toBe('종료 23')
    expect(developmentRunPort('http://localhost:5173')).toBe(':5173')
    expect(developmentRunPort(null)).toBe('')
  })
})
