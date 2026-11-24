import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import app from './app.js?raw'

const TOKEN_KEY = 'ezshell-device-token'
const TRUST_KEY = 'ezshell-device-trust'

afterEach(() => vi.useRealTimers())

function openPhone(storage, now, visualViewport) {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventTarget(), {
      hidden: true, value: '', checked: id === 'signin-remember',
      querySelector: selector => selector === '.bar' ? null : element(`${id} ${selector}`),
      querySelectorAll: () => [], append() {},
      focus() {}, setAttribute() {}, toggleAttribute() {}
    }))
    return elements.get(id)
  }
  const sockets = []
  class Socket extends EventTarget {
    static OPEN = 1
    constructor() {
      super()
      this.sent = []
      sockets.push(this)
    }
    open() {
      this.readyState = Socket.OPEN
      this.dispatchEvent(new Event('open'))
    }
    send(raw) {
      this.sent.push(JSON.parse(raw))
    }
    receive(message) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
    }
    close() {
      this.readyState = 3
      this.dispatchEvent(new Event('close'))
    }
  }
  class PhoneDate extends Date {
    static now() { return now }
  }
  let openTerminal
  const style = new Map()
  const terminals = []
  const window = Object.assign(new EventTarget(), {
    matchMedia: vi.fn(() => Object.assign(new EventTarget(), { matches: false })),
    innerHeight: 800,
    visualViewport,
    ezRemote: {
      createSessionTree: ({ onOpen }) => {
        openTerminal = onOpen
        return { update() {}, select() {} }
      },
      createApprovals: () => ({ reset() {} }),
      createActivity: () => ({ enter() {}, leave() {}, reset() {} }),
      createPush: () => ({ reset() {}, setAvailability() {} }),
      createTabs: () => ({ reset() {}, setTheme() {} })
    }
  })
  const document = Object.assign(new EventTarget(), {
    hidden: false, getElementById: element, body: element('body'), querySelector: element,
    documentElement: { toggleAttribute() {}, style: { setProperty: style.set.bind(style), removeProperty: style.delete.bind(style) } }
  })
  class Terminal {
    constructor(options) {
      this.options = options
      this.cols = 80
      this.rows = 24
      this.dispose = vi.fn()
      this.write = vi.fn()
      terminals.push(this)
    }
    open() {}
    loadAddon() {}
    focus() {}
    onData(listener) { this.input = listener }
  }
  runInNewContext(app, {
    window, document, Terminal,
    FitAddon: { FitAddon: class { fit() {} } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    navigator: { onLine: true }, setTimeout, clearTimeout,
    location: { protocol: 'https:', host: 'pc.example:8722', hash: '' },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    WebSocket: Socket, Date: PhoneDate, URLSearchParams
  })
  return { element, sockets, terminals, style, window, document, openTerminal }
}

const rememberedDevice = () => new Map([
  [TOKEN_KEY, 'device-token'],
  [TRUST_KEY, JSON.stringify({ ticket: 'remembered-ticket', expiresAt: 1_800_086_400_000 })]
])

function signIn(socket) {
  socket.open()
  socket.receive({ type: 'ready', device: 'phone', features: {} })
}

function startShell(phone, socket) {
  phone.openTerminal({ id: 'session', name: 'web-01' })
  const { requestId } = socket.sent.find(message => message.type === 'open')
  socket.receive({ type: 'opened', shellId: 'shell', requestId })
}

it('resumes a remembered sign-in after reload even when the phone clock is ahead', () => {
  const issuedAt = 1_800_000_000_000
  const storage = new Map([[TOKEN_KEY, 'device-token']])
  const original = openPhone(storage, issuedAt)
  original.element('signin-code').value = '123456'
  original.element('signin-form').dispatchEvent(new Event('submit'))
  const [login] = original.sockets
  login.open()
  expect(login.sent).toEqual([{ type: 'signin', token: 'device-token', code: '123456', remember: true }])
  const trust = { ticket: 'remembered-ticket', expiresAt: issuedAt + 86_400_000 }
  login.receive({ type: 'trust', ...trust })
  expect(JSON.parse(storage.get(TRUST_KEY))).toEqual(trust)

  const reloaded = openPhone(storage, trust.expiresAt + 1000)
  expect(reloaded.sockets).toHaveLength(1)
  const [connection] = reloaded.sockets
  connection.open()
  expect(connection.sent).toEqual([{ type: 'resume', token: 'device-token', ticket: trust.ticket }])
  expect(reloaded.element('view-signin').hidden).toBe(true)
  expect(JSON.parse(storage.get(TRUST_KEY))).toEqual(trust)

  connection.receive({ type: 'error', code: 'trust-expired' })
  expect(reloaded.element('view-signin').hidden).toBe(false)
  expect(storage.has(TRUST_KEY)).toBe(false)
  expect(storage.get(TOKEN_KEY)).toBe('device-token')
})

it('keeps the mobile navigation and parks the SSH shell until the user returns or closes it', () => {
  vi.useFakeTimers()
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000)
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)
  expect(phone.element('tabs').hidden).toBe(false)

  phone.element('terminal-back').dispatchEvent(new Event('click'))
  expect(phone.element('view-sessions').hidden).toBe(false)
  expect(phone.element('terminal-return').hidden).toBe(false)
  expect(connection.sent).toContainEqual({ type: 'shell-visible', shellId: 'shell', visible: false })
  expect(connection.sent.some(message => message.type === 'close')).toBe(false)

  phone.element('terminal-return').dispatchEvent(new Event('click'))
  expect(phone.element('view-terminal').hidden).toBe(false)
  expect(connection.sent).toContainEqual({ type: 'shell-visible', shellId: 'shell', visible: true })
  expect(connection.sent.filter(message => message.type === 'open')).toHaveLength(1)
  phone.element('terminal-close').dispatchEvent(new Event('click'))
  expect(connection.sent).toContainEqual({ type: 'close', shellId: 'shell' })
  expect(phone.terminals[0].dispose).toHaveBeenCalledOnce()
  expect(phone.element('terminal-return').hidden).toBe(true)
})

it('resumes on wake with the remembered ticket and restores the terminal transcript', () => {
  vi.useFakeTimers()
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000)
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)
  connection.receive({ type: 'data', shellId: 'shell', data: 'before disconnect' })

  phone.document.hidden = true
  phone.document.dispatchEvent(new Event('visibilitychange'))
  connection.close()
  vi.advanceTimersByTime(30_000)
  expect(phone.sockets).toHaveLength(1)

  phone.document.hidden = false
  phone.document.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(1000)
  const resumed = phone.sockets[1]
  signIn(resumed)
  expect(resumed.sent).toEqual([{ type: 'resume', token: 'device-token', ticket: 'remembered-ticket' }])
  expect(phone.element('view-terminal').hidden).toBe(false)
  expect(phone.element('terminal-close').hidden).toBe(true)
  expect(phone.terminals[0].write).toHaveBeenCalledWith('before disconnect')
  expect(phone.terminals[0].dispose).not.toHaveBeenCalled()
  phone.terminals[0].input('x')
  expect(resumed.sent.some(message => message.type === 'input')).toBe(false)
})

it('backs off for five attempts and exposes manual retry when the connection stays down', () => {
  vi.useFakeTimers()
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000)
  signIn(phone.sockets[0])
  phone.sockets[0].close()
  for (const [index, delay] of [1000, 2000, 4000, 8000, 16000].entries()) {
    vi.advanceTimersByTime(delay - 1)
    expect(phone.sockets).toHaveLength(index + 1)
    vi.advanceTimersByTime(1)
    expect(phone.sockets).toHaveLength(index + 2)
    phone.sockets.at(-1).close()
  }
  phone.window.dispatchEvent(new Event('online'))
  vi.advanceTimersByTime(30_000)
  expect(phone.sockets).toHaveLength(6)
  expect(phone.element('message-retry').hidden).toBe(false)
})

it('stops automatic retries after a remembered ticket is rejected', () => {
  vi.useFakeTimers()
  const storage = rememberedDevice()
  const phone = openPhone(storage, 1_800_000_000_000)
  signIn(phone.sockets[0])
  phone.sockets[0].close()
  vi.advanceTimersByTime(1000)
  phone.sockets[1].open()
  phone.sockets[1].receive({ type: 'error', code: 'bad-ticket', message: 'Try a code' })
  phone.sockets[1].close()
  phone.window.dispatchEvent(new Event('online'))
  vi.advanceTimersByTime(30_000)
  expect(phone.sockets).toHaveLength(2)
  expect(phone.element('view-signin').hidden).toBe(false)
  expect(storage.has(TRUST_KEY)).toBe(false)
})

it('fits the terminal to the visual viewport and requires height for the desktop layout', () => {
  const viewport = Object.assign(new EventTarget(), { height: 650, offsetTop: 0, scale: 1 })
  const phone = openPhone(new Map(), 1_800_000_000_000, viewport)
  expect(phone.window.matchMedia).toHaveBeenCalledWith('(min-width: 45rem) and (min-height: 40rem)')
  expect(phone.style.get('--visible-height')).toBe('650px')
  viewport.height = 290.5
  viewport.offsetTop = 20
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.style.get('--visible-height')).toBe('290px')
  expect(phone.style.get('--visible-top')).toBe('20px')
  viewport.scale = 2
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.style.has('--visible-height')).toBe(false)
})

it('hides terminal tabs below 75% visual height and clears the navigation safe-area inset until the keyboard closes', () => {
  vi.useFakeTimers()
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000, viewport)
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)

  viewport.height = 600
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.element('tabs').hidden).toBe(false)
  expect(phone.style.has('--tab-safe-bottom')).toBe(false)

  viewport.height = 599
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.element('tabs').hidden).toBe(true)
  expect(phone.style.get('--tab-safe-bottom')).toBe('0px')

  phone.element('terminal-back').dispatchEvent(new Event('click'))
  expect(phone.element('tabs').hidden).toBe(false)
  expect(phone.style.get('--tab-safe-bottom')).toBe('0px')
  phone.element('terminal-return').dispatchEvent(new Event('click'))
  expect(phone.element('tabs').hidden).toBe(true)

  viewport.height = 800
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.element('tabs').hidden).toBe(false)
  expect(phone.style.has('--tab-safe-bottom')).toBe(false)
})
