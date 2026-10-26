import { describe, it, expect } from 'vitest'
import { describeTransfer } from './mcpTransfer'

const MB = 1024 * 1024
const upload = (done: number, size = 40 * MB) => ({ direction: 'upload' as const, size, done, startedAt: 0 })

describe('describeTransfer', () => {
  it('shows an upload in progress with amount, percent, speed and time left', () => {
    expect(describeTransfer(upload(10 * MB), 'running', 5000)).toEqual({
      status: 'active',
      label: '올리는 중',
      percent: 25,
      amount: '10.0MB / 40.0MB',
      speed: '2.0MB/s',
      remaining: '15초'
    })
  })

  it('names a download by its direction', () => {
    const result = describeTransfer({ ...upload(0), direction: 'download' }, 'running', 0)
    expect(result.label).toBe('내려받는 중')
  })

  it('does not guess a speed before a second has passed or before anything moved', () => {
    expect(describeTransfer(upload(MB), 'running', 500)).toMatchObject({ speed: null, remaining: null })
    expect(describeTransfer(upload(0), 'running', 5000)).toMatchObject({ speed: null, remaining: null })
  })

  it('fills the bar when the transfer finished', () => {
    expect(describeTransfer(upload(40 * MB), 'done', 9000)).toEqual({
      status: 'done', label: '올림 완료', percent: 100, amount: '40.0MB', speed: null, remaining: null
    })
  })

  it('stops the bar where it was when the transfer failed or was stopped', () => {
    for (const state of ['failed', 'cancelled', 'timeout'] as const) {
      expect(describeTransfer(upload(30 * MB), state, 9000)).toMatchObject({ status: 'stopped', label: '올리기 중단됨', percent: 75, speed: null })
    }
  })

  it('treats an empty file as complete and never goes past 100', () => {
    expect(describeTransfer(upload(0, 0), 'running', 0).percent).toBe(100)
    expect(describeTransfer(upload(50 * MB), 'running', 2000).percent).toBe(100)
  })

  it('rounds the percent down, so 100 only shows when everything arrived', () => {
    expect(describeTransfer(upload(40 * MB - 1), 'running', 2000).percent).toBe(99)
  })
})
