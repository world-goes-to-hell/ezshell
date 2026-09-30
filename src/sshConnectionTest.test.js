import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import sshTest from './sshConnectionTest.js'

const { describeSshError, testSshConnection } = sshTest

const sshError = (message, props = {}) => Object.assign(new Error(message), props)

/**
 * Fake ssh2 Client. `behavior(client, options)` decides what happens on connect().
 */
function fakeClientFactory(behaviors) {
  const created = []
  const createClient = () => {
    const client = new EventEmitter()
    const index = created.length
    client.options = null
    client.ended = false
    client.connect = (options) => {
      client.options = options
      setImmediate(() => behaviors[index](client, options))
    }
    client.end = () => { client.ended = true }
    client.forwardOut = (srcIp, srcPort, dstHost, dstPort, cb) => {
      client.forwarded = { dstHost, dstPort }
      setImmediate(() => cb(null, { tunnel: true }))
    }
    created.push(client)
    return client
  }
  return { createClient, created }
}

const ready = (client) => client.emit('ready')
const fail = (err) => (client) => client.emit('error', err)

const baseConfig = {
  host: 'example.com',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'secret',
  connectTimeout: 5000
}

describe('describeSshError', () => {
  it('explains authentication failure', () => {
    const result = describeSshError(sshError('All configured authentication methods failed', { level: 'client-authentication' }))
    expect(result.error).toContain('인증')
  })

  it('explains connection refused', () => {
    const result = describeSshError(sshError('connect ECONNREFUSED 1.2.3.4:22', { code: 'ECONNREFUSED' }))
    expect(result.error).toContain('거부')
  })

  it('explains unknown host', () => {
    const result = describeSshError(sshError('getaddrinfo ENOTFOUND nope', { code: 'ENOTFOUND' }))
    expect(result.error).toContain('호스트')
  })

  it('explains timeouts', () => {
    const result = describeSshError(sshError('Timed out while waiting for handshake', { level: 'client-timeout' }))
    expect(result.error).toContain('시간')
  })

  it('explains a missing passphrase for an encrypted key', () => {
    const result = describeSshError(sshError('Cannot parse privateKey: Encrypted private key detected, but no passphrase given'))
    expect(result.error).toContain('Passphrase')
  })

  it('keeps the raw message as detail', () => {
    const result = describeSshError(sshError('something odd'))
    expect(result.detail).toBe('something odd')
  })
})

describe('testSshConnection', () => {
  it('succeeds when the server accepts authentication and closes the connection', async () => {
    const { createClient, created } = fakeClientFactory([ready])
    const result = await testSshConnection(baseConfig, { createClient })

    expect(result.success).toBe(true)
    expect(result.viaJumpHost).toBe(false)
    expect(typeof result.elapsedMs).toBe('number')
    expect(created[0].ended).toBe(true)
    expect(created[0].options).toMatchObject({ host: 'example.com', port: 22, username: 'root', password: 'secret', readyTimeout: 5000 })
  })

  it('reports an authentication failure on the target', async () => {
    const { createClient, created } = fakeClientFactory([
      fail(sshError('All configured authentication methods failed', { level: 'client-authentication' }))
    ])
    const result = await testSshConnection(baseConfig, { createClient })

    expect(result.success).toBe(false)
    expect(result.stage).toBe('target')
    expect(result.error).toContain('인증')
    expect(created[0].ended).toBe(true)
  })

  it('reads the private key file for key authentication', async () => {
    const { createClient, created } = fakeClientFactory([ready])
    const readFile = (path) => Buffer.from(`key:${path}`)
    const config = { ...baseConfig, authType: 'privateKey', privateKeyPath: 'C:/k/id_rsa', passphrase: 'pp', password: undefined }
    const result = await testSshConnection(config, { createClient, readFile })

    expect(result.success).toBe(true)
    expect(created[0].options.privateKey.toString()).toBe('key:C:/k/id_rsa')
    expect(created[0].options.passphrase).toBe('pp')
    expect(created[0].options.password).toBeUndefined()
  })

  it('fails without connecting when the private key path is empty', async () => {
    const { createClient, created } = fakeClientFactory([])
    const config = { ...baseConfig, authType: 'privateKey', privateKeyPath: '' }
    const result = await testSshConnection(config, { createClient })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Private Key')
    expect(created).toHaveLength(0)
  })

  it('fails when the private key file cannot be read', async () => {
    const { createClient } = fakeClientFactory([])
    const readFile = () => { throw new Error('ENOENT: no such file') }
    const config = { ...baseConfig, authType: 'privateKey', privateKeyPath: 'C:/missing' }
    const result = await testSshConnection(config, { createClient, readFile })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Private Key')
    expect(result.detail).toContain('ENOENT')
  })

  it('tunnels through the jump host and closes both connections', async () => {
    const { createClient, created } = fakeClientFactory([ready, ready])
    const config = {
      ...baseConfig,
      useJumpHost: true,
      jumpHost: 'bastion',
      jumpPort: 2222,
      jumpUsername: 'jump',
      jumpAuthType: 'password',
      jumpPassword: 'jp'
    }
    const result = await testSshConnection(config, { createClient })

    expect(result.success).toBe(true)
    expect(result.viaJumpHost).toBe(true)
    expect(created[0].options).toMatchObject({ host: 'bastion', port: 2222, username: 'jump', password: 'jp' })
    expect(created[0].forwarded).toEqual({ dstHost: 'example.com', dstPort: 22 })
    expect(created[1].options.sock).toEqual({ tunnel: true })
    expect(created[0].ended).toBe(true)
    expect(created[1].ended).toBe(true)
  })

  it('reports a jump host failure with the jump stage', async () => {
    const { createClient } = fakeClientFactory([
      fail(sshError('connect ECONNREFUSED', { code: 'ECONNREFUSED' }))
    ])
    const config = { ...baseConfig, useJumpHost: true, jumpHost: 'bastion', jumpUsername: 'jump' }
    const result = await testSshConnection(config, { createClient })

    expect(result.success).toBe(false)
    expect(result.stage).toBe('jump')
  })

  it('gives up when the server never answers', async () => {
    const { createClient, created } = fakeClientFactory([() => {}])
    const result = await testSshConnection({ ...baseConfig, connectTimeout: 10 }, { createClient, graceMs: 10 })

    expect(result.success).toBe(false)
    expect(result.error).toContain('시간')
    expect(created[0].ended).toBe(true)
  })

  it('rejects a config without host or username', async () => {
    const { createClient, created } = fakeClientFactory([])
    const result = await testSshConnection({ ...baseConfig, host: ' ' }, { createClient })

    expect(result.success).toBe(false)
    expect(created).toHaveLength(0)
  })
})
