import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import rootSwitchModule from './rootSwitch.js'

const { switchToRoot, ROOT_SWITCH_TIMEOUT_MS } = rootSwitchModule

/** An ssh2 shell channel: what the app writes, and output the test sends back */
function fakeShell() {
  const stream = new EventEmitter()
  stream.written = []
  stream.write = (text) => { stream.written.push(text) }
  stream.print = (text) => stream.emit('data', Buffer.from(text))
  return stream
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('switchToRoot', () => {
  it('runs su -, answers the password prompt once, and reports a root prompt', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'r00t' })
    expect(shell.written).toEqual(['su -\r'])
    shell.print('su -\r\nPassword: ')
    expect(shell.written).toEqual(['su -\r', 'r00t\r'])
    shell.print('\r\nLast login: Tue\r\n[root@web ~]# ')
    await expect(done).resolves.toEqual({ outcome: 'switched' })
    expect(shell.listenerCount('data')).toBe(0)
  })

  it('understands Korean prompts and a prompt split across pieces of output', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'pw' })
    shell.print('su -\r\n암')
    expect(shell.written).toHaveLength(1)
    shell.print('호: ')
    expect(shell.written[1]).toBe('pw\r')
    shell.print('\r\nroot@web:~# ')
    await expect(done).resolves.toEqual({ outcome: 'switched' })
  })

  it('looks past colour codes around the prompt', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'pw' })
    shell.print('\u001b[1mPassword:\u001b[0m ')
    expect(shell.written[1]).toBe('pw\r')
    shell.print('\r\n\u001b[31m[root@web ~]#\u001b[0m ')
    await expect(done).resolves.toEqual({ outcome: 'switched' })
  })

  it('reports a wrong password and never sends it again', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'bad' })
    shell.print('Password: ')
    shell.print('\r\nsu: Authentication failure\r\n[user@web ~]$ ')
    await expect(done).resolves.toEqual({ outcome: 'failed' })
    shell.print('Password: ')
    expect(shell.written.filter(text => text === 'bad\r')).toHaveLength(1)
  })

  it('reports a Korean failure message', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'bad' })
    shell.print('암호: ')
    shell.print('\r\nsu: 인증 실패\r\n')
    await expect(done).resolves.toEqual({ outcome: 'failed' })
  })

  it('never sends the password when su does not ask for one', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'secret' })
    shell.print('su -\r\n[root@web ~]# ')
    vi.advanceTimersByTime(ROOT_SWITCH_TIMEOUT_MS)
    await expect(done).resolves.toEqual({ outcome: 'no-prompt' })
    expect(shell.written).toEqual(['su -\r'])
  })

  it('gives up without knowing when nothing comes back after the password', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'pw' })
    shell.print('Password: ')
    vi.advanceTimersByTime(ROOT_SWITCH_TIMEOUT_MS)
    await expect(done).resolves.toEqual({ outcome: 'unknown' })
    expect(shell.listenerCount('data')).toBe(0)
  })

  it('does not take a login banner that says sorry or permission denied for a failure', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'pw' })
    shell.print('Sorry, maintenance tonight. Permission denied for guests.\r\n')
    shell.print('Password: ')
    expect(shell.written[1]).toBe('pw\r')
    shell.print('\r\n[root@web ~]# ')
    await expect(done).resolves.toEqual({ outcome: 'switched' })
  })

  it('reports su refusing before it asks', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'pw' })
    shell.print('su -\r\nsu: user root does not exist\r\n$ ')
    await expect(done).resolves.toEqual({ outcome: 'failed' })
    expect(shell.written).toEqual(['su -\r'])
  })

  it('does not take a message that mentions a password for the prompt', async () => {
    const shell = fakeShell()
    const done = switchToRoot(shell, { password: 'pw' })
    shell.print('Your password will expire in 5 days.\r\n')
    expect(shell.written).toEqual(['su -\r'])
    shell.print('Password: ')
    expect(shell.written[1]).toBe('pw\r')
    shell.print('\r\n# ')
    await expect(done).resolves.toEqual({ outcome: 'switched' })
  })
})
