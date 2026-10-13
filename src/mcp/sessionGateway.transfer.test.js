import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import gatewayModule from './sessionGateway.js'
import fakeModule from './fakeSsh.testhelper.js'

const { createSessionGateway } = gatewayModule
const { fakeSsh } = fakeModule

const session = { id: 's1', name: 'dev', host: 'dev.example', port: 22, username: 'app', authType: 'password', password: 'pw' }
const SFTP_FAILED = '이 서버에서는 파일 전송(SFTP)을 사용할 수 없습니다.'
/** Connections are closed on a later tick */
const settle = () => new Promise(resolve => setImmediate(resolve))

function setup(options = {}) {
  const channels = []
  const ssh = fakeSsh({
    respond: () => ({ stdout: 'ok\n' }),
    sftp: () => {
      const channel = Object.assign(new EventEmitter(), { ended: false, end() { this.ended = true; this.emit('close') } })
      channels.push(channel)
      return channel
    }
  })
  const gateway = createSessionGateway({ createClient: ssh.createClient, ...options })
  return { ssh, gateway, channels }
}

describe('openTransfer', () => {
  it('opens a channel of its own, apart from the one the file tools share', async () => {
    const { gateway, channels } = setup()
    const shared = await gateway.useSftp(session, {}, async (sftp) => sftp)
    const first = await gateway.openTransfer(session)
    const second = await gateway.openTransfer(session)
    expect(channels).toHaveLength(3)
    expect(first.sftp).not.toBe(shared)
    expect(second.sftp).not.toBe(first.sftp)
    first.close()
    second.close()
    expect(first.sftp.ended).toBe(true)
    expect(shared.ended).toBe(false)
    gateway.closeAll()
  })

  it('does not hold the queue: commands of the session run while a transfer is open', async () => {
    const { gateway } = setup()
    const transfer = await gateway.openTransfer(session)
    expect(await gateway.run(session, 'ls')).toMatchObject({ stdout: 'ok\n' })
    expect(await gateway.useSftp(session, {}, async () => 'file work')).toBe('file work')
    transfer.close()
    gateway.closeAll()
  })

  it('keeps a retired connection open until the transfer is closed', async () => {
    const { ssh, gateway } = setup()
    const transfer = await gateway.openTransfer(session)
    gateway.retireAll()
    expect(gateway.hasLingering()).toBe(true)
    expect(ssh.created[0].ended).toBe(false)
    transfer.close()
    expect(gateway.hasLingering()).toBe(false)
    await settle()
    expect(ssh.created[0].ended).toBe(true)
  })

  it('closes a retired connection after the grace time even when the transfer is still open', async () => {
    const { ssh, gateway } = setup()
    await gateway.openTransfer(session)
    gateway.retireAll({ graceMs: 20 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ssh.created[0].ended).toBe(true)
  })

  it('counts the transfer once, however often close is called', async () => {
    const { ssh, gateway } = setup()
    const first = await gateway.openTransfer(session)
    const second = await gateway.openTransfer(session)
    first.close()
    first.close()
    gateway.retireAll()
    await settle()
    expect(ssh.created[0].ended).toBe(false)
    second.close()
    await settle()
    expect(ssh.created[0].ended).toBe(true)
  })

  it('tells when the channel ends', async () => {
    const { gateway } = setup()
    const transfer = await gateway.openTransfer(session)
    let ended = false
    transfer.closed.then(() => { ended = true })
    transfer.sftp.emit('close')
    await new Promise(resolve => setImmediate(resolve))
    expect(ended).toBe(true)
    transfer.close()
    gateway.closeAll()
  })

  it('reports a server without SFTP and does not keep the connection for it', async () => {
    const ssh = fakeSsh({ sftp: () => new Error('Unable to start subsystem: sftp at 10.0.0.1') })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await expect(gateway.openTransfer(session)).rejects.toMatchObject({ userMessage: SFTP_FAILED })
    gateway.retireAll()
    expect(gateway.hasLingering()).toBe(false)
  })

  it('gives up on a channel that does not open in time', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient, execTimeoutMs: 20 })
    // The home directory is known, so only the channel request is left to hang
    await gateway.resolveCwd(session)
    ssh.created[0].sftp = () => {}
    await expect(gateway.openTransfer(session)).rejects.toMatchObject({ userMessage: SFTP_FAILED })
    gateway.retireAll()
    expect(gateway.hasLingering()).toBe(false)
  })

  it('does not open anything for a request that is already cancelled', async () => {
    const { ssh, gateway } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(gateway.openTransfer(session, { signal: controller.signal })).rejects.toMatchObject({ userMessage: '요청이 취소되었습니다.' })
    expect(ssh.sftpOpens).toHaveLength(0)
  })
})
