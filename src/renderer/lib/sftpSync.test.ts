import { describe, it, expect } from 'vitest'
import { resolveTerminalPath } from './sftpSync'

describe('resolveTerminalPath', () => {
  it('keeps an absolute path', () => {
    expect(resolveTerminalPath('/var/log/nginx', null)).toBe('/var/log/nginx')
  })

  it('puts the home folder in place of ~', () => {
    expect(resolveTerminalPath('~', '/home/wcp')).toBe('/home/wcp')
    expect(resolveTerminalPath('~/app/conf', '/home/wcp/')).toBe('/home/wcp/app/conf')
    expect(resolveTerminalPath('~', '/')).toBe('/')
  })

  it('gives nothing when the path is unknown or the home folder is', () => {
    expect(resolveTerminalPath(undefined, '/home/wcp')).toBeNull()
    expect(resolveTerminalPath('  ', '/home/wcp')).toBeNull()
    expect(resolveTerminalPath('~/app', null)).toBeNull()
    expect(resolveTerminalPath('app', '/home/wcp')).toBeNull()
    expect(resolveTerminalPath('~other/app', '/home/wcp')).toBeNull()
  })
})
