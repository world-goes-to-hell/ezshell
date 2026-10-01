import { describe, it, expect } from 'vitest'
import { createEarlyStreamBuffer } from './earlyStreamBuffer'

describe('createEarlyStreamBuffer', () => {
  it('keeps chunks per stream in arrival order and hands one stream back', () => {
    const buffer = createEarlyStreamBuffer()
    buffer.push('s1', 'Last login: today\r\n')
    buffer.push('s2', 'other pane')
    buffer.push('s1', 'tester@test:~$ ')

    expect(buffer.take('s1')).toBe('Last login: today\r\ntester@test:~$ ')
  })

  it('forgets every stream after take, including ones that belong to other panes', () => {
    const buffer = createEarlyStreamBuffer()
    buffer.push('s1', 'a')
    buffer.push('s2', 'b')
    buffer.take('s1')

    expect(buffer.take('s1')).toBe('')
    expect(buffer.take('s2')).toBe('')
  })

  it('returns an empty string for a stream that sent nothing', () => {
    expect(createEarlyStreamBuffer().take('missing')).toBe('')
  })

  it('stops growing a stream past the limit (keeps what came first)', () => {
    const buffer = createEarlyStreamBuffer(10)
    buffer.push('s1', '12345')
    buffer.push('s1', '67890')
    buffer.push('s1', 'overflow')
    buffer.push('s1', 'x')

    expect(buffer.take('s1')).toBe('1234567890')
  })

  it('takes nothing more for a stream after one chunk did not fit, so no gap appears mid-output', () => {
    const buffer = createEarlyStreamBuffer(10)
    buffer.push('s1', '1234')
    buffer.push('s1', 'too long chunk')
    buffer.push('s1', 'ab')

    expect(buffer.take('s1')).toBe('1234')
  })
})
