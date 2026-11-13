import { describe, it, expect } from 'vitest'
import net from 'net'
import { PassThrough } from 'stream'
import localTunnel from './localTunnel.js'

const { openOneShotTunnel } = localTunnel

/** A stand-in for the SSH channel: what is written to it comes back in upper case */
function echoChannel() {
  const channel = new PassThrough()
  const answer = new PassThrough()
  const duplex = Object.assign(answer, {
    write: (chunk, ...rest) => channel.write(chunk, ...rest),
    end: () => channel.end()
  })
  channel.on('data', (chunk) => answer.push(Buffer.from(chunk.toString().toUpperCase())))
  return duplex
}

const connect = (port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.once('connect', () => resolve(socket))
  socket.once('error', reject)
})
const canConnect = (port) => connect(port).then((socket) => { socket.destroy(); return true }, () => false)

describe('openOneShotTunnel', () => {
  it('listens on 127.0.0.1 only, on a port the OS picked', async () => {
    const tunnel = await openOneShotTunnel({ openStream: async () => echoChannel() })
    expect(tunnel.port).toBeGreaterThan(1023)
    tunnel.close()
  })

  it('joins the first connection to the stream', async () => {
    const tunnel = await openOneShotTunnel({ openStream: async () => echoChannel() })
    const socket = await connect(tunnel.port)
    socket.write('hello')
    const answer = await new Promise((resolve) => socket.once('data', (chunk) => resolve(chunk.toString())))
    expect(answer).toBe('HELLO')
    socket.destroy()
    tunnel.close()
  })

  it('stops listening as soon as one connection came in: nobody else gets in', async () => {
    let opened = 0
    const tunnel = await openOneShotTunnel({ openStream: async () => { opened += 1; return echoChannel() } })
    const first = await connect(tunnel.port)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await canConnect(tunnel.port)).toBe(false)
    expect(opened).toBe(1)
    first.destroy()
    tunnel.close()
  })

  it('does not stay open when nobody connects', async () => {
    const tunnel = await openOneShotTunnel({ openStream: async () => echoChannel(), waitMs: 60 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await canConnect(tunnel.port)).toBe(false)
    tunnel.close()
  })

  it('drops the connection when the stream cannot be opened, and when it is closed', async () => {
    const failing = await openOneShotTunnel({ openStream: async () => { throw new Error('channel refused') } })
    const socket = await connect(failing.port)
    await new Promise((resolve) => socket.once('close', resolve))
    const tunnel = await openOneShotTunnel({ openStream: async () => echoChannel() })
    const kept = await connect(tunnel.port)
    const closed = new Promise((resolve) => kept.once('close', resolve))
    await new Promise((resolve) => setTimeout(resolve, 30))
    tunnel.close()
    await closed
    expect(kept.destroyed).toBe(true)
  })
})
