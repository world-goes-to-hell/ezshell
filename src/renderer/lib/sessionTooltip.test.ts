import { describe, it, expect } from 'vitest'
import type { Folder, Session } from '../stores/sessionStore'
import { buildSessionDetails, folderPath, formatAddress, formatRelativeTime } from './sessionTooltip'

const base: Session = {
  id: 's1',
  name: '생다 Swarm1',
  host: '10.0.0.5',
  port: 22,
  username: 'deploy',
  authType: 'password',
  password: 'secret-pass',
}

const folders: Folder[] = [
  { id: 'dev', name: '개발' },
  { id: 'bio', name: '[개발] 생물다양성', parentId: 'dev' },
]

const NOW = Date.parse('2026-11-11T12:00:00Z')

describe('formatAddress', () => {
  it('omits the default port', () => {
    expect(formatAddress('root', 'host', 22)).toBe('root@host')
  })

  it('shows a custom port', () => {
    expect(formatAddress('root', 'host', 2222)).toBe('root@host:2222')
  })

  it('works without a username', () => {
    expect(formatAddress(undefined, 'host')).toBe('host')
  })
})

describe('folderPath', () => {
  it('joins nested folder names from the top', () => {
    expect(folderPath('bio', folders)).toBe('개발 / [개발] 생물다양성')
  })

  it('returns undefined for no folder or an unknown folder', () => {
    expect(folderPath(undefined, folders)).toBeUndefined()
    expect(folderPath('missing', folders)).toBeUndefined()
  })

  it('stops on a parent cycle', () => {
    const cyclic: Folder[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ]
    expect(folderPath('a', cyclic)).toBe('B / A')
  })
})

describe('formatRelativeTime', () => {
  it('formats recent times', () => {
    expect(formatRelativeTime('2026-11-11T11:59:30Z', NOW)).toBe('방금 전')
    expect(formatRelativeTime('2026-11-11T11:15:00Z', NOW)).toBe('45분 전')
    expect(formatRelativeTime('2026-11-11T09:00:00Z', NOW)).toBe('3시간 전')
    expect(formatRelativeTime('2026-11-08T12:00:00Z', NOW)).toBe('3일 전')
  })

  it('falls back to a date for old connections', () => {
    expect(formatRelativeTime('2026-08-01T12:00:00Z', NOW)).toMatch(/^2026-08-0[12]$/)
  })

  it('ignores invalid timestamps', () => {
    expect(formatRelativeTime('not a date', NOW)).toBeUndefined()
  })
})

describe('buildSessionDetails', () => {
  it('lists folder path and auth type for a plain session', () => {
    const details = buildSessionDetails({ ...base, folderId: 'bio' }, folders, undefined, NOW)
    expect(details).toEqual([
      { label: '폴더', value: '개발 / [개발] 생물다양성' },
      { label: '인증', value: '비밀번호' },
    ])
  })

  it('adds jump host, root switch, DB accounts, auto reconnect and last connection', () => {
    const session: Session = {
      ...base,
      authType: 'privateKey',
      privateKeyPath: 'C:\\keys\\id_rsa',
      useJumpHost: true,
      jumpHost: 'bastion',
      jumpPort: 2022,
      jumpUsername: 'jump',
      jumpPassword: 'jump-secret',
      suRoot: true,
      suPassword: 'root-secret',
      autoReconnect: true,
      dbConnections: [{} as never, {} as never],
    }
    const details = buildSessionDetails(session, folders, '2026-11-11T10:00:00Z', NOW)
    expect(details).toEqual([
      { label: '인증', value: '키 파일' },
      { label: '점프 호스트', value: 'jump@bastion:2022' },
      { label: '로그인 후', value: 'root 로 전환 (su -)' },
      { label: 'DB 계정', value: '2개 저장됨' },
      { label: '재연결', value: '자동' },
      { label: '최근 접속', value: '2시간 전' },
    ])
  })

  it('never includes secrets or key paths', () => {
    const session: Session = {
      ...base,
      authType: 'privateKey',
      privateKeyPath: 'C:\\keys\\id_rsa',
      passphrase: 'pp-secret',
      useJumpHost: true,
      jumpHost: 'bastion',
      jumpPassword: 'jump-secret',
      suRoot: true,
      suPassword: 'root-secret',
      postConnectScript: 'export TOKEN=abc',
    }
    const text = JSON.stringify(buildSessionDetails(session, folders, undefined, NOW))
    for (const secret of ['secret-pass', 'pp-secret', 'jump-secret', 'root-secret', 'id_rsa', 'TOKEN']) {
      expect(text).not.toContain(secret)
    }
  })

  it('skips the jump host when it is enabled without an address', () => {
    const details = buildSessionDetails({ ...base, useJumpHost: true }, folders, undefined, NOW)
    expect(details.some(d => d.label === '점프 호스트')).toBe(false)
  })
})
