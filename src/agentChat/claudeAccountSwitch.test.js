import { describe, expect, it, vi } from 'vitest'
import { createClaudeAccountSwitch } from './claudeAccountSwitch.js'

const SESSION = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
const WORK = '15bbc443-4a4f-40ed-b25f-3cc491356894'
const PERSONAL = 'e43c9717-1247-45d6-a6a7-b03187a091b8'
const ROOTS = { [WORK]: 'C:\\data\\claude-profiles\\work', [PERSONAL]: 'C:\\data\\claude-profiles\\personal' }

function setup({ agent = { kind: 'claude', status: 'idle', sessionId: SESSION, cwd: 'D:\\work' }, profile } = {}) {
  const shells = {
    agentOf: vi.fn(() => agent),
    claudeProfileOf: vi.fn(() => profile),
    claudeRootOf: vi.fn(() => (profile ? ROOTS[profile] : undefined)),
    open: vi.fn(() => ({ id: 'local:9', name: 'pwsh', cwd: 'D:\\work' }))
  }
  const copy = vi.fn(() => ({ folder: 'D--work' }))
  const profileRoot = vi.fn((id, create) => (create ? ROOTS[id] : undefined))
  const accountSwitch = createClaudeAccountSwitch({ shells: () => shells, profileRoot, defaultRoot: 'C:\\Users\\me\\.claude', copy })
  return { shells, copy, profileRoot, accountSwitch }
}

describe('switching the Claude account of a pane', () => {
  it('copies the conversation into the other account, then resumes it in a shell that replaces the pane', () => {
    const { shells, copy, accountSwitch } = setup()
    expect(accountSwitch.switchInPlace({ shellId: 'local:3', profileId: WORK })).toEqual({ id: 'local:9', name: 'pwsh', cwd: 'D:\\work' })
    expect(copy).toHaveBeenCalledWith({ sourceRoot: 'C:\\Users\\me\\.claude', targetRoot: ROOTS[WORK], sessionId: SESSION, cwd: 'D:\\work' })
    expect(shells.open).toHaveBeenCalledWith({ agent: 'claude', cwd: 'D:\\work', claudeProfileId: WORK, resume: SESSION, replacementFor: 'local:3', cols: 80, rows: 24 })
    expect(copy.mock.invocationCallOrder[0]).toBeLessThan(shells.open.mock.invocationCallOrder[0])
  })

  it('moves back to the default account from an added one', () => {
    const { copy, shells, accountSwitch } = setup({ profile: PERSONAL })
    accountSwitch.switchInPlace({ shellId: 'local:3', profileId: 'default' })
    expect(copy).toHaveBeenCalledWith(expect.objectContaining({ sourceRoot: ROOTS[PERSONAL], targetRoot: 'C:\\Users\\me\\.claude' }))
    expect(shells.open).toHaveBeenCalledWith(expect.objectContaining({ claudeProfileId: 'default' }))
  })

  it.each([
    ['a shell without an agent', { agent: null }, 'Claude 세션에서만 계정을 바꿀 수 있습니다.'],
    ['a Codex pane', { agent: { kind: 'codex', status: 'idle', sessionId: SESSION, cwd: 'D:\\work' } }, 'Claude 세션에서만 계정을 바꿀 수 있습니다.'],
    ['a working Claude', { agent: { kind: 'claude', status: 'working', sessionId: SESSION, cwd: 'D:\\work' } }, 'Claude가 작업을 마친 뒤 다시 시도해 주세요.'],
    ['a Claude whose session is not known yet', { agent: { kind: 'claude', status: 'idle', cwd: 'D:\\work' } }, '이 대화를 아직 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'],
    ['a Claude without a folder', { agent: { kind: 'claude', status: 'idle', sessionId: SESSION } }, '이 대화를 아직 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'],
    ['the account it already uses', { profile: WORK }, '이미 이 계정으로 실행 중입니다.']
  ])('refuses %s without copying or opening', (_, options, message) => {
    const { copy, shells, accountSwitch } = setup(options)
    expect(() => accountSwitch.switchInPlace({ shellId: 'local:3', profileId: WORK })).toThrow(message)
    expect(copy).not.toHaveBeenCalled()
    expect(shells.open).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown account', { shellId: 'local:3', profileId: '00000000-0000-4000-8000-000000000000' }],
    ['an account ID that is not a string', { shellId: 'local:3', profileId: 7 }],
    ['a shell ID that is not a local shell', { shellId: 'ssh:1', profileId: WORK }]
  ])('refuses %s', (_, request) => {
    const { copy, shells, accountSwitch } = setup()
    expect(() => accountSwitch.switchInPlace(request)).toThrow()
    expect(copy).not.toHaveBeenCalled()
    expect(shells.open).not.toHaveBeenCalled()
  })

  it('does not open a shell when the copy fails', () => {
    const { copy, shells, accountSwitch } = setup()
    copy.mockImplementation(() => { throw new Error('대화 기록을 찾지 못했습니다.') })
    expect(() => accountSwitch.switchInPlace({ shellId: 'local:3', profileId: WORK })).toThrow('대화 기록을 찾지 못했습니다.')
    expect(shells.open).not.toHaveBeenCalled()
  })
})
