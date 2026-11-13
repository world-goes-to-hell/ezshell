import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { WebSocket } from 'ws'
import { createAccessServer } from './server.js'
import { createAccessStore } from './accessStore.js'
import totp from './totp.js'

// The server answers only Tailscale addresses; the tests connect over loopback, so the check is
// handed in here (the real one is tested in accessStore.test.js)
let isAllowed = true

const PORT = 18722
const ORIGIN = `http://127.0.0.1:${PORT}`

function setup({ isLocked = () => false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-remote-'))
  const store = createAccessStore({ filePath: path.join(dir, 'remote-access.json') })
  store.setEnabled(true)
  const opened = []
  const shells = {
    open: vi.fn(async (sessionId, options) => {
      if (sessionId === 'bad') throw new Error('세션을 찾을 수 없습니다.')
      opened.push(options)
      options.onData('early ')
      return { shellId: `r${opened.length}`, name: 'web-01' }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    setPaused: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn()
  }
  const log = vi.fn()
  const server = createAccessServer({ store, shells, listSessions: () => [{ id: 's1', name: 'web-01', folder: '운영' }], isLocked, log, isAllowedAddress: () => isAllowed })
  return { store, shells, opened, server, log }
}

/** A WebSocket with a queue of the messages it received */
function connect({ origin = ORIGIN, headers } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin, headers })
  const inbox = []
  const waiters = []
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else inbox.push(message)
  })
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiters.push(resolve)))
  const opened = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const closed = new Promise((resolve) => socket.once('close', resolve))
  return { socket, next, opened, closed, send: (message) => socket.send(JSON.stringify(message)) }
}

const get = (url, headers) => new Promise((resolve, reject) => {
  http.get(`${ORIGIN}${url}`, { headers }, (res) => {
    let body = ''
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  }).on('error', reject)
})

async function signedIn(context) {
  const { store } = context
  const client = connect()
  await client.opened
  client.send({ type: 'pair', code: store.startPairing().code, name: 'phone' })
  const { token } = await client.next()
  client.send({ type: 'signin', token, code: totp.codeFor(store.totpSecret, totp.counterAt(Date.now())) })
  const ready = await client.next()
  return { ...client, token, ready }
}

describe('createAccessServer', () => {
  let context
  afterEach(() => {
    context?.server.stop()
    isAllowed = true
  })

  it('serves the page with strict headers and nothing else', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const page = await get('/')
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toContain("default-src 'self'")
    expect(page.headers['cache-control']).toBe('no-store')
    expect((await get('/vendor/xterm.js')).status).toBe(200)
    expect((await get('/../../main.js')).status).toBe(404)
    expect((await get('/remote-access.json')).status).toBe(404)
  })

  it('drops a connection that does not come from Tailscale', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    isAllowed = false
    await expect(get('/')).rejects.toThrow()
    const client = connect()
    await expect(client.opened).rejects.toThrow()
  })

  it('refuses the socket for another site\'s page', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = connect({ origin: 'http://evil.example' })
    await expect(client.opened).rejects.toThrow()
  })

  it('registers a device, signs it in and lists the sessions by name only', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    expect(client.ready).toEqual({ type: 'ready', device: 'phone', sessions: [{ id: 's1', name: 'web-01', folder: '운영' }] })
    expect(context.server.connected()).toEqual([{ id: expect.any(String), name: 'phone' }])
  })

  it('answers nothing but errors before signing in', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = connect()
    await client.opened
    client.send({ type: 'signin', token: 'nope', code: '000000' })
    expect(await client.next()).toMatchObject({ type: 'error', code: 'unknown-device' })
    client.send({ type: 'open', sessionId: 's1' })
    await client.closed
    expect(context.shells.open).not.toHaveBeenCalled()
  })

  it('opens a shell, carries its output and input, and closes it with the connection', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    client.send({ type: 'open', requestId: 'q1', sessionId: 's1', cols: 60, rows: 20 })
    expect(await client.next()).toEqual({ type: 'opened', requestId: 'q1', shellId: 'r1', name: 'web-01' })
    expect(await client.next()).toEqual({ type: 'data', shellId: 'r1', data: 'early ' })
    context.opened[0].onData('later')
    expect(await client.next()).toEqual({ type: 'data', shellId: 'r1', data: 'later' })
    client.send({ type: 'input', shellId: 'r1', data: 'ls\r' })
    client.send({ type: 'resize', shellId: 'r1', cols: 80, rows: 30 })
    client.send({ type: 'open', requestId: 'q2', sessionId: 'bad' })
    expect(await client.next()).toEqual({ type: 'open-failed', requestId: 'q2', message: '세션을 찾을 수 없습니다.' })
    expect(context.shells.write).toHaveBeenCalledWith('r1', expect.anything(), 'ls\r')
    expect(context.shells.resize).toHaveBeenCalledWith('r1', expect.anything(), 80, 30)
    client.socket.close()
    await client.closed
    await vi.waitFor(() => expect(context.shells.closeAll).toHaveBeenCalled())
  })

  it('drops a device that was unregistered on the PC', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    context.store.revoke(context.store.devices()[0].id)
    client.send({ type: 'sessions' })
    expect(await client.next()).toMatchObject({ type: 'bye' })
    await client.closed
  })

  it('answers nothing while the app is locked', async () => {
    let locked = false
    context = setup({ isLocked: () => locked })
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    locked = true
    client.send({ type: 'open', sessionId: 's1' })
    expect(await client.next()).toMatchObject({ type: 'bye', message: expect.stringContaining('잠겨') })
    await client.closed
    expect(context.shells.open).not.toHaveBeenCalled()
    await expect(connect().opened).rejects.toThrow()
  })

  it('answers only under its own address (a name pointed at it gets no page and no socket)', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const named = await get('/', { host: `my-pc:${PORT}` })
    expect(named.status).toBe(302)
    expect(named.headers.location).toBe(`${ORIGIN}/`)
    expect((await get('/app.js', { host: `evil.example:${PORT}` })).status).toBe(421)
    // Origin and Host agree with each other, but not with the address the server listens on
    const rebound = connect({ origin: `http://evil.example:${PORT}`, headers: { host: `evil.example:${PORT}` } })
    await expect(rebound.opened).rejects.toThrow()
  })

  it('takes any text as a registration code without an exception', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const { code } = context.store.startPairing()
    const client = connect()
    await client.opened
    client.send({ type: 'pair', code: '한'.repeat(code.length), name: 'x' })
    expect(await client.next()).toMatchObject({ type: 'error', code: 'bad-code' })
    client.send({ type: 'pair', code, name: 'phone' })
    expect(await client.next()).toMatchObject({ type: 'paired' })
  })

  it('keeps waiting connections apart from signed-in ones, and survives a bad frame on a refused one', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const signed = await signedIn(context)
    const waiting = []
    for (let i = 0; i < 3; i++) {
      const client = connect()
      await client.opened
      waiting.push(client)
    }
    const extra = connect()
    await extra.opened
    expect(await extra.next()).toMatchObject({ type: 'bye', message: expect.stringContaining('너무 많습니다') })
    // Larger than a message may be: the socket errors, which must stay inside the server
    extra.socket.send('x'.repeat(70 * 1024), () => {})
    await extra.closed
    // The signed-in device was not pushed out and still gets answers
    signed.send({ type: 'sessions' })
    expect(await signed.next()).toMatchObject({ type: 'sessions' })
    waiting.forEach((client) => client.socket.close())
  })

  it('drops a connection after five failures and refuses the address after ten', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    for (let round = 0; round < 2; round++) {
      const client = connect()
      await client.opened
      for (let i = 0; i < 5; i++) {
        client.send({ type: 'signin', token: `guess-${round}-${i}`, code: '000000' })
        expect(await client.next()).toMatchObject({ type: 'error', code: 'unknown-device' })
      }
      expect(await client.next()).toMatchObject({ type: 'bye' })
      await client.closed
    }
    await expect(connect().opened).rejects.toThrow()
    // The page itself still loads: only signing in is refused
    expect((await get('/')).status).toBe(200)
  })

  it('pauses a shell while its device is behind', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    client.send({ type: 'open', requestId: 'q1', sessionId: 's1' })
    await client.next()
    await client.next()
    // The device stops reading; the PC keeps getting output
    client.socket.pause()
    const chunk = 'x'.repeat(60 * 1024)
    await vi.waitFor(() => {
      context.opened[0].onData(chunk)
      expect(context.shells.setPaused).toHaveBeenCalledWith('r1', expect.anything(), true)
    }, { timeout: 5000, interval: 5 })
    client.socket.resume()
    await vi.waitFor(() => expect(context.shells.setPaused).toHaveBeenCalledWith('r1', expect.anything(), false), { timeout: 5000 })
  })

  it('drops everyone when it stops', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    context.server.stop()
    expect(await client.next()).toMatchObject({ type: 'bye' })
    await client.closed
    expect(context.server.isRunning).toBe(false)
  })
})

describe('createAccessServer: low findings of the security review', () => {
  let context
  afterEach(() => context?.server.stop())

  it('listens once when started twice at the same moment', async () => {
    context = setup()
    const [first, second] = await Promise.all([context.server.start('127.0.0.1', PORT), context.server.start('127.0.0.1', PORT)])
    expect(first).toEqual({ host: '127.0.0.1', port: PORT })
    expect(second).toEqual(first)
    expect(context.server.isRunning).toBe(true)
  })

  it('lets the page open a socket to this server only', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const policy = (await get('/')).headers['content-security-policy']
    expect(policy).toContain(`connect-src 'self' ws://127.0.0.1:${PORT};`)
    expect(policy).not.toMatch(/connect-src[^;]*\sws:[;\s]/)
  })

  it('ends the shells of an unregistered device at once and tells it why', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    client.send({ type: 'open', requestId: 'q1', sessionId: 's1' })
    await client.next()
    await client.next()
    context.shells.closeAll.mockClear()
    context.server.disconnectDevice(context.store.devices()[0].id)
    // Before the device has answered anything
    expect(context.shells.closeAll).toHaveBeenCalledTimes(1)
    expect(await client.next()).toMatchObject({ type: 'bye', message: expect.stringContaining('해제') })
    await client.closed
  })

  it('logs where a failed attempt came from', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = connect()
    await client.opened
    client.send({ type: 'signin', token: 'nope', code: '000000' })
    await client.next()
    expect(context.log).toHaveBeenCalledWith('signin-failed', { reason: 'unknown-device', from: expect.stringContaining('127.0.0.1') })
  })
})
