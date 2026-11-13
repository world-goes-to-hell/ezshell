import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createRemoteShells, MAX_SHELLS, MESSAGES } from './shells.js'

/** An ssh2 Client stand-in: checks the host key like ssh2 does, then is ready when told to */
function fakeClient({ autoReady = true } = {}) {
  const client = new EventEmitter()
  client.stream = new EventEmitter()
  client.stream.write = vi.fn()
  client.stream.setWindow = vi.fn()
  client.stream.close = vi.fn()
  client.end = vi.fn()
  client.ready = () => client.emit('ready')
  client.connect = vi.fn((config) => {
    client.config = config
    if (config.hostVerifier(Buffer.from('key')) !== true) {
      queueMicrotask(() => client.emit('error', new Error('Host denied (verification failed)')))
      return
    }
    if (autoReady) queueMicrotask(client.ready)
  })
  client.shell = vi.fn((options, callback) => {
    client.shellOptions = options
    callback(null, client.stream)
  })
  return client
}

const SESSION = { id: 's1', name: 'web-01', host: '10.0.0.5', port: 22, username: 'deploy', password: 'secret' }

function setup({ status = 'trusted', autoReady = true, sessions = [SESSION] } = {}) {
  const clients = []
  const hostKeys = { check: vi.fn(() => ({ status, keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' })), trust: vi.fn() }
  const shells = createRemoteShells({
    findSession: (id) => sessions.find((session) => session.id === id) ?? null,
    hostKeys,
    createClient: () => {
      const client = fakeClient({ autoReady })
      clients.push(client)
      return client
    }
  })
  const handlers = (owner = {}) => ({ cols: 100, rows: 30, owner, onData: vi.fn(), onClose: vi.fn() })
  return { shells, clients, hostKeys, handlers }
}

describe('createRemoteShells', () => {
  it('opens a shell of a saved session with the PC\'s credentials and carries its output', async () => {
    const { shells, clients, handlers } = setup()
    const options = handlers()
    const opened = await shells.open('s1', options)
    expect(opened).toEqual({ shellId: 'r1', name: 'web-01' })
    expect(clients[0].config).toMatchObject({ host: '10.0.0.5', port: 22, username: 'deploy', password: 'secret' })
    expect(clients[0].shellOptions).toMatchObject({ cols: 100, rows: 30 })
    clients[0].stream.emit('data', Buffer.from('hello'))
    expect(options.onData).toHaveBeenCalledWith('hello')
  })

  it('refuses a session that is not saved', async () => {
    const { shells, clients, handlers } = setup()
    await expect(shells.open('nope', handlers())).rejects.toThrow(MESSAGES.unknownSession)
    expect(clients).toHaveLength(0)
  })

  it.each(['unknown', 'changed'])('refuses a server whose key is %s, never saves it, and does not name the server', async (status) => {
    const { shells, clients, hostKeys, handlers } = setup({ status })
    const failure = await shells.open('s1', handlers()).catch((err) => err)
    expect(failure.message).toBe(MESSAGES.hostKey)
    expect(failure.message).not.toContain('10.0.0.5')
    expect(hostKeys.trust).not.toHaveBeenCalled()
    expect(clients[0].shell).not.toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })

  it('takes input and size only from the connection that opened the shell', async () => {
    const { shells, clients, handlers } = setup()
    const owner = {}
    const { shellId } = await shells.open('s1', handlers(owner))
    shells.write(shellId, {}, 'rm -rf /\r')
    shells.resize(shellId, {}, 50, 50)
    shells.close(shellId, {})
    expect(clients[0].stream.write).not.toHaveBeenCalled()
    expect(clients[0].stream.setWindow).not.toHaveBeenCalled()
    expect(shells.count()).toBe(1)
    shells.write(shellId, owner, 'ls\r')
    shells.write(shellId, owner, { not: 'text' })
    shells.resize(shellId, owner, 9999, 'x')
    expect(clients[0].stream.write).toHaveBeenCalledTimes(1)
    expect(clients[0].stream.write).toHaveBeenCalledWith('ls\r')
    expect(clients[0].stream.setWindow).toHaveBeenCalledWith(24, 400, 0, 0)
  })

  it('pauses and resumes reading only for the connection that opened the shell', async () => {
    const { shells, clients, handlers } = setup()
    const owner = {}
    const { shellId } = await shells.open('s1', handlers(owner))
    clients[0].stream.pause = vi.fn()
    clients[0].stream.resume = vi.fn()
    shells.setPaused(shellId, {}, true)
    expect(clients[0].stream.pause).not.toHaveBeenCalled()
    shells.setPaused(shellId, owner, true)
    shells.setPaused(shellId, owner, false)
    expect(clients[0].stream.pause).toHaveBeenCalledTimes(1)
    expect(clients[0].stream.resume).toHaveBeenCalledTimes(1)
  })

  it('closes the connection with the shell, and tells the device once', async () => {
    const { shells, clients, handlers } = setup()
    const options = handlers()
    await shells.open('s1', options)
    clients[0].stream.emit('close')
    clients[0].emit('close')
    expect(options.onClose).toHaveBeenCalledTimes(1)
    expect(clients[0].end).toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })

  it('closes only the shells of the connection that left', async () => {
    const { shells, clients, handlers } = setup()
    const first = {}
    const second = {}
    await shells.open('s1', handlers(first))
    await shells.open('s1', handlers(second))
    shells.closeAll(first)
    expect(clients[0].end).toHaveBeenCalled()
    expect(clients[1].end).not.toHaveBeenCalled()
    shells.closeAll()
    expect(clients[1].end).toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })

  it('counts shells that are still connecting toward the limit', async () => {
    const { shells, handlers } = setup({ autoReady: false })
    const owner = {}
    const attempts = Array.from({ length: MAX_SHELLS }, () => shells.open('s1', handlers(owner)).catch(() => null))
    await expect(shells.open('s1', handlers(owner))).rejects.toThrow(MESSAGES.tooMany)
    shells.closeAll()
    void attempts
  })

  it('closes a shell that finishes connecting after its device left', async () => {
    const { shells, clients, handlers } = setup({ autoReady: false })
    const owner = {}
    const attempt = shells.open('s1', handlers(owner))
    await vi.waitFor(() => expect(clients).toHaveLength(1))
    shells.closeAll(owner)
    clients[0].ready()
    await expect(attempt).rejects.toThrow(MESSAGES.gone)
    expect(clients[0].end).toHaveBeenCalled()
    expect(clients[0].shell).not.toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })

  it('closes a shell that finishes connecting after the app locked', async () => {
    const { shells, clients, handlers } = setup({ autoReady: false })
    const attempt = shells.open('s1', handlers())
    await vi.waitFor(() => expect(clients).toHaveLength(1))
    shells.closeAll()
    clients[0].ready()
    await expect(attempt).rejects.toThrow(MESSAGES.gone)
    expect(clients[0].end).toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })
})

describe('shell output as text', () => {
  it('keeps a character whole when a chunk ends in the middle of it', async () => {
    const { shells, clients, handlers } = setup()
    const options = handlers()
    await shells.open('s1', options)
    const bytes = Buffer.from('가나다')
    // Cut inside the second character
    clients[0].stream.emit('data', bytes.subarray(0, 4))
    clients[0].stream.emit('data', bytes.subarray(4))
    expect(options.onData.mock.calls.map(([text]) => text).join('')).toBe('가나다')
    expect(options.onData.mock.calls.flat().join('')).not.toContain('\ufffd')
  })
})
