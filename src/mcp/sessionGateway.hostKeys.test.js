import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import gatewayModule from './sessionGateway.js'
import storeModule from '../hostKeys/hostKeyStore.js'
import helper from '../hostKeys/hostKeys.testhelper.js'

const { createSessionGateway } = gatewayModule
const { createHostKeyStore } = storeModule
const { hostKey } = helper

const session = { id: 's1', name: 'dev', host: 'dev.example', port: 22, username: 'app', authType: 'password', password: 'pw' }

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-gateway-hostkeys-'))
  return createHostKeyStore({ filePath: path.join(dir, 'known-hosts.json') })
}

/** Fake ssh2 Client that offers `key` to hostVerifier like the real handshake, then answers `pwd` */
function verifyingSsh(key) {
  const created = []
  const createClient = () => {
    const client = new EventEmitter()
    client.end = () => client.emit('close')
    client.connect = (options) => {
      client.options = options
      setImmediate(() => {
        const accepted = typeof options.hostVerifier === 'function' && options.hostVerifier(key) === true
        if (!accepted) { client.emit('error', new Error('Host denied (verification failed)')); return }
        client.emit('ready')
      })
    }
    client.exec = (command, cb) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signal = () => {}
      stream.close = () => {}
      cb(null, stream)
      setImmediate(() => {
        stream.emit('data', Buffer.from('/home/app\n'))
        stream.emit('close', 0)
      })
    }
    created.push(client)
    return client
  }
  return { createClient, created }
}

describe('sessionGateway host keys', () => {
  it('does not connect at all without a host key store', async () => {
    const ssh = verifyingSsh(hostKey())
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await expect(gateway.resolveCwd(session)).rejects.toThrow('호스트 키')
    gateway.closeAll()
  })

  it('refuses a server whose key was never confirmed in the app', async () => {
    const hostKeys = tempStore()
    const ssh = verifyingSsh(hostKey())
    const gateway = createSessionGateway({ createClient: ssh.createClient, hostKeys })
    const err = await gateway.resolveCwd(session).catch(e => e)
    expect(err.message).toContain('호스트 키')
    expect(hostKeys.check('dev.example', 22, hostKey()).status).toBe('unknown')
    gateway.closeAll()
  })

  it('refuses a server whose key changed', async () => {
    const hostKeys = tempStore()
    hostKeys.trust('dev.example', 22, hostKey('ssh-ed25519', 1))
    const ssh = verifyingSsh(hostKey('ssh-ed25519', 2))
    const gateway = createSessionGateway({ createClient: ssh.createClient, hostKeys })
    const err = await gateway.resolveCwd(session).catch(e => e)
    expect(err.message).toContain('다릅니다')
    expect(hostKeys.check('dev.example', 22, hostKey('ssh-ed25519', 1)).status).toBe('trusted')
    gateway.closeAll()
  })

  it('connects to a server whose key is saved', async () => {
    const hostKeys = tempStore()
    hostKeys.trust('dev.example', 22, hostKey())
    const ssh = verifyingSsh(hostKey())
    const gateway = createSessionGateway({ createClient: ssh.createClient, hostKeys })
    await expect(gateway.resolveCwd(session)).resolves.toBe('/home/app')
    gateway.closeAll()
  })

  it('checks the jump host and the target separately', async () => {
    const hostKeys = tempStore()
    hostKeys.trust('bastion', 22, hostKey())
    const ssh = verifyingSsh(hostKey())
    const jumpSession = { ...session, useJumpHost: true, jumpHost: 'bastion', jumpUsername: 'j', jumpAuthType: 'password', jumpPassword: 'p' }
    const gateway = createSessionGateway({
      createClient: () => {
        const client = ssh.createClient()
        client.forwardOut = (a, b, host, port, cb) => setImmediate(() => cb(null, {}))
        return client
      },
      hostKeys
    })
    const err = await gateway.resolveCwd(jumpSession).catch(e => e)
    expect(err.message).toContain('호스트 키')
    hostKeys.trust('dev.example', 22, hostKey())
    await expect(gateway.resolveCwd(jumpSession)).resolves.toBe('/home/app')
    gateway.closeAll()
  })
})
