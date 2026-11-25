import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createAccessServer, trimOutput, activityForDevice, APPROVAL_ARM_MS, MAX_CLIENTS } from './server.js'
import { sessionTree, remoteThemeOf } from './controller.js'
import { createAccessStore, TRUST_MS } from './accessStore.js'
import totp from './totp.js'

// The server answers only Tailscale addresses; the tests connect over loopback, so the check is
// handed in here (the real one is tested in accessStore.test.js)
let isAllowed = true

const PORT = 18722
const ORIGIN = `http://127.0.0.1:${PORT}`

const TREE = {
  folders: [{ id: 'f1', name: '운영', parentId: null, color: '#2f6fed', expanded: true }],
  sessions: [{ id: 's1', name: 'web-01', folderId: 'f1', color: null, folder: '운영', openTabs: { connected: 1, disconnected: 0 } }]
}

function setup({ isLocked = () => false, now, tabs = null, browser = null, agents = null, readTheme } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-remote-'))
  const store = createAccessStore({ filePath: path.join(dir, 'remote-access.json'), ...(now ? { now } : {}) })
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
  // The MCP side: the question being asked on the PC, answers from a device, requests and stopping one
  const mcp = { asked: null, items: [] }
  const approvals = { current: () => mcp.asked, respond: vi.fn((id) => id === mcp.asked?.id) }
  const activity = { list: () => mcp.items, cancel: vi.fn((id) => id === 'run1') }
  const server = createAccessServer({ store, shells, listSessions: () => TREE, isLocked, approvals, activity, tabs, browser, agents, log, isAllowedAddress: () => isAllowed, readTheme, ...(now ? { now } : {}) })
  return { store, shells, opened, server, log, mcp, approvals, activity }
}

/** A WebSocket with a queue of the messages it received */
function connect({ origin = ORIGIN, headers, autoPong = true } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin, headers, autoPong })
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
  http.get(`${ORIGIN}${url}`, { headers, agent: false }, (res) => {
    let body = ''
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  }).on('error', reject)
})

async function signedIn(context, options) {
  const { store } = context
  const client = connect(options)
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
    const icon = await get('/app-icon.svg')
    expect(icon.status).toBe(200)
    expect(icon.headers['content-type']).toContain('image/svg+xml')
    const font = await get('/vendor/PretendardVariable.woff2')
    expect(font.status).toBe(200)
    expect(font.headers['content-type']).toBe('font/woff2')
    expect((await get('/vendor/title-bar.css')).status).toBe(200)
    expect((await get('/vendor/terminal-tabs.css')).status).toBe(200)
    expect((await get('/vendor/agent-work-trace.css')).status).toBe(200)
    expect((await get('/../../main.js')).status).toBe(404)
    expect((await get('/remote-access.json')).status).toBe(404)
  })

  it('serves a standalone manifest with same-origin icons and a clean launch URL', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const response = await get('/manifest.webmanifest')
    expect(response.headers['content-type']).toBe('application/manifest+json')
    const manifest = JSON.parse(response.body)
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' })
    expect(manifest.icons.map(icon => icon.sizes)).toEqual(['192x192', '512x512'])
    for (const icon of manifest.icons) {
      expect(await get(icon.src)).toMatchObject({ status: 200, headers: { 'content-type': 'image/png' } })
    }
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
    expect(client.ready).toEqual({ type: 'ready', device: 'phone', ...TREE, approvals: [], push: { available: false, publicKey: null }, features: { tabs: false, agents: false }, theme: {} })
    expect(context.server.connected()).toEqual([{ id: expect.any(String), name: 'phone' }])
  })

  it('sends the validated PC theme on sign-in and when it changes', async () => {
    const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
    const palette = Object.fromEntries(ansi.flatMap((name, index) => [
      [name, `#00a00${index}`],
      [`bright${name[0].toUpperCase()}${name.slice(1)}`, `#b0000${index}`]
    ]))
    let theme = remoteThemeOf({
      background: '#fff', danger: '#a22', radius: '5px', scheme: 'light',
      terminal: { ...palette, arbitrary: '#000' }, terminalFont: 'D2Coding',
      font: 'serif; opacity:0', '--extra': '#000'
    })
    context = setup({ readTheme: () => theme })
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    expect(client.ready.theme).toEqual({
      '--bg': '#fff', '--error': '#a22', '--danger': '#a22', '--radius': '5px', '--scheme': 'light',
      '--terminal-font': '"D2Coding", Consolas, "D2Coding", ui-monospace, monospace',
      ...Object.fromEntries(ansi.flatMap((name, index) => [
        [`--t-${name}`, `#00a00${index}`], [`--t-bright-${name}`, `#b0000${index}`]
      ]))
    })
    theme = remoteThemeOf({
      surface: '#123456', scheme: 'dark', terminalFont: 'font; background: red',
      terminal: { cyan: 'rgba(10, 20, 30, 0.5)', red: 'rgb(256 0 0)', black: 'url(/resource)', brightGreen: '0'.repeat(90) }
    })
    context.server.themeChanged()
    expect(await client.next()).toEqual({ type: 'theme', theme: { '--panel': '#123456', '--scheme': 'dark', '--t-cyan': 'rgba(10, 20, 30, 0.5)' } })
  })

  it('sends the remembered ticket before the signed-in view so a reload can resume immediately', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const { store } = context
    // Once the signed-in view appears, the browser may reload as soon as it receives ready.
    const client = connect()
    await client.opened
    client.send({ type: 'pair', code: store.startPairing().code, name: 'phone' })
    const { token } = await client.next()
    client.send({ type: 'signin', token, code: totp.codeFor(store.totpSecret, totp.counterAt(Date.now())), remember: true })
    const trust = await client.next()
    expect(trust).toMatchObject({ type: 'trust' })
    expect(trust.ticket).toMatch(/^[\w-]{43}$/)
    expect(await client.next()).toMatchObject({ type: 'ready', device: 'phone' })
    client.socket.close()
    await client.closed

    // A new connection resumes with the ticket, no code, and is signed in
    const again = connect()
    await again.opened
    again.send({ type: 'resume', token, ticket: trust.ticket })
    const back = await again.next()
    expect(back.type).toBe('ready')
    expect(back.device).toBe('phone')
    expect(back.trust).toBeUndefined()
    again.socket.close()

    // A wrong ticket is refused (and counts), a missing one asks for a code without counting
    const bad = connect()
    await bad.opened
    bad.send({ type: 'resume', token, ticket: 'not-the-ticket' })
    expect((await bad.next())).toMatchObject({ type: 'error', code: 'bad-ticket' })
    bad.socket.close()
  })

  it('applies the same connection limit to code sign-in and resume without replacing a ticket', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const { store } = context
    for (let i = 0; i < MAX_CLIENTS; i++) await signedIn(context)
    const { token, deviceId } = store.redeemPairing(store.startPairing().code, 'remembered phone')
    const { ticket } = store.rememberDevice(deviceId)
    const remember = vi.spyOn(store, 'rememberDevice')

    for (const request of [
      { type: 'signin', token, code: totp.codeFor(store.totpSecret, totp.counterAt(Date.now())), remember: true },
      { type: 'resume', token, ticket }
    ]) {
      const client = connect()
      await client.opened
      client.send(request)
      expect(await client.next()).toMatchObject({ type: 'bye', message: expect.stringContaining('너무 많습니다') })
      await client.closed
    }
    expect(remember).not.toHaveBeenCalled()
    expect(store.resume(token, ticket)).toMatchObject({ device: { id: deviceId } })
  })

  it('tells a device whose remembered day has passed to use a code, without ending the connection', async () => {
    let clock = 1_800_000_000_000
    context = setup({ now: () => clock })
    await context.server.start('127.0.0.1', PORT)
    const { store } = context
    const client = connect()
    await client.opened
    client.send({ type: 'pair', code: store.startPairing().code, name: 'phone' })
    const { token } = await client.next()
    client.send({ type: 'signin', token, code: totp.codeFor(store.totpSecret, totp.counterAt(clock)), remember: true })
    const trust = await client.next()
    expect(trust.type).toBe('trust')
    expect(await client.next()).toMatchObject({ type: 'ready' })
    client.socket.close()

    clock += TRUST_MS + 1
    const again = connect()
    await again.opened
    again.send({ type: 'resume', token, ticket: trust.ticket })
    const answer = await again.next()
    expect(answer).toMatchObject({ type: 'error', code: 'trust-expired' })
    // The connection stays open so the device can now send a code
    expect(again.socket.readyState).toBe(again.socket.OPEN)
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

  it('keeps a parked shell for ten minutes, and cancels expiry if its owner returns', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    client.send({ type: 'open', requestId: 'q1', sessionId: 's1' })
    const { shellId } = await client.next()
    await client.next() // Early shell output
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    const parkedTimers = () => setTimer.mock.calls.flatMap(([expire, delay], index) =>
      delay === 600_000 ? [{ expire, timer: setTimer.mock.results[index].value }] : [])
    const visibility = async visible => {
      client.send({ type: 'shell-visible', shellId, visible })
      client.send({ type: 'probe' })
      expect(await client.next()).toEqual({ type: 'probe' })
    }

    try {
      await visibility(false)
      await visibility(false)
      expect(parkedTimers()).toHaveLength(1)
      expect(context.shells.close).not.toHaveBeenCalled()
      await visibility(true)
      expect(clearTimer).toHaveBeenCalledWith(parkedTimers()[0].timer)
      await visibility(false)
      expect(parkedTimers()).toHaveLength(2)
      parkedTimers()[1].expire()
      expect(context.shells.close).toHaveBeenCalledExactlyOnceWith(shellId, context.opened[0].owner)
    } finally {
      client.socket.close()
      await client.closed
      setTimer.mockRestore()
      clearTimer.mockRestore()
    }
  })

  it('clears the parked shell timer when its socket closes', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    client.send({ type: 'open', requestId: 'q1', sessionId: 's1' })
    const { shellId } = await client.next()
    await client.next() // Early shell output
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')

    try {
      client.send({ type: 'shell-visible', shellId, visible: false })
      client.send({ type: 'probe' })
      expect(await client.next()).toEqual({ type: 'probe' })
      const timerIndex = setTimer.mock.calls.findIndex(([, delay]) => delay === 600_000)
      expect(timerIndex).toBeGreaterThanOrEqual(0)
      const timer = setTimer.mock.results[timerIndex].value
      expect(clearTimer).not.toHaveBeenCalledWith(timer)

      client.socket.close()
      await client.closed
      await vi.waitFor(() => expect(clearTimer).toHaveBeenCalledWith(timer))
      expect(context.shells.closeAll).toHaveBeenCalledWith(context.opened[0].owner)
    } finally {
      setTimer.mockRestore()
      clearTimer.mockRestore()
    }
  })

  it('pings before sign-in and terminates a socket that does not pong by the next tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      context = setup()
      await context.server.start('127.0.0.1', PORT)
      const client = connect({ autoPong: false })
      await client.opened
      const ping = vi.fn()
      client.socket.on('ping', ping)
      vi.advanceTimersByTime(29_999)
      expect(ping).not.toHaveBeenCalled()
      const firstPing = once(client.socket, 'ping')
      vi.advanceTimersByTime(1)
      await firstPing
      expect(ping).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(30_000)
      await client.closed
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a socket that pongs, then reclaims its shell and device slot if it stops answering', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      context = setup()
      await context.server.start('127.0.0.1', PORT)
      const client = await signedIn(context, { autoPong: false })
      client.send({ type: 'open', requestId: 'q1', sessionId: 's1' })
      expect(await client.next()).toMatchObject({ type: 'opened' })
      await client.next() // Early shell output

      const firstPing = once(client.socket, 'ping')
      vi.advanceTimersByTime(30_000)
      const [payload] = await firstPing
      client.socket.pong(payload)
      client.send({ type: 'probe' })
      expect(await client.next()).toEqual({ type: 'probe' })
      const secondPing = once(client.socket, 'ping')
      vi.advanceTimersByTime(30_000)
      await secondPing
      expect(context.server.connected()).toHaveLength(1)
      expect(context.shells.closeAll).not.toHaveBeenCalled()

      vi.advanceTimersByTime(30_000)
      await client.closed
      await vi.waitFor(() => expect(context.shells.closeAll).toHaveBeenCalledWith(context.opened[0].owner))
      expect(context.server.connected()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
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

describe('createAccessServer: MCP questions and activity on a device', () => {
  let context
  let clock
  afterEach(() => context?.server.stop())
  const QUESTION = { id: 'q1', sessionName: 'web-01', command: 'systemctl restart nginx', level: 'danger', reasons: [], expiresAt: 0 }

  async function start() {
    clock = Date.now()
    context = setup({ now: () => clock })
    await context.server.start('127.0.0.1', PORT)
    return signedIn(context)
  }

  it('hands a device the question that was already being asked, with the time it has left', async () => {
    clock = Date.now()
    context = setup({ now: () => clock })
    context.mcp.asked = { ...QUESTION, expiresAt: clock + 120_000 }
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    expect(client.ready.approvals).toEqual([{ ...QUESTION, expiresAt: clock + 120_000, remainingMs: 120_000 }])
  })

  it('sends a new question to signed-in devices only, and tells them when it ends', async () => {
    const client = await start()
    const waiting = connect()
    await waiting.opened
    context.server.showApproval({ ...QUESTION, expiresAt: clock + 60_000 })
    expect(await client.next()).toEqual({ type: 'approval', request: { ...QUESTION, expiresAt: clock + 60_000, remainingMs: 60_000 } })
    context.server.closeApproval('q1', 'approved', 'pc')
    expect(await client.next()).toEqual({ type: 'approval-closed', id: 'q1', outcome: 'approved', by: 'pc' })
    // The connection that has not signed in got neither
    waiting.send({ type: 'signin', token: 'nope', code: '000000' })
    expect(await waiting.next()).toMatchObject({ type: 'error' })
  })

  it('takes an answer only after the first moment, and only for a question the device was sent', async () => {
    const client = await start()
    context.mcp.asked = { ...QUESTION, expiresAt: clock + 60_000 }
    context.server.showApproval(context.mcp.asked)
    await client.next()
    client.send({ type: 'approval-respond', id: 'q1', approved: true })
    expect(await client.next()).toMatchObject({ type: 'approval-result', id: 'q1', ok: false })
    expect(context.approvals.respond).not.toHaveBeenCalled()
    clock += APPROVAL_ARM_MS
    client.send({ type: 'approval-respond', id: 'other', approved: true })
    expect(await client.next()).toMatchObject({ type: 'approval-result', id: 'other', ok: false })
    client.send({ type: 'approval-respond', id: 'q1', approved: 'yes' })
    expect(await client.next()).toMatchObject({ type: 'approval-result', id: 'q1', ok: false })
    expect(context.approvals.respond).not.toHaveBeenCalled()
    client.send({ type: 'approval-respond', id: 'q1', approved: false })
    expect(await client.next()).toEqual({ type: 'approval-result', id: 'q1', ok: true })
    expect(context.approvals.respond).toHaveBeenCalledWith('q1', false, 'phone')
    expect(context.log).toHaveBeenCalledWith('approval', { device: 'phone', approved: false })
  })

  it('does not take an answer once the question is over', async () => {
    const client = await start()
    context.mcp.asked = { ...QUESTION, expiresAt: clock + 60_000 }
    context.server.showApproval(context.mcp.asked)
    await client.next()
    context.mcp.asked = null
    context.server.closeApproval('q1', 'expired', null)
    await client.next()
    clock += APPROVAL_ARM_MS
    client.send({ type: 'approval-respond', id: 'q1', approved: true })
    expect(await client.next()).toMatchObject({ type: 'approval-result', ok: false })
    expect(context.approvals.respond).not.toHaveBeenCalled()
  })

  it('lists the requests with the end of their output, and streams changes only while watched', async () => {
    const client = await start()
    context.mcp.items = [{ id: 'run1', command: 'tail -f log', state: 'running', outputParts: [{ stream: 'stdout', text: 'x'.repeat(40_000) }] }]
    client.send({ type: 'activity-list' })
    const listed = await client.next()
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].outputParts[0].text).toHaveLength(16 * 1024)
    expect(listed.items[0].outputTrimmed).toBe(true)

    // Not watching: nothing is sent
    context.server.activityItem({ id: 'run1', state: 'running' })
    context.server.activityOutput({ id: 'run1', parts: [{ stream: 'stdout', text: 'quiet' }] })
    client.send({ type: 'activity-watch', on: true })
    client.send({ type: 'sessions' })
    expect(await client.next()).toMatchObject({ type: 'sessions', folders: TREE.folders })
    context.server.activityOutput({ id: 'run1', parts: [{ stream: 'stderr', text: 'line' }] })
    expect(await client.next()).toEqual({ type: 'activity-output', id: 'run1', parts: [{ stream: 'stderr', text: 'line' }] })
    context.server.activityItem({ id: 'run1', state: 'done', outputParts: [{ stream: 'stdout', text: 'end' }] })
    expect(await client.next()).toEqual({ type: 'activity-item', item: { id: 'run1', state: 'done', outputParts: [{ stream: 'stdout', text: 'end' }] } })

    client.send({ type: 'activity-stop', id: 'run1' })
    expect(await client.next()).toEqual({ type: 'activity-stop-result', id: 'run1', ok: true })
    client.send({ type: 'activity-stop', id: 'gone' })
    expect(await client.next()).toMatchObject({ type: 'activity-stop-result', id: 'gone', ok: false })
    expect(context.log).toHaveBeenCalledWith('activity-stop', { device: 'phone' })
  })
})

describe('what a device gets of the MCP activity', () => {
  it('keeps the end of the output and says when the start was dropped', () => {
    const item = { id: 'a', outputParts: [{ stream: 'stdout', text: 'abcdef' }, { stream: 'stderr', text: 'XYZ' }] }
    expect(trimOutput(item, 100)).toEqual(item)
    expect(trimOutput(item, 5)).toEqual({ id: 'a', outputParts: [{ stream: 'stdout', text: 'ef' }, { stream: 'stderr', text: 'XYZ' }], outputTrimmed: true })
    expect(trimOutput(item, 3).outputParts).toEqual([{ stream: 'stderr', text: 'XYZ' }])
    expect(trimOutput(item, 0)).toEqual({ id: 'a', outputParts: [], outputTrimmed: true })
    expect(trimOutput({ id: 'b' })).toEqual({ id: 'b' })
  })

  it('gives the newest requests their output first and never more than a hundred', () => {
    const items = Array.from({ length: 130 }, (_, i) => ({ id: `r${i}`, outputParts: [{ stream: 'stdout', text: 'y'.repeat(16 * 1024) }] }))
    const sent = activityForDevice(items)
    expect(sent).toHaveLength(100)
    expect(sent[0].id).toBe('r30')
    expect(sent[99].outputParts[0].text).toHaveLength(16 * 1024)
    expect(sent[0].outputParts).toEqual([])
    const total = sent.reduce((sum, item) => sum + item.outputParts.reduce((s, part) => s + part.text.length, 0), 0)
    expect(total).toBeLessThanOrEqual(400 * 1024)
  })
})

describe('sessionTree (what the phone gets of the sidebar)', () => {
  const folders = [{ id: 'f1', name: '운영', backgroundColor: '#2f6fed' }, { id: 'f2', name: 'DB', parentId: 'f1', backgroundColor: 'url(javascript:alert(1))' }]
  const sessions = [
    { id: 's2', name: 'db-01', host: '10.0.0.9', port: 22, username: 'root', password: 'secret', folderId: 'f2', backgroundColor: 'rgb(10, 20, 30)', suPassword: 'x', privateKeyPath: 'C:/k' },
    { id: 's1', name: '', host: 'web.internal', username: 'deploy', folderId: 'gone' },
    { id: 's3', name: 'broken', host: 'h', decryptionFailed: true }
  ]

  it('keeps the order, colours, open folders and tab counts', () => {
    const tree = sessionTree({ folders, sessions, expandedIds: ['f1'], openTabs: new Map([['s2', { connected: 2, disconnected: 1 }]]) })
    expect(tree.folders).toEqual([
      { id: 'f1', name: '운영', parentId: null, color: '#2f6fed', expanded: true },
      { id: 'f2', name: 'DB', parentId: 'f1', color: null, expanded: false }
    ])
    expect(tree.sessions).toEqual([
      { id: 's2', name: 'db-01', folderId: 'f2', color: 'rgb(10, 20, 30)', folder: 'DB', openTabs: { connected: 2, disconnected: 1 } },
      // A session without a name gets a label, never its address
      { id: 's1', name: '이름 없는 세션', folderId: null, color: null, folder: '', openTabs: { connected: 0, disconnected: 0 } }
    ])
  })

  it('copies nothing else of a session', () => {
    const text = JSON.stringify(sessionTree({ folders, sessions }))
    for (const secret of ['10.0.0.9', 'web.internal', 'root', 'secret', 'deploy', 'C:/k', 'javascript']) expect(text).not.toContain(secret)
  })
})

describe('createAccessServer under a name (HTTPS by the tailnet name)', () => {
  let context
  afterEach(() => context?.server.stop())
  const NAME = 'pc.example.ts.net'

  it('answers to the name it was started with, not to the address', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT, { name: NAME })
    expect(context.server.address).toMatchObject({ host: '127.0.0.1', port: PORT, name: NAME, scheme: 'http' })
    const page = await get('/', { host: `${NAME}:${PORT}` })
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toContain(`connect-src 'self' ws://${NAME}:${PORT};`)
    // By the address: sent to the name
    const byAddress = await get('/')
    expect(byAddress.status).toBe(302)
    expect(byAddress.headers.location).toBe(`http://${NAME}:${PORT}/`)
    await expect(connect().opened).rejects.toThrow()
    const named = connect({ origin: `http://${NAME}:${PORT}`, headers: { host: `${NAME}:${PORT}` } })
    await named.opened
    named.socket.close()
  })

  it('offers notifications only over HTTPS, and takes no subscription without it', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    expect(client.ready.push).toEqual({ available: false, publicKey: null })
    client.send({ type: 'push-subscribe', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'x', auth: 'y' } } })
    expect(await client.next()).toMatchObject({ type: 'push-result', ok: false })
    expect(context.store.pushTargets()).toEqual([])
  })

  it('lists the PC tabs, follows one from its kept output, types into it and tells when it ends', async () => {
    const { createTabMirror } = await import('./tabMirror.js')
    const mirror = createTabMirror()
    const written = []
    const list = [{ id: 't1', name: 'web-01', folder: '운영', color: null, connected: true, inputAllowed: true }]
    const tabs = {
      enabled: true,
      list: () => list,
      attach: (id, handlers) => (list.some((tab) => tab.id === id) ? { ...mirror.attach(id, handlers), name: 'web-01', inputAllowed: true } : null),
      write: (id, data) => (list.some((tab) => tab.id === id) ? (written.push([id, data]), 'web-01') : null)
    }
    context = setup({ tabs })
    await context.server.start('127.0.0.1', PORT)
    mirror.resize('t1', 120, 40)
    mirror.record('t1', 'hello\r\n')
    const client = await signedIn(context)
    expect(client.ready.features).toEqual({ tabs: true, agents: false })
    client.send({ type: 'tabs-list' })
    expect(await client.next()).toEqual({ type: 'tabs', tabs: list })
    client.send({ type: 'tab-attach', tabId: 'nope' })
    expect(await client.next()).toMatchObject({ type: 'tab-error', tabId: 'nope' })
    client.send({ type: 'tab-attach', tabId: 't1' })
    expect(await client.next()).toEqual({ type: 'tab-attached', tabId: 't1', cols: 120, rows: 40, snapshot: 'hello\r\n', inputAllowed: true })
    expect(context.log).toHaveBeenCalledWith('tab-attach', { device: 'phone', tab: 'web-01' })
    mirror.record('t1', 'a')
    mirror.record('t1', 'b')
    // Batched: both pieces in one message
    expect(await client.next()).toEqual({ type: 'tab-data', tabId: 't1', data: 'ab' })
    client.send({ type: 'tab-input', tabId: 't1', data: 'ls\r' })
    client.send({ type: 'tab-input', tabId: 't1', data: 'pwd\r' })
    await vi.waitFor(() => expect(written).toEqual([['t1', 'ls\r'], ['t1', 'pwd\r']]))
    // Logged once with the tab's name, never the keys
    const inputs = context.log.mock.calls.filter(([event]) => event === 'tab-input')
    expect(inputs).toEqual([['tab-input', { device: 'phone', tab: 'web-01' }]])
    expect(JSON.stringify(context.log.mock.calls)).not.toContain('pwd')
    mirror.ended('t1', 'disconnected')
    expect(await client.next()).toEqual({ type: 'tab-ended', tabId: 't1', reason: 'disconnected' })
    // No longer attached: typing is refused
    client.send({ type: 'tab-input', tabId: 't1', data: 'x' })
    expect(await client.next()).toMatchObject({ type: 'tab-error', tabId: 't1' })
    expect(written).toHaveLength(2)
  })

  it('limits a device to six PC tab subscriptions and frees a place on detach', async () => {
    const detach = vi.fn()
    const tabs = {
      enabled: true,
      attach: vi.fn(id => ({ name: id, cols: 80, rows: 24, snapshot: '', detach: () => detach(id) }))
    }
    const browser = { enabled: true, tab: () => ({ available: true }) }
    context = setup({ tabs, browser })
    await context.server.start('127.0.0.1', PORT)
    const device = connect()
    await device.opened
    device.send({ type: 'pair', code: context.store.startPairing().code, name: 'phone' })
    const { token } = await device.next()
    device.send({ type: 'signin', token, code: totp.codeFor(context.store.totpSecret, totp.counterAt(Date.now())), remember: true })
    const { ticket } = await device.next()
    expect(await device.next()).toMatchObject({ type: 'ready' })
    const sameDevice = connect()
    await sameDevice.opened
    sameDevice.send({ type: 'resume', token, ticket })
    expect(await sameDevice.next()).toMatchObject({ type: 'ready' })

    async function attach(client, tabId, result = 'tab-attached') {
      client.send({ type: 'tab-attach', tabId })
      expect(await client.next()).toMatchObject({ type: result, tabId })
    }
    for (let index = 0; index < 6; index++) await attach(device, `t${index}`)
    await attach(device, 't6', 'tab-error')
    await attach(sameDevice, 't6', 'tab-error')
    const browserView = { viewId: 1, tabId: 'browser:fixture' }
    sameDevice.send({ type: 'browser-open', ...browserView })
    expect(await sameDevice.next()).toMatchObject({ type: 'browser-ended', ...browserView, message: expect.stringContaining('6개') })
    expect(tabs.attach).toHaveBeenCalledTimes(6)
    await attach(device, 't0')
    expect(detach).toHaveBeenCalledWith('t0')

    const otherDevice = await signedIn(context)
    await attach(otherDevice, 't6')
    device.send({ type: 'tab-detach', tabId: 't1' })
    await vi.waitFor(() => expect(detach).toHaveBeenCalledWith('t1'))
    sameDevice.send({ type: 'browser-open', ...browserView })
    expect(await sameDevice.next()).toMatchObject({ type: 'browser-opened', ...browserView })
    await attach(sameDevice, 't6', 'tab-error')
    sameDevice.send({ type: 'browser-close', ...browserView })
    await attach(sameDevice, 't6')
  })

  it('keeps quick connections read-only and detaches them when PC tab access is switched off', async () => {
    const detach = vi.fn()
    const tabs = {
      enabled: false,
      list: () => [{ id: 'quick', name: '빠른 연결', connected: true, inputAllowed: false }],
      attach: () => ({ name: '빠른 연결', cols: 80, rows: 24, snapshot: 'hello', inputAllowed: false, detach }),
      write: vi.fn()
    }
    context = setup({ tabs })
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    expect(client.ready.features.tabs).toBe(false)
    client.send({ type: 'tabs-list' })
    expect(await client.next()).toMatchObject({ type: 'tabs', tabs: [], error: expect.stringContaining('꺼져') })
    tabs.enabled = true
    context.server.featuresChanged()
    expect(await client.next()).toMatchObject({ type: 'features', features: { tabs: true } })
    client.send({ type: 'tab-attach', tabId: 'quick' })
    expect(await client.next()).toMatchObject({ type: 'tab-attached', tabId: 'quick', inputAllowed: false })
    client.send({ type: 'tab-input', tabId: 'quick', data: 'ignored' })
    expect(await client.next()).toMatchObject({ type: 'tab-error', tabId: 'quick' })
    expect(tabs.write).not.toHaveBeenCalled()
    tabs.enabled = false
    context.server.stopTabs()
    expect(await client.next()).toMatchObject({ type: 'tabs', tabs: [], error: expect.stringContaining('꺼져') })
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('follows a browser tab and sends only the selected element through the agent setting', async () => {
    let clock = Date.now()
    const tabId = 'browser:review'
    const selection = { id: 'selection-1', tag: 'button', label: '저장', selector: '#save', componentFile: 'local-path' }
    const frame = { viewport: [1, 1, 1024, 768] }
    const tab = {
      available: true,
      capture: vi.fn(async () => ({ frame, jpeg: 'abcd' })),
      pick: vi.fn(async () => ({ selection, rect: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 } })),
      send: vi.fn(() => ({ success: true }))
    }
    const list = [{ id: tabId, name: '개발 화면', kind: 'browser', folder: 'ezShell' }]
    const browser = { enabled: true, list: () => list, tab: id => id === tabId ? tab : null, recipients: () => [{ id: 'codex-1' }] }
    const agents = { enabled: false, closeViewer() {} }
    context = setup({ browser, agents, now: () => clock })
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    const send = (type, fields) => client.send({ type, tabId, viewId: 1, ...fields })
    expect(client.ready.features).toEqual({ tabs: true, agents: false })
    client.send({ type: 'tabs-list' })
    expect(await client.next()).toEqual({ type: 'tabs', tabs: list })
    send('browser-open')
    expect(await client.next()).toMatchObject({ type: 'browser-opened', tabId, viewId: 1 })
    send('browser-frame')
    const preview = await client.next()
    expect(preview).toEqual({ type: 'browser-image', viewId: 1, tabId, frameId: expect.any(String), jpeg: 'abcd' })
    send('browser-pick', { frameId: 'other-view', x: 0.3, y: 0.4 })
    expect(await client.next()).toMatchObject({ operation: 'browser-pick', refresh: true })
    expect(tab.pick).not.toHaveBeenCalled()
    send('browser-pick', { frameId: preview.frameId, x: 0.3, y: 0.4 })
    const picked = await client.next()
    expect(picked).toMatchObject({ operation: 'browser-pick', selection: { id: selection.id, selector: '#save' }, recipients: [] })
    expect(JSON.stringify(picked)).not.toContain('local-path')
    expect(tab.pick).toHaveBeenCalledWith(frame, 0.3, 0.4)
    const request = { selectionId: selection.id, agentId: 'codex-1', text: '문구를 바꿔 주세요' }
    send('browser-request', request)
    expect(await client.next()).toMatchObject({ error: expect.stringContaining('에이전트 쓰기') })
    expect(tab.send).not.toHaveBeenCalled()
    agents.enabled = true
    send('browser-request', request)
    expect(await client.next()).toMatchObject({ type: 'browser-result', operation: 'browser-request', ok: true })
    expect(tab.send).toHaveBeenCalledExactlyOnceWith(frame, selection, 'codex-1', request.text)
    expect(JSON.stringify(context.log.mock.calls)).not.toContain(request.text)
    send('browser-request', request)
    expect(await client.next()).toMatchObject({ error: expect.stringContaining('다시 선택') })
    clock += 15_001
    send('browser-pick', { frameId: preview.frameId, x: 0.3, y: 0.4 })
    expect(await client.next()).toMatchObject({ refresh: true })
    browser.enabled = false
    context.server.tabsChanged()
    expect(await client.next()).toMatchObject({ type: 'browser-ended', tabId })
    expect(await client.next()).toMatchObject({ type: 'tabs', tabs: [] })
  })

  it('refuses every agent message while the setting is off', async () => {
    const agents = { enabled: false, list: vi.fn(() => []), open: vi.fn(), send: vi.fn(), closeViewer: vi.fn(), close: vi.fn(), describe: () => 'claude-1' }
    context = setup({ agents })
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    expect(client.ready.features).toEqual({ tabs: false, agents: false })
    client.send({ type: 'agents-list' })
    expect(await client.next()).toMatchObject({ type: 'agents', agents: [], error: expect.any(String) })
    client.send({ type: 'chat-send', shellId: 'local:1', requestId: 'q1', text: 'hi' })
    expect(await client.next()).toMatchObject({ type: 'chat-send-result', shellId: 'local:1', requestId: 'q1', ok: false })
    expect(agents.send).not.toHaveBeenCalled()
    expect(agents.list).not.toHaveBeenCalled()
    expect(context.log).toHaveBeenCalledWith('chat-send', { device: 'phone', agent: 'claude-1', chars: 2, ok: false })
  })

  it('keeps two browser previews attached with distinct view IDs and closes only the selected one', async () => {
    let clock = Date.now()
    const browser = {
      enabled: true,
      list: () => [],
      tab: id => ({ available: true, capture: async () => ({ frame: {}, jpeg: id }) })
    }
    context = setup({ browser, now: () => clock })
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    const a = { tabId: 'browser:a', viewId: 1 }
    const b = { tabId: 'browser:b', viewId: 2 }
    for (const view of [a, b]) {
      client.send({ type: 'browser-open', ...view })
      expect(await client.next()).toMatchObject({ type: 'browser-opened', ...view })
    }
    client.send({ type: 'browser-frame', ...a })
    expect(await client.next()).toMatchObject({ type: 'browser-image', ...a, jpeg: a.tabId })
    client.send({ type: 'browser-close', ...a })
    clock += 700
    client.send({ type: 'browser-frame', ...b })
    expect(await client.next()).toMatchObject({ type: 'browser-image', ...b, jpeg: b.tabId })
  })

  it('passes agent actions to the bridge, frames only to the device that opened the chat, and logs no text', async () => {
    let frameTo = null
    let closeChat = null
    const agents = {
      enabled: true,
      list: () => [{ shellId: 'local:1', agentId: 'claude-1', kind: 'claude', name: 'Claude Code 1', role: null, status: 'idle', folderName: 'app', waitingApproval: false }],
      open: vi.fn((viewer, shellId, onFrame, onClosed) => {
        frameTo = onFrame
        closeChat = onClosed
        return { ok: true }
      }),
      older: vi.fn(async () => { frameTo({ shellId: 'local:1', older: true, items: [] }); return { ok: true } }),
      send: vi.fn(async () => ({ ok: false, reason: 'busy', error: '다른 입력을 넣는 중입니다.' })),
      answer: vi.fn(async () => ({ ok: true })),
      interrupt: vi.fn(() => ({ ok: true })),
      close: vi.fn(),
      closeViewer: vi.fn(),
      describe: () => 'claude-1'
    }
    context = setup({ agents })
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    const other = await signedIn(context)
    expect(client.ready.features.agents).toBe(true)
    client.send({ type: 'agents-watch', on: true })
    expect(await client.next()).toMatchObject({ type: 'agents', agents: [{ shellId: 'local:1', agentId: 'claude-1' }] })
    client.send({ type: 'chat-open', shellId: 'local:1' })
    expect(await client.next()).toEqual({ type: 'chat-opened', shellId: 'local:1', ok: true })
    frameTo({ shellId: 'local:1', reset: true, items: [{ id: 'a', kind: 'assistant', text: 'hi' }] })
    expect(await client.next()).toEqual({ type: 'chat-frame', shellId: 'local:1', reset: true, items: [{ id: 'a', kind: 'assistant', text: 'hi' }] })
    // The older part's frame comes before its result
    client.send({ type: 'chat-older', shellId: 'local:1' })
    expect(await client.next()).toMatchObject({ type: 'chat-frame', older: true })
    expect(await client.next()).toEqual({ type: 'chat-older-result', shellId: 'local:1', ok: true })
    client.send({ type: 'chat-send', shellId: 'local:1', requestId: 'q1', text: '비밀 문장' })
    expect(await client.next()).toEqual({ type: 'chat-send-result', shellId: 'local:1', requestId: 'q1', ok: false, reason: 'busy', error: '다른 입력을 넣는 중입니다.' })
    client.send({ type: 'chat-answer', shellId: 'local:1', key: '1', signature: 'sig' })
    expect(await client.next()).toEqual({ type: 'chat-answer-result', shellId: 'local:1', ok: true })
    client.send({ type: 'chat-interrupt', shellId: 'local:1' })
    expect(await client.next()).toEqual({ type: 'chat-interrupt-result', shellId: 'local:1', ok: true })
    expect(agents.send).toHaveBeenCalledWith(expect.stringMatching(/^remote:/), 'local:1', '비밀 문장')
    const events = context.log.mock.calls.map(([event, detail]) => [event, detail])
    expect(events).toEqual(expect.arrayContaining([
      ['chat-send', { device: 'phone', agent: 'claude-1', chars: '비밀 문장'.length, ok: false }],
      ['chat-answer', { device: 'phone', agent: 'claude-1', ok: true }],
      ['chat-interrupt', { device: 'phone', agent: 'claude-1', ok: true }]
    ]))
    expect(JSON.stringify(context.log.mock.calls)).not.toContain('비밀')
    closeChat('에이전트가 바뀌었습니다.')
    expect(await client.next()).toEqual({ type: 'chat-opened', shellId: 'local:1', ok: false, error: '에이전트가 바뀌었습니다.' })
    // Switching agents off: the device is told and its chats close
    context.server.stopAgents()
    expect(await client.next()).toMatchObject({ type: 'agents', agents: [], error: expect.any(String) })
    expect(agents.closeViewer).toHaveBeenCalled()
    other.socket.close()
    await other.closed
  })

  it('disconnects only the device whose outgoing chat frame would exceed the byte limit', async () => {
    let frameTo
    const agents = { enabled: true, open: (_viewer, _id, onFrame) => { frameTo = onFrame; return { ok: true } }, closeViewer: vi.fn() }
    context = setup({ agents })
    await context.server.start('127.0.0.1', PORT)
    const slow = await signedIn(context)
    const other = await signedIn(context)
    slow.send({ type: 'chat-open', shellId: 'local:1' })
    expect(await slow.next()).toMatchObject({ type: 'chat-opened', ok: true })
    frameTo({ shellId: 'local:1', items: [{ id: 'sample', kind: 'assistant', text: '가'.repeat(1_400_000) }] })
    await slow.closed
    expect(agents.closeViewer).toHaveBeenCalledWith(expect.stringMatching(/^remote:/))
    other.send({ type: 'sessions' })
    expect(await other.next()).toMatchObject({ type: 'sessions' })
  })

  it.each(['list', 'item', 'output'])('disconnects a device past the shared byte limit before skipping activity %s', async kind => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const client = await signedIn(context)
    client.send({ type: 'activity-watch', on: true })
    client.send({ type: 'sessions' })
    expect(await client.next()).toMatchObject({ type: 'sessions' })
    const backlog = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(4 * 1024 * 1024 + 1)
    try {
      if (kind === 'list') client.send({ type: 'activity-list' })
      if (kind === 'item') context.server.activityItem({ id: 'activity-test' })
      if (kind === 'output') context.server.activityOutput({ id: 'activity-test', parts: [{ text: 'output' }] })
      await client.closed
    } finally {
      backlog.mockRestore()
    }
  })
})

describe('activity sent to a device: named fields only', () => {
  it('drops what is not on the list (a file change\'s content) and cuts the result text like the output', () => {
    const item = { id: 'a', command: 'write_file /etc/app.conf', state: 'done', level: 'danger', view: { hunks: ['secret=1'] }, content: 'secret=1', output: 'r'.repeat(40_000), outputParts: [{ stream: 'stdout', text: 'ok' }] }
    const sent = trimOutput(item)
    expect(Object.keys(sent).sort()).toEqual(['command', 'id', 'level', 'output', 'outputParts', 'state'])
    expect(sent.output).toHaveLength(16 * 1024)
    expect(JSON.stringify(sent)).not.toContain('secret=1')
  })

  it('counts the result text toward the total as well', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, output: 'o'.repeat(16 * 1024), outputParts: [{ stream: 'stdout', text: 'y'.repeat(16 * 1024) }] }))
    const total = activityForDevice(items).reduce((sum, item) => sum + (item.output?.length ?? 0) + item.outputParts.reduce((s, part) => s + part.text.length, 0), 0)
    // The total for output, and at most one character of result text for each request after it is used up
    expect(total).toBeLessThanOrEqual(400 * 1024 + 16 * 1024 + 100)
  })
})

describe('the PC tabs a phone lists', () => {
  it('names a saved session\'s tab like the session list and never shows a quick connect\'s name', async () => {
    const { tabList } = await import('./controller.js')
    const sessions = [{ id: 's1', name: 'web-01', host: '10.0.0.5', folderId: 'f1', backgroundColor: '#2f6fed' }]
    const folders = [{ id: 'f1', name: '운영' }]
    const tabs = [
      { id: 't1', savedSessionId: 's1', connected: true },
      { id: 't2', savedSessionId: null, connected: false },
      { id: 't3', savedSessionId: 'gone', connected: true }
    ]
    const listed = tabList({ tabs, sessions, folders })
    expect(listed).toEqual([
      { id: 't1', name: 'web-01', folder: '운영', color: '#2f6fed', connected: true, inputAllowed: true },
      { id: 't2', name: '빠른 연결', folder: null, color: null, connected: false, inputAllowed: false },
      { id: 't3', name: '빠른 연결', folder: null, color: null, connected: true, inputAllowed: false }
    ])
    expect(JSON.stringify(listed)).not.toContain('10.0.0.5')
  })
})
