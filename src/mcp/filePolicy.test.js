import { describe, it, expect } from 'vitest'
import filePolicyModule from './filePolicy.js'
import policyModule from './commandPolicy.js'

const { classifyFileWrite, refuseSystemPath } = filePolicyModule
const { needsApproval } = policyModule

const target = (change) => ({ requestedPath: '/srv/app/config.yml', path: '/srv/app/config.yml', exists: true, isSymlink: false, ...change })

describe('refuseSystemPath', () => {
  it.each([['/proc/sysrq-trigger'], ['/proc/sys/kernel/core_pattern'], ['/sys/power/state'], ['/dev/sda'], ['/dev/null'], ['/proc'], ['/sys'], ['/dev']])('refuses %s', (path) => {
    expect(refuseSystemPath(path)).toBe('시스템 경로(/proc, /sys, /dev)에는 쓸 수 없습니다.')
  })

  it.each([['/srv/proc/a'], ['/procfile'], ['/home/dev/a.txt'], ['/etc/sysctl.conf'], ['/devices.txt']])('allows %s', (path) => {
    expect(refuseSystemPath(path)).toBeNull()
  })
})

describe('classifyFileWrite', () => {
  it('is always dangerous, so every alert level asks the user', () => {
    const verdict = classifyFileWrite(target())
    expect(verdict.level).toBe('danger')
    for (const alertLevel of ['all', 'medium', 'danger', 'something-else']) expect(needsApproval(verdict.level, alertLevel)).toBe(true)
  })

  it('says whether a file is created or overwritten', () => {
    expect(classifyFileWrite(target()).reasons).toContain('기존 파일 덮어쓰기')
    expect(classifyFileWrite(target({ exists: false })).reasons).toContain('새 파일 만들기')
  })

  it.each([
    ['/srv/app/.env'],
    ['/home/deploy/.ssh/authorized_keys'],
    ['/etc/sudoers'],
    ['/srv/app/application-prod.yml'],
    ['/srv/keys/server.pem']
  ])('flags %s as a place for secrets', (path) => {
    expect(classifyFileWrite(target({ requestedPath: path, path })).reasons).toContain(`비밀 정보가 있을 수 있는 경로: ${path}`)
  })

  it('judges the real file behind a link, and names both paths', () => {
    const verdict = classifyFileWrite(target({ requestedPath: '/tmp/notes.txt', path: '/etc/sudoers', isSymlink: true }))
    expect(verdict.reasons).toContain('비밀 정보가 있을 수 있는 경로: /etc/sudoers')
    expect(verdict.reasons).toContain('심볼릭 링크를 따라 다른 파일에 씀: /tmp/notes.txt → /etc/sudoers')
  })

  it('also flags a sensitive requested path when the real one looks harmless', () => {
    const verdict = classifyFileWrite(target({ requestedPath: '/srv/app/.env', path: '/srv/shared/settings', isSymlink: true }))
    expect(verdict.reasons).toContain('비밀 정보가 있을 수 있는 경로: /srv/app/.env')
  })

  it('does not repeat a reason when both paths are the same', () => {
    const { reasons } = classifyFileWrite(target({ requestedPath: '/srv/app/.env', path: '/srv/app/.env' }))
    expect(reasons.filter(reason => reason.includes('.env'))).toHaveLength(1)
  })

  it.each([
    ['/home/deploy/.bashrc'],
    ['/home/deploy/.profile'],
    ['/etc/profile.d/app.sh'],
    ['/etc/cron.d/backup'],
    ['/var/spool/cron/root'],
    ['/etc/systemd/system/app.service'],
    ['/etc/ssh/sshd_config'],
    ['/etc/passwd'],
    ['/etc/ld.so.preload'],
    ['/etc/pam.d/sshd'],
    ['/etc/sudoers.d/deploy']
  ])('flags %s as a file that runs at login or boot, or decides who may do what', (path) => {
    expect(classifyFileWrite(target({ requestedPath: path, path })).reasons).toContain(`로그인·예약 실행·권한에 영향을 주는 파일: ${path}`)
  })

  it('does not flag an ordinary file that way', () => {
    const { reasons } = classifyFileWrite(target())
    expect(reasons.some(reason => reason.startsWith('로그인'))).toBe(false)
  })

  it('makes a new file in a place for secrets readable by its owner only, and says so', () => {
    const secret = classifyFileWrite(target({ requestedPath: '/srv/app/prod.pem', path: '/srv/app/prod.pem', exists: false }))
    expect(secret.newFileMode).toBe(0o600)
    expect(secret.reasons).toContain('비밀 경로이므로 소유자만 읽을 수 있게 만듦 (권한 600)')
    expect(classifyFileWrite(target({ exists: false })).newFileMode).toBe(0o644)
    // An existing file keeps the mode it has
    expect(classifyFileWrite(target({ requestedPath: '/srv/app/.env', path: '/srv/app/.env' })).reasons.some(reason => reason.includes('600'))).toBe(false)
  })

  it('notes a parent folder that resolved elsewhere without calling it a link to another file', () => {
    const { reasons } = classifyFileWrite(target({ requestedPath: '/var/www/index.html', path: '/srv/www/index.html' }))
    expect(reasons).toContain('실제 경로가 요청한 경로와 다름: /var/www/index.html → /srv/www/index.html')
  })
})
