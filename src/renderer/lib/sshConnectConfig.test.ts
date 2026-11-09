import { describe, it, expect } from 'vitest'
import { toSSHConnectConfig } from './sshConnectConfig'

const session = { host: 'web', port: 22, username: 'deploy', authType: 'password' as const, password: 'pw' }

describe('toSSHConnectConfig: root switch', () => {
  it('passes "로그인 후 root 로 전환" and its password on to the main process', () => {
    expect(toSSHConnectConfig({ ...session, suRoot: true, suPassword: 'r00t' })).toMatchObject({ suRoot: true, suPassword: 'r00t' })
  })

  it('leaves the switch off for sessions saved before it existed', () => {
    expect(toSSHConnectConfig(session).suRoot).toBe(false)
  })
})
