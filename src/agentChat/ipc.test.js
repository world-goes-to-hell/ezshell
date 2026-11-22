import { describe, expect, it } from 'vitest'
import { cleanChatText, registerAgentChatIpc } from './ipc.js'

function harness(kind = 'claude', { chats = {}, active = () => null } = {}) {
  const handlers = new Map()
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) }
  const sent = []
  const discarded = []
  let stored = 0
  const bitmap = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from('png') }
  registerAgentChatIpc({
    ipcMain,
    fromMainWindow: () => true,
    isLocked: () => false,
    chats,
    shells: () => ({
      agentOf: () => ({ kind }),
      chatInputTarget: active,
      chatSend: async (_id, prompt, claudeImages, target) => {
        sent.push({ prompt, claudeImages, ...(target === undefined ? {} : { target }) })
        return { ok: true }
      }
    }),
    clipboard: {
      read: async () => ({ text: '', image: {} }),
      decodeImage: async () => bitmap,
      storeImage: () => `C:\\tmp\\shot-${++stored}.png`,
      discardImage: file => discarded.push(file)
    }
  })
  const call = (name, ...args) => handlers.get(name)({}, ...args)
  const paste = async () => {
    const result = await call('agent-chat-read-clipboard', 'local:1')
    expect(result).toMatchObject({ ok: true, kind: 'images' })
    expect(result.images).toHaveLength(1)
    return result.images[0].id
  }
  return { call, paste, sent, discarded }
}

describe('subagent conversation', () => {
  it('requires the active provider target to stay consistent with the selected child', async () => {
    let target = 'Review layout'
    const record = { kind: 'claude', live: true, scope: 'parent-conversation', messages: [], identity: { id: 'a1b2' },
      child: { task: 'Review layout', uniqueTask: true, keys: ['toolu_1'] } }
    const { call, sent } = harness('claude', { active: () => target,
      chats: { subagentConversation: async (id, child) => id === 'local:1' && child === 'toolu_1' ? record : null } })
    const request = { shellId: 'local:1', agentId: 'toolu_1', scope: record.scope, text: 'Check the narrow pane', mode: 'direct' }
    expect(await call('agent-chat-subagent-conversation', 'local:1', 'toolu_1')).toEqual({ mode: 'direct', messages: [], scope: record.scope })
    target = 'Another task'
    expect((await call('agent-chat-subagent-send', request)).ok).toBe(false)
    expect((await call('agent-chat-subagent-send', { ...request, shellId: 'local:2' })).ok).toBe(false)
    expect(sent).toEqual([])
    target = 'Review layout'
    expect((await call('agent-chat-subagent-send', { ...request, scope: 'previous-conversation' })).ok).toBe(false)
    expect(await call('agent-chat-subagent-send', request)).toEqual({ ok: true })
    expect(sent).toEqual([{ prompt: request.text, claudeImages: undefined, target }])
  })

  it('relays a Codex V2 follow-up only from the verified parent', async () => {
    let target = '/root/review'
    const record = { kind: 'codex', live: true, scope: 'parent-conversation', messages: [], identity: {}, child: { keys: ['/root/review'] } }
    const { call, sent } = harness('codex', { active: () => target, chats: { subagentConversation: async () => record } })
    const request = { shellId: 'local:1', agentId: '/root/review', scope: record.scope, text: 'Review\nthe final commit', mode: 'relay' }
    expect(await call('agent-chat-subagent-conversation', 'local:1', '/root/review')).toEqual({ mode: 'select-parent', messages: [], scope: record.scope })
    expect((await call('agent-chat-subagent-send', request)).ok).toBe(false)
    target = ''
    expect(await call('agent-chat-subagent-send', request)).toEqual({ ok: true })
    expect(sent).toEqual([{ prompt: expect.stringContaining('"/root/review" using followup_task'), claudeImages: undefined, target: '' }])
    expect(sent[0].prompt.endsWith(JSON.stringify(request.text))).toBe(true)
  })
})

describe('screenshots pasted into a chat', () => {
  it.each(['codex', 'claude'])('sends every pasted image and only the entered text to %s', async kind => {
    const { call, paste, sent } = harness(kind)
    const first = await paste()
    const second = await paste()
    expect(second).not.toBe(first)
    expect(await call('agent-chat-send', { shellId: 'local:1', text: '봐 줘', imageIds: [first, second] })).toEqual({ ok: true })
    expect(sent[0]).toEqual({
      prompt: 'C:\\tmp\\shot-1.png\nC:\\tmp\\shot-2.png\n\n봐 줘',
      claudeImages: kind === 'claude' ? { count: 2, text: '봐 줘' } : undefined
    })
    // Sent images are gone: sending them again is refused
    expect((await call('agent-chat-send', { shellId: 'local:1', text: '', imageIds: [first] })).ok).toBe(false)
  })

  it('drops only the removed image, and refuses more than the limit', async () => {
    const { call, paste, sent, discarded } = harness()
    const ids = []
    for (let i = 0; i < 8; i++) ids.push(await paste())
    expect((await call('agent-chat-read-clipboard', 'local:1')).ok).toBe(false)
    call('agent-chat-remove-image', { shellId: 'local:1', imageId: ids[0] })
    expect(discarded).toEqual(['C:\\tmp\\shot-1.png'])
    expect((await call('agent-chat-send', { shellId: 'local:1', text: '', imageIds: [ids[0]] })).ok).toBe(false)
    expect(await call('agent-chat-send', { shellId: 'local:1', text: '', imageIds: [ids[1]] })).toEqual({ ok: true })
    expect(sent[0]).toEqual({ prompt: 'C:\\tmp\\shot-2.png', claudeImages: { count: 1, text: '' } })
    expect((await call('agent-chat-send', { shellId: 'local:1', text: '', imageIds: [ids[2], ids[2]] })).ok).toBe(false)
  })
})

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
        const win = Object.assign(new EventEmitter(), { webContents: {}, isDestroyed: () => false, isMaximized: () => false, close() {} })
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
