import { describe, expect, it } from 'vitest'
import { cleanChatText } from './ipc.js'

describe('text the chat view may send', () => {
  it('keeps lines and tabs, unifies line ends and trims the ends', () => {
    expect(cleanChatText('\n첫 줄\r\n\t둘째 줄\r셋째  \n')).toBe('첫 줄\n\t둘째 줄\n셋째')
  })

  it('refuses control characters: an ESC could end the bracketed paste and type keys', () => {
    expect(cleanChatText('a\x1b[201~rm -rf ~\r')).toBeNull()
    expect(cleanChatText('a\x03')).toBeNull()
    expect(cleanChatText('a\u009b31m')).toBeNull()
  })

  it('refuses empty, too long and non-text values', () => {
    expect(cleanChatText('   \n ')).toBeNull()
    expect(cleanChatText('x'.repeat(16_001))).toBeNull()
    expect(cleanChatText(42)).toBeNull()
  })
})

describe('pinned answer windows', async () => {
  const { registerAgentChatIpc } = await import('./ipc.js')
  const { createPins } = await import('./pins.js')
  const { linkKeysIn } = await import('./links.js')
  const { EventEmitter } = await import('node:events')

  function setup() {
    const handlers = new Map()
    const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) }
    const main = {}
    const windows = []
    const shown = linkKeysIn('https://example.com/a', process.platform, null)
    const chats = { cwdOf: () => null, knowsLink: (id, key) => shown.includes(key) }
    const pins = createPins({
      createWindow: () => {
        const win = Object.assign(new EventEmitter(), { webContents: {}, isDestroyed: () => false, close() {} })
        windows.push(win)
        return win
      },
      chats
    })
    const opened = []
    const went = []
    let locked = false
    registerAgentChatIpc({
      ipcMain, fromMainWindow: event => event.sender === main, isLocked: () => locked, chats, shells: () => null,
      clipboard: null, links: { openExternal: url => opened.push(url) }, pins, showShell: id => went.push(id)
    })
    const call = (name, sender, ...args) => handlers.get(name)({ sender }, ...args)
    return { call, main, windows, opened, went, lock: () => { locked = true } }
  }
  const request = { shellId: 'local:1', itemId: 'a:0', text: '[보기](https://example.com/a) 와 https://other.test', kind: 'codex', title: '확인', time: 1 }

  it('pins only from the main window, and a window reads only its own pin', async () => {
    const { call, main, windows } = setup()
    expect((await call('agent-chat-pin', {}, request)).ok).toBe(false)
    expect(await call('agent-chat-pin', main, request)).toEqual({ ok: true, id: 'pin-1' })
    expect((await call('pinned-reply-get', windows[0].webContents)).pin.title).toBe('확인')
    expect((await call('pinned-reply-get', {})).ok).toBe(false)
  })

  it('opens links of the answer the conversation had shown, nothing else, and goes back to the shell', async () => {
    const { call, main, windows, opened, went } = setup()
    await call('agent-chat-pin', main, request)
    const sender = windows[0].webContents
    expect(await call('pinned-reply-open-link', sender, { href: 'https://example.com/a', how: 'browser' })).toEqual({ ok: true })
    expect((await call('pinned-reply-open-link', sender, { href: 'https://other.test', how: 'browser' })).ok).toBe(false)
    expect(opened).toEqual(['https://example.com/a'])
    call('pinned-reply-go', sender)
    expect(went).toEqual(['local:1'])
  })

  it('answers nothing while the app is locked', async () => {
    const { call, main, windows, lock } = setup()
    await call('agent-chat-pin', main, request)
    lock()
    expect((await call('pinned-reply-get', windows[0].webContents)).ok).toBe(false)
  })
})
