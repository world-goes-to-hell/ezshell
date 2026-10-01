import { describe, it, expect } from 'vitest'
import { formatHostLabel } from './popoutLabels'

describe('formatHostLabel', () => {
  it('shows user@host for the default port', () => {
    expect(formatHostLabel({ username: 'root', host: 'web01', port: 22 })).toBe('root@web01')
  })

  it('adds a non-default port', () => {
    expect(formatHostLabel({ username: 'deploy', host: '10.0.0.5', port: 2222 })).toBe('deploy@10.0.0.5:2222')
  })

  it('returns an empty string when the session is unknown', () => {
    expect(formatHostLabel(null)).toBe('')
    expect(formatHostLabel({ username: '', host: '', port: 22 })).toBe('')
  })
})
