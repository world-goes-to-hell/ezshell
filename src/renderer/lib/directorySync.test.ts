import { describe, it, expect } from 'vitest'
import { localFollowsRemote, remoteFollowsLocal } from './directorySync'

const folder = (name: string) => ({ name, type: 'directory' })
const file = (name: string) => ({ name, type: 'file' })

describe('localFollowsRemote', () => {
  it('enters the folder of the same name', () => {
    expect(localFollowsRemote('/srv', '/srv/app', 'C:\\work', [folder('app')])).toEqual({ kind: 'go', path: 'C:\\work\\app' })
    expect(localFollowsRemote('/srv', '/srv/app', 'C:\\', [folder('app')])).toEqual({ kind: 'go', path: 'C:\\app' })
    expect(localFollowsRemote('/', '/app', '/home/me', [folder('app')])).toEqual({ kind: 'go', path: '/home/me/app' })
  })

  it('reports a folder the local side does not have (a file of that name does not count)', () => {
    expect(localFollowsRemote('/srv', '/srv/logs', 'C:\\work', [folder('app'), file('logs')])).toEqual({ kind: 'missing', name: 'logs' })
  })

  it('goes up as many levels as the remote did', () => {
    expect(localFollowsRemote('/srv/app/conf', '/srv', 'C:\\work\\app\\conf', [])).toEqual({ kind: 'go', path: 'C:\\work\\' })
    expect(localFollowsRemote('/srv/app', '/srv', '/home/me/app', [])).toEqual({ kind: 'go', path: '/home/me' })
    expect(localFollowsRemote('/a/b', '/', '/x', [])).toEqual({ kind: 'go', path: '/' })
  })

  it('never goes above the drive', () => {
    expect(localFollowsRemote('/srv/app', '/srv', 'C:\\', [])).toBeNull()
    expect(localFollowsRemote('/a/b/c', '/', 'C:\\work', [])).toEqual({ kind: 'go', path: 'C:\\' })
  })

  it('does nothing when the path did not change', () => {
    expect(localFollowsRemote('/srv', '/srv', 'C:\\work', [folder('srv')])).toBeNull()
  })
})

describe('remoteFollowsLocal', () => {
  it('enters the folder of the same name', () => {
    expect(remoteFollowsLocal('C:\\work', 'C:\\work\\app', '/srv', [folder('app')])).toEqual({ kind: 'go', path: '/srv/app' })
    expect(remoteFollowsLocal('C:\\', 'C:\\app', '/', [folder('app')])).toEqual({ kind: 'go', path: '/app' })
  })

  it('reports a folder the remote side does not have', () => {
    expect(remoteFollowsLocal('C:\\work', 'C:\\work\\tmp', '/srv', [folder('app')])).toEqual({ kind: 'missing', name: 'tmp' })
  })

  it('goes up as many levels as the local side did, stopping at the root', () => {
    expect(remoteFollowsLocal('C:\\work\\app\\conf', 'C:\\work', '/srv/app/conf', [])).toEqual({ kind: 'go', path: '/srv' })
    expect(remoteFollowsLocal('/home/me/app', '/home', '/srv', [])).toEqual({ kind: 'go', path: '/' })
  })
})
