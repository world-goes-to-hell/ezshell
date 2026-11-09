import { describe, it, expect } from 'vitest'
import { rootSwitchNotice } from './rootSwitch'

describe('rootSwitchNotice', () => {
  it('says nothing when the switch worked or was not asked for', () => {
    expect(rootSwitchNotice('switched')).toBeNull()
    expect(rootSwitchNotice(undefined)).toBeNull()
  })

  it('warns when su refused, and says the terminal is still open as the login account', () => {
    const notice = rootSwitchNotice('failed')!
    expect(notice.type).toBe('warning')
    expect(notice.title).toContain('root')
    expect(notice.message).toContain('로그인 계정')
  })

  it('says the password was not sent when su did not ask for it', () => {
    expect(rootSwitchNotice('no-prompt')!.message).toContain('보내지 않았')
  })

  it('asks to check the terminal when su did not answer', () => {
    expect(rootSwitchNotice('unknown')!.message).toContain('터미널')
  })
})
