import { describe, it, expect } from 'vitest'
import { containerCommand, isRunning, publishedPorts, isContainerName } from './containers'

describe('containerCommand (typed for the user, never run by the app)', () => {
  it('builds the commands for a plain name', () => {
    expect(containerCommand('shell', 'web')).toBe('docker exec -it web sh')
    expect(containerCommand('restart', 'my_app-1')).toBe('docker restart my_app-1')
    expect(containerCommand('stop', 'db.1')).toBe('docker stop db.1')
    expect(containerCommand('start', 'db.1')).toBe('docker start db.1')
  })

  it('refuses a name that would add to the command line', () => {
    for (const name of ['web; rm -rf /', '$(reboot)', 'a b', '-rf', '`id`', '']) {
      expect(containerCommand('shell', name)).toBeNull()
      expect(isContainerName(name)).toBe(false)
    }
  })
})

describe('isRunning', () => {
  const base = { id: '', name: 'x', image: '', ports: '' }
  it('reads the state, or the status when the server gives no state', () => {
    expect(isRunning({ ...base, state: 'running', status: 'Up 2 hours' })).toBe(true)
    expect(isRunning({ ...base, state: 'exited', status: 'Exited (0) 3 days ago' })).toBe(false)
    expect(isRunning({ ...base, state: '', status: 'Up 2 hours' })).toBe(true)
    expect(isRunning({ ...base, state: '', status: 'Exited (1) 5 minutes ago' })).toBe(false)
  })
})

describe('publishedPorts', () => {
  it('shows each published port once, without the address', () => {
    expect(publishedPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp')).toBe('8080→80')
    expect(publishedPorts('0.0.0.0:5432->5432/tcp, 0.0.0.0:9000-9002->9000-9002/tcp')).toBe('5432→5432, 9000-9002→9000-9002')
  })

  it('leaves out ports that are not published', () => {
    expect(publishedPorts('80/tcp, 443/tcp')).toBe('')
    expect(publishedPorts('')).toBe('')
  })
})
