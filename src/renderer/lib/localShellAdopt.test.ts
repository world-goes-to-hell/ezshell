import { describe, expect, it } from 'vitest'
import { adoptedTitle, planAdoption, type LiveLocalShell } from './localShellAdopt'

const shell = (over: Partial<LiveLocalShell>): LiveLocalShell => ({ id: 'local:1', name: 'PowerShell', exited: false, cwd: null, agent: null, ...over })

describe('planAdoption', () => {
  it('takes back running shells and closes ended ones when the window has no local tab', () => {
    const plan = planAdoption([shell({ id: 'local:1' }), shell({ id: 'local:2', exited: true }), shell({ id: 'local:3', agent: 'codex' })], false)
    expect(plan.adopt.map(s => s.id)).toEqual(['local:1', 'local:3'])
    expect(plan.close).toEqual(['local:2'])
  })

  it('leaves everything alone when local tabs are open (the window did not reload)', () => {
    expect(planAdoption([shell({})], true)).toEqual({ adopt: [], close: [] })
  })
})

describe('adoptedTitle', () => {
  it('names a shell after its folder (never the agent: panes may run other agents), else after the shell', () => {
    expect(adoptedTitle(shell({ cwd: 'D:\\work\\gsd', agent: 'codex' }), 0)).toBe('gsd')
    expect(adoptedTitle(shell({ cwd: '/home/me/app', agent: 'claude' }), 0)).toBe('app')
    expect(adoptedTitle(shell({ agent: 'claude' }), 0)).toBe('PowerShell')
    expect(adoptedTitle(shell({ cwd: 'D:\\work\\gsd' }), 0)).toBe('gsd')
    expect(adoptedTitle(shell({}), 0)).toBe('PowerShell')
    expect(adoptedTitle(shell({}), 2)).toBe('PowerShell (3)')
  })
})
