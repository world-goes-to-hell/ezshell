import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { WebSocket } from 'ws'
import { createAccessServer, trimOutput, activityForDevice, APPROVAL_ARM_MS } from './server.js'
import { sessionTree } from './controller.js'
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

function setup({ isLocked = () => false, now } = {}) {
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
  const server = createAccessServer({ store, shells, listSessions: () => TREE, isLocked, approvals, activity, log, isAllowedAddress: () => isAllowed, ...(now ? { now } : {}) })
  return { store, shells, opened, server, log, mcp, approvals, activity }
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
    expect(client.ready).toEqual({ type: 'ready', device: 'phone', ...TREE, approvals: [], push: { available: false, publicKey: null } })
    expect(context.server.connected()).toEqual([{ id: expect.any(String), name: 'phone' }])
  })

  it('remembers a device for a day and lets it resume without a code', async () => {
    context = setup()
    await context.server.start('127.0.0.1', PORT)
    const { store } = context
    // Sign in asking to be remembered: the ready message carries a ticket
    const client = connect()
    await client.opened
    client.send({ type: 'pair', code: store.startPairing().code, name: 'phone' })
    const { token } = await client.next()
    client.send({ type: 'signin', token, code: totp.codeFor(store.totpSecret, totp.counterAt(Date.now())), remember: true })
    const ready = await client.next()
    expect(ready.type).toBe('ready')
    // The ticket arrives on its own, right after ready
    const trust = await client.next()
    expect(trust).toMatchObject({ type: 'trust' })
    expect(trust.ticket).toMatch(/^[\w-]{43}$/)
    client.socket.close()

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
    await client.next()
    const trust = await client.next()
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
