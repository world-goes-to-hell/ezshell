import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import app from './app.js?raw'

const TOKEN_KEY = 'ezshell-device-token'
const TRUST_KEY = 'ezshell-device-trust'

function openPhone(storage, now) {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventTarget(), {
      hidden: true, value: '', checked: id === 'signin-remember',
      querySelector: () => null, querySelectorAll: () => [],
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
  }
  class PhoneDate extends Date {
    static now() { return now }
  }
  runInNewContext(app, {
    window: {
      matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
      addEventListener() {},
      ezRemote: {
        createSessionTree: () => ({}), createApprovals: () => ({}),
        createActivity: () => ({}), createPush: () => ({}), createTabs: () => ({})
      }
    },
    document: { getElementById: element, body: element('body') },
    location: { protocol: 'https:', host: 'pc.example:8722', hash: '' },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    WebSocket: Socket, Date: PhoneDate, URLSearchParams
  })
  return { element, sockets }
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
