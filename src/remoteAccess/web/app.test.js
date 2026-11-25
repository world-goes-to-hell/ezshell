import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import app from './app.js?raw'
import theme from './theme.js?raw'

const TOKEN_KEY = 'ezshell-device-token'
const TRUST_KEY = 'ezshell-device-trust'
const THEME_KEY = 'ezshell-remote-theme'

afterEach(() => vi.useRealTimers())

function openPhone(storage, now, visualViewport, standalone = false, wide = false) {
  const elements = new Map()
  const makeElement = (id = '') => Object.assign(new EventTarget(), {
    id, hidden: true, value: '', checked: id === 'signin-remember', children: [], dataset: {}, attributes: new Map(),
    classList: { toggle() {} },
    querySelector: selector => selector === '.bar' ? null : element(`${id} ${selector}`),
    querySelectorAll: () => [],
    append(...children) {
      for (const child of children) {
        if (child.parentElement) child.remove()
        this.children.push(child)
        child.parentElement = this
      }
    },
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children) },
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this)
      this.parentElement = null
    },
    requestSubmit() { this.dispatchEvent(new Event('submit', { cancelable: true })) },
    cloneNode() { return makeElement(id) },
    focus() {},
    setAttribute(name, value) { this.attributes.set(name, value) },
    getAttribute(name) { return this.attributes.get(name) ?? null },
    removeAttribute(name) { this.attributes.delete(name) },
    toggleAttribute(name, enabled) {
      if (enabled) this.setAttribute(name, '')
      else this.removeAttribute(name)
    }
  })
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id))
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
  let openTerminal, openPcTab, openChat
  const style = new Map()
  const pcOptions = vi.fn()
  const agentMessages = vi.fn()
  const terminals = []
  const window = Object.assign(new EventTarget(), {
    matchMedia: vi.fn(query => Object.assign(new EventTarget(), { matches: wide && !query.includes('display-mode') })),
    innerHeight: 800,
    visualViewport,
    ezRemote: {
      createSessionTree: ({ onOpen }) => {
        openTerminal = onOpen
        return { update() {}, select() {} }
      },
      createApprovals: () => ({ reset() {}, add() {}, closed() {} }),
      createActivity: () => ({ enter() {}, leave() {}, reset() {} }),
      createPush: () => ({ reset() {}, setAvailability() {} }),
      createTabs: ({ onOpen, send }) => {
        openPcTab = onOpen
        let current
        return {
          reset() { current = null }, setTerminalOptions: pcOptions, enter() {}, onMessage() {},
          reopen(tab) { current = tab.id; send({ type: 'tab-attach', tabId: current }) },
          detach() { if (current) send({ type: 'tab-detach', tabId: current }); current = null }
        }
      },
      createAgents: ({ onOpen, send }) => {
        openChat = onOpen
        let current
        return {
          enter() {}, leave() {}, reset() { current = null }, onMessage: agentMessages, setReviewTabs() {}, setTabStatus() {},
          nameOf: agent => agent.agentId,
          reopen(agent) { current = agent.shellId; send({ type: 'chat-open', shellId: current }) },
          closeChat() { if (current) send({ type: 'chat-close', shellId: current }); current = null }
        }
      }
    }
  })
  const document = Object.assign(new EventTarget(), {
    hidden: false, getElementById: element, body: element('body'), querySelector: element,
    createElement: () => makeElement(),
    documentElement: { toggleAttribute() {}, style: { setProperty: style.set.bind(style), removeProperty: style.delete.bind(style) } }
  })
  const history = { replaceState: vi.fn() }
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
  runInNewContext(theme + '\n;\n' + app, {
    window, document, Terminal,
    FitAddon: { FitAddon: class { fit() {} } },
    CSS: { supports: () => true },
    getComputedStyle: () => ({ getPropertyValue: key => style.get(key) ?? '' }),
    navigator: { onLine: true, standalone }, setTimeout, clearTimeout,
    location: { protocol: 'https:', host: 'pc.example:8722', origin: 'https://pc.example:8722', pathname: '/', hash: '' },
    history, URL,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    WebSocket: Socket, Date: PhoneDate, URLSearchParams
  })
  return { element, sockets, terminals, pcOptions, agentMessages, style, window, document, openTerminal, openPcTab, openChat, history }
}

it('registers an installed app through a same-origin pairing link and opens the code sign-in', () => {
  const storage = new Map()
  const phone = openPhone(storage, Date.now(), undefined, true)
  const form = phone.element('pair-link-form')
  expect(form.hidden).toBe(false)
  const code = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 24)
  const submit = link => {
    phone.element('pair-link').value = link
    form.dispatchEvent(new Event('submit', { cancelable: true }))
  }
  submit(`https://another.example/#pair=${code}`)
  expect(phone.sockets).toHaveLength(0)
  expect(phone.element('pair-link-error').hidden).toBe(false)
  submit(`https://pc.example:8722/#pair=${code}`)
  phone.sockets[0].open()
  expect(phone.sockets[0].sent[0]).toMatchObject({ type: 'pair', code })
  phone.sockets[0].receive({ type: 'paired', token: 'new-device' })
  expect(storage.get(TOKEN_KEY)).toBe('new-device')
  expect(phone.history.replaceState).toHaveBeenCalledWith(null, '', '/')
  expect(phone.element('view-signin').hidden).toBe(false)
  expect(phone.element('pair-link').value).toBe('')
})

it('submits a completed OTP automatically and ignores a second submit while it is pending', () => {
  const phone = openPhone(new Map([[TOKEN_KEY, 'device-token']]), Date.now())
  const code = phone.element('signin-code')
  code.value = '12345'
  code.dispatchEvent(new Event('input'))
  expect(phone.sockets).toHaveLength(0)
  code.value = '123456'
  code.dispatchEvent(new Event('input'))
  expect(phone.sockets).toHaveLength(1)
  phone.element('signin-form').requestSubmit()
  expect(phone.sockets).toHaveLength(1)
  const [socket] = phone.sockets
  socket.open()
  expect(socket.sent).toEqual([{ type: 'signin', token: 'device-token', code: '123456', remember: true }])
  phone.element('signin-form').requestSubmit()
  expect(socket.sent).toHaveLength(1)
})

const rememberedDevice = () => new Map([
  [TOKEN_KEY, 'device-token'],
  [TRUST_KEY, JSON.stringify({ ticket: 'remembered-ticket', expiresAt: 1_800_086_400_000 })]
])

it('hydrates only checked cached theme tokens before opening the sign-in screen', () => {
  const storage = new Map([
    [TOKEN_KEY, 'device-token'],
    [THEME_KEY, JSON.stringify({
      '--bg': '#f0f4f8', '--scheme': 'light', '--radius': '0', '--terminal-font': '"D2Coding", monospace',
      '--text': 'var(--untrusted)', '--extra': '#fff', '--t-red': 'url(/anything)'
    })]
  ])
  const phone = openPhone(storage, Date.now())
  expect(phone.element('view-signin').hidden).toBe(false)
  expect(Object.fromEntries(phone.style)).toEqual({
    '--bg': '#f0f4f8', '--scheme': 'light', '--radius': '0px', '--terminal-font': '"D2Coding", monospace'
  })
  expect(phone.element('meta[name="theme-color"]').content).toBe('#f0f4f8')
})

it('updates every open SSH terminal and the PC viewer, and caches only the latest checked theme', () => {
  const storage = rememberedDevice()
  const phone = openPhone(storage, Date.now())
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)
  startShell(phone, connection, 'web-02', 'shell2')
  const incoming = { '--bg': '#e4e7ee', '--t-red': '#ba2a21', '--t-bright-blue': '#3050a0', '--terminal-font': '"D2Coding", monospace' }
  connection.receive({ type: 'theme', theme: { ...incoming, '--panel-radius': '100px', '--extra': '#fff' } })
  const options = { theme: expect.objectContaining({ background: '#e4e7ee', red: '#ba2a21', brightBlue: '#3050a0' }), fontFamily: incoming['--terminal-font'] }
  for (const terminal of phone.terminals) expect(terminal.options).toMatchObject(options)
  expect(phone.pcOptions).toHaveBeenLastCalledWith(options)
  expect(JSON.parse(storage.get(THEME_KEY))).toEqual(incoming)

  connection.receive({ type: 'theme', theme: {} })
  expect(storage.has(THEME_KEY)).toBe(false)
  expect(phone.terminals[0].options.theme).not.toHaveProperty('red')
})

it('uses the PC agent name after its role and keeps the raw agent id for tab routing', () => {
  const phone = openPhone(rememberedDevice(), Date.now())
  const [connection] = phone.sockets
  signIn(connection, { agents: true })
  const role = { shellId: 'local:1', agentId: 'codex-9', kind: 'codex', name: 'Codex 9', role: '  리뷰어  ' }
  const blank = { shellId: 'local:2', agentId: 'claude-10', kind: 'claude', name: 'Claude Code 10', role: ' ' }
  connection.receive({ type: 'agents', agents: [role, blank] })
  const { agents } = phone.agentMessages.mock.lastCall[0]
  expect(agents.map(agent => [agent.agentId, agent.name])).toEqual([
    ['codex-9', '리뷰어 · Codex 9'], ['claude-10', 'Claude Code 10']
  ])
})

function signIn(socket, features = {}, theme) {
  socket.open()
  socket.receive({ type: 'ready', device: 'phone', features, theme })
}

function startShell(phone, socket, id = 'session', shellId = 'shell') {
  phone.openTerminal({ id, name: id === 'session' ? 'web-01' : id })
  const { requestId } = socket.sent.findLast(message => message.type === 'open')
  socket.receive({ type: 'opened', shellId, requestId })
}

function selectTab(phone, index, button = 0) {
  phone.element('workspace-current').children[index].children[button].dispatchEvent(new Event('click'))
}

it('fades only the scrollable tab edges and leaves Ctrl+wheel available for zoom', () => {
  const phone = openPhone(rememberedDevice(), Date.now())
  const strip = phone.element('workspace-current')
  Object.assign(strip, { scrollLeft: 0, clientWidth: 390, scrollWidth: 640 })
  const at = scrollLeft => {
    strip.scrollLeft = scrollLeft
    strip.dispatchEvent(new Event('scroll'))
    return [strip.attributes.has('data-overflow-start'), strip.attributes.has('data-overflow-end')]
  }
  expect(at(0)).toEqual([false, true])
  expect(at(100)).toEqual([true, true])
  expect(at(250)).toEqual([true, false])
  const zoom = Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: true, deltaX: 0, deltaY: -16 })
  strip.dispatchEvent(zoom)
  expect(zoom.defaultPrevented).toBe(false)
  expect(strip.scrollLeft).toBe(250)
})

it('summarizes the folded sidebar by source and hides zero counts and the empty tab row', () => {
  const storage = rememberedDevice()
  storage.set('ezshell-workspace-sidebar', JSON.stringify({ collapsed: true }))
  const phone = openPhone(storage, Date.now(), undefined, false, true)
  const [connection] = phone.sockets
  signIn(connection, { tabs: true, agents: true })
  const status = name => phone.element(`sidebar-${name}-status`)
  expect(phone.element('workspace-sidebar-summary').hidden).toBe(false)
  expect(phone.element('workspace-tabs').hidden).toBe(true)
  for (const name of ['session', 'agent', 'pc', 'approval']) expect(status(name).hidden).toBe(true)

  connection.receive({ type: 'sessions', sessions: [{ openTabs: { connected: 2, disconnected: 1 } }] })
  expect(status('session').getAttribute('aria-label')).toBe('연결된 세션 탭 2개 · 끊긴 세션 탭 1개')
  expect(phone.element('sidebar-session-lost').title).toBe('끊긴 세션 탭 1개')
  startShell(phone, connection)
  expect(phone.element('workspace-tabs').hidden).toBe(false)
  expect(phone.element('sidebar-session-connected').textContent).toBe('3')
  connection.receive({ type: 'closed', shellId: 'shell' })
  expect(phone.element('sidebar-session-connected').textContent).toBe('2')
  expect(phone.element('sidebar-session-lost').textContent).toBe('2')
  selectTab(phone, 0, 1)
  expect(phone.element('sidebar-session-lost').textContent).toBe('1')
  expect(phone.element('workspace-tabs').hidden).toBe(true)
  connection.receive({ type: 'sessions', sessions: [{ openTabs: { connected: 1 } }] })
  expect(phone.element('sidebar-session-lost').hidden).toBe(true)

  const agent = { shellId: 'local:1', status: 'working' }
  connection.receive({ type: 'agents', agents: [agent, { shellId: 'local:2', status: 'idle' }] })
  expect(status('agent').getAttribute('aria-label')).toBe('로컬 작업 에이전트 2개 · 작업 중 1개')
  expect(status('agent').dataset.agentWork).toBe('working')
  connection.receive({ type: 'agents', agents: [{ ...agent, status: 'idle' }] })
  expect(status('agent').dataset.agentWork).toBeUndefined()
  expect(status('agent').title).toBe('로컬 작업 에이전트 1개')
  connection.receive({ type: 'tabs', tabs: [{ id: 'desktop' }, { id: 'preview', kind: 'browser' }] })
  expect(status('pc').title).toBe('공유된 PC 탭 2개')
  connection.receive({ type: 'tabs', tabs: [] })
  expect(status('pc').hidden).toBe(true)
  connection.receive({ type: 'approval', request: { id: 'mcp' } })
  expect(status('approval').getAttribute('aria-label')).toBe('MCP 대기 1개')
  connection.receive({ type: 'approval-closed', id: 'mcp' })
  expect(status('approval').hidden).toBe(true)
})

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

it('keeps two SSH shells alive when switching and closes only the selected shell', () => {
  vi.useFakeTimers()
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000)
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)
  startShell(phone, connection, 'web-02', 'shell2')
  expect(phone.element('workspace-current').children).toHaveLength(2)
  expect(phone.element('view-terminal').hidden).toBe(false)
  expect(connection.sent.filter(message => message.type === 'open')).toHaveLength(2)
  expect(connection.sent.some(message => message.type === 'close' || (message.type === 'shell-visible' && !message.visible))).toBe(false)
  connection.receive({ type: 'data', shellId: 'shell', data: 'hidden shell' })
  expect(phone.terminals[0].write).toHaveBeenCalledWith('hidden shell')
  selectTab(phone, 0)
  phone.terminals[0].input('pwd')
  expect(connection.sent).toContainEqual({ type: 'input', shellId: 'shell', data: 'pwd' })
  selectTab(phone, 1, 1)
  expect(connection.sent.filter(message => message.type === 'close')).toEqual([{ type: 'close', shellId: 'shell2' }])
  expect(phone.terminals[1].dispose).toHaveBeenCalledOnce()
  expect(phone.terminals[0].dispose).not.toHaveBeenCalled()
})

it('closes a late shell response for a tab closed while connecting', () => {
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000)
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)
  phone.openTerminal({ id: 'slow', name: 'slow' })
  const { requestId } = connection.sent.findLast(message => message.type === 'open')
  selectTab(phone, 1, 1)
  connection.receive({ type: 'opened', shellId: 'late-shell', requestId })
  expect(connection.sent.filter(message => message.type === 'close')).toEqual([{ type: 'close', shellId: 'late-shell' }])
  expect(phone.element('workspace-shell-count').textContent).toBe('셸 1')
  expect(phone.terminals[0].dispose).not.toHaveBeenCalled()
})

it('detaches background PC and chat viewers, then restores the open tabs on sign-in', () => {
  vi.useFakeTimers()
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000)
  const [connection] = phone.sockets
  const features = { tabs: true, agents: true }
  const tab = { id: 'pc-1', name: 'PC terminal' }
  const agent = { shellId: 'local:1', agentId: 'codex-1', kind: 'codex', status: 'working' }
  const pcList = { type: 'tabs', tabs: [tab] }
  const agentList = { type: 'agents', agents: [agent] }
  signIn(connection, features)
  connection.receive(pcList)
  connection.receive(agentList)
  startShell(phone, connection)
  phone.openPcTab(tab)
  phone.openChat(agent)
  selectTab(phone, 1)
  expect(connection.sent.filter(message => /^(tab-attach|tab-detach|chat-open|chat-close)$/.test(message.type))).toEqual([
    { type: 'tab-attach', tabId: tab.id }, { type: 'tab-detach', tabId: tab.id },
    { type: 'chat-open', shellId: agent.shellId }, { type: 'chat-close', shellId: agent.shellId },
    { type: 'tab-attach', tabId: tab.id }
  ])
  expect(phone.element('workspace-current').children).toHaveLength(3)
  connection.close()
  vi.advanceTimersByTime(1000)
  const resumed = phone.sockets[1]
  signIn(resumed, features)
  resumed.receive(agentList)
  expect(resumed.sent.some(message => message.type === 'chat-open')).toBe(false)
  resumed.receive(pcList)
  expect(phone.element('workspace-current').children).toHaveLength(3)
  expect(resumed.sent.filter(message => /^(open|tab-attach|chat-open)$/.test(message.type))).toEqual([
    { type: 'tab-attach', tabId: tab.id }
  ])
})

it('keeps both visible PC tabs subscribed in a tablet split until the split closes', () => {
  const phone = openPhone(rememberedDevice(), Date.now(), undefined, false, true)
  const [connection] = phone.sockets
  signIn(connection, { tabs: true })
  const a = { id: 'left', name: 'PC left' }
  const b = { id: 'right', name: 'PC right' }
  connection.receive({ type: 'tabs', tabs: [a, b] })
  phone.openPcTab(a)
  phone.openPcTab(b)
  const changes = () => connection.sent.filter(msg => msg.type === 'tab-attach' || msg.type === 'tab-detach')
  const toggle = phone.element('workspace-split-toggle')
  const click = () => toggle.dispatchEvent(new Event('click'))
  click()
  expect(phone.element('workspace-secondary').hidden).toBe(false)
  expect(changes().slice(-2)).toEqual([{ type: 'tab-attach', tabId: b.id }, { type: 'tab-attach', tabId: a.id }])
  const attached = changes().length
  selectTab(phone, 0)
  selectTab(phone, 1)
  expect(changes()).toHaveLength(attached)
  phone.element('workspace-activity').dispatchEvent(new Event('click'))
  selectTab(phone, 0)
  expect(phone.element('workspace-secondary').hidden).toBe(false)
  expect(changes().slice(-2)).toEqual([{ type: 'tab-attach', tabId: a.id }, { type: 'tab-attach', tabId: b.id }])
  selectTab(phone, 1)
  const resumed = changes().length
  click()
  expect(phone.element('workspace-secondary').hidden).toBe(true)
  expect(changes().slice(resumed)).toEqual([{ type: 'tab-detach', tabId: a.id }])
})

it('cycles and closes tabs from the keyboard while leaving Ctrl+W available to xterm', () => {
  const phone = openPhone(rememberedDevice(), Date.now())
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)
  startShell(phone, connection, 'web-02', 'shell2')
  const row = index => phone.element('workspace-current').children[index]
  const key = (value, shiftKey = false, inTerminal = false) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: value, ctrlKey: true, shiftKey })
    if (inTerminal) Object.defineProperty(event, 'target', { value: { closest: selector => selector === '.xterm' } })
    phone.document.dispatchEvent(event)
    return event
  }
  expect(key('Tab').defaultPrevented).toBe(true)
  expect(row(0).children[0].getAttribute('aria-pressed')).toBe('true')
  expect(key('Tab', true).defaultPrevented).toBe(true)
  expect(row(1).children[0].getAttribute('aria-pressed')).toBe('true')
  expect(key('w', false, true).defaultPrevented).toBe(false)
  expect(phone.element('workspace-current').children).toHaveLength(2)
  expect(key('1').defaultPrevented).toBe(true)
  expect(key('w').defaultPrevented).toBe(true)
  expect(connection.sent.filter(msg => msg.type === 'close')).toEqual([{ type: 'close', shellId: 'shell' }])
})

it('remembers the collapsed tablet sidebar and shows only its status counts', () => {
  const storage = rememberedDevice()
  const open = () => openPhone(storage, Date.now(), undefined, false, true)
  const phone = open()
  signIn(phone.sockets[0])
  const toggle = phone.element('workspace-sidebar-toggle')
  toggle.dispatchEvent(new Event('click'))
  expect(phone.element('view-sessions').hidden).toBe(true)
  expect(phone.element('workspace-sidebar-summary').hidden).toBe(false)
  const reloaded = open()
  signIn(reloaded.sockets[0])
  expect(reloaded.element('view-sessions').hidden).toBe(true)
  reloaded.element('workspace-sidebar-toggle').dispatchEvent(new Event('click'))
  expect(reloaded.element('view-sessions').hidden).toBe(false)
  expect(reloaded.element('workspace-sidebar-summary').hidden).toBe(true)
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
  signIn(resumed, {}, { '--t-red': '#862025', '--terminal-font': '"D2Coding", monospace' })
  expect(resumed.sent).toEqual([{ type: 'resume', token: 'device-token', ticket: 'remembered-ticket' }])
  expect(phone.element('view-terminal').hidden).toBe(false)
  expect(phone.element('terminal-close').hidden).toBe(true)
  expect(phone.terminals[0].write).toHaveBeenCalledWith('before disconnect')
  expect(phone.terminals[0].dispose).not.toHaveBeenCalled()
  expect(phone.terminals[0].options.theme.red).toBe('#862025')
  expect(phone.terminals[0].options.fontFamily).toBe('"D2Coding", monospace')
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

it('hides the status bar below 75% visual height and keeps the top tabs visible', () => {
  vi.useFakeTimers()
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
  const phone = openPhone(rememberedDevice(), 1_800_000_000_000, viewport)
  const [connection] = phone.sockets
  signIn(connection)
  startShell(phone, connection)

  viewport.height = 600
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.element('workspace-status').hidden).toBe(false)

  viewport.height = 599
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.element('workspace-status').hidden).toBe(true)
  expect(phone.element('workspace-tabs').hidden).toBe(false)

  viewport.height = 800
  viewport.dispatchEvent(new Event('resize'))
  expect(phone.element('workspace-status').hidden).toBe(false)
})
