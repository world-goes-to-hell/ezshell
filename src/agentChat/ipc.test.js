import { describe, expect, it } from 'vitest'
import { cleanChatText, registerAgentChatIpc } from './ipc.js'

function harness(kind = 'claude', { chats = {}, active = () => null, agentId = () => 'agent-1', status = () => 'idle', screen = () => null,
  duringSend = () => {}, result = { ok: true } } = {}) {
  const handlers = new Map()
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) }
  const sent = []
  const discarded = []
  const captures = []
  let stored = 0
  const bitmap = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from('png') }
  const { sendCapture } = registerAgentChatIpc({
    ipcMain,
    fromMainWindow: () => true,
    isLocked: () => false,
    chats,
    notifyCapture: capture => captures.push(capture),
    shells: () => ({
      agentOf: () => ({ kind, status: status() }),
      chatAgentId: agentId,
      chatInputTarget: active,
      chatScreen: screen,
      chatSend: async (_id, prompt, images, target, verify = () => true, { canSend = () => true } = {}) => {
        duringSend()
        if (!verify() || !canSend()) return { ok: false, reason: 'target-changed' }
        sent.push({ prompt, images, ...(target === undefined ? {} : { target }) })
        return result
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
  return { call, paste, sent, discarded, sendCapture, captures }
}

const retryRequest = () => ({ acceptedAt: Date.now() - 15_000, transcriptId: 'a'.repeat(64), ignoreIds: [] })
const emptyTranscriptCheck = { hasTranscript: () => true, findRecordedSend: async () => null }

describe('subagent conversation', () => {
  it('requires the active provider target to stay consistent with the selected child', async () => {
    let target = 'Review layout'
    const record = { kind: 'claude', live: true, scope: 'parent-conversation', messages: [], identity: { id: 'a1b2' },
      child: { task: 'Review layout', uniqueTask: true, keys: ['toolu_1'] } }
    const { call, sent } = harness('claude', { active: () => target,
      chats: {
        subagentConversation: async (id, child) => id === 'local:1' && child === 'toolu_1' ? record : null,
        hasSubagentScope: (id, scope) => id === 'local:1' && scope === record.scope
      } })
    const request = { shellId: 'local:1', agentId: 'toolu_1', scope: record.scope, text: 'Check the narrow pane', mode: 'direct' }
    expect(await call('agent-chat-subagent-conversation', 'local:1', 'toolu_1')).toEqual({ mode: 'direct', messages: [], scope: record.scope })
    target = 'Another task'
    expect((await call('agent-chat-subagent-send', request)).ok).toBe(false)
    expect((await call('agent-chat-subagent-send', { ...request, shellId: 'local:2' })).ok).toBe(false)
    expect(sent).toEqual([])
    target = 'Review layout'
    expect((await call('agent-chat-subagent-send', { ...request, scope: 'previous-conversation' })).ok).toBe(false)
    expect(await call('agent-chat-subagent-send', request)).toEqual({ ok: true })
    expect(sent).toEqual([{ prompt: request.text, images: undefined, target }])
  })

  it('relays a Codex V2 follow-up only from the verified parent', async () => {
    let target = '/root/review'
    const record = { kind: 'codex', live: true, scope: 'parent-conversation', messages: [], identity: {}, child: { keys: ['/root/review'] } }
    const { call, sent } = harness('codex', { active: () => target, chats: {
      subagentConversation: async () => record, hasSubagentScope: (id, scope) => id === 'local:1' && scope === record.scope
    } })
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
    const files = ['C:\\tmp\\shot-1.png', 'C:\\tmp\\shot-2.png']
    expect(sent[0]).toEqual(kind === 'codex'
      ? { prompt: '봐 줘', images: { files } }
      : { prompt: files.join('\n') + '\n\n봐 줘', images: { count: 2, text: '봐 줘' } })
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
    expect(sent[0]).toEqual({ prompt: 'C:\\tmp\\shot-2.png', images: { count: 1, text: '' } })
    expect((await call('agent-chat-send', { shellId: 'local:1', text: '', imageIds: [ids[2], ids[2]] })).ok).toBe(false)
  })

  it('reuses the original attachment through an explicit retry in the same shell', async () => {
    const { call, paste, sent } = harness('codex', { chats: { ...emptyTranscriptCheck, close: () => {} } })
    const imageId = await paste()
    const request = { shellId: 'local:1', text: '봐 줘', imageIds: [imageId] }
    expect(await call('agent-chat-send', request)).toEqual({ ok: true })
    call('agent-chat-close', request.shellId)
    expect((await call('agent-chat-send', request)).ok).toBe(false)
    expect((await call('agent-chat-send', { ...request, shellId: 'local:2', retry: retryRequest() })).ok).toBe(false)
    expect(await call('agent-chat-send', { ...request, retry: retryRequest() })).toEqual({ ok: true })
    expect(sent).toEqual(Array(2).fill({ prompt: '봐 줘', images: { files: ['C:\\tmp\\shot-1.png'] } }))
  })
})

describe('manual chat resend', () => {
  const request = () => ({ shellId: 'local:1', text: '확인해 줘', retry: retryRequest() })

  it.each(['working', 'starting', 'unknown', 'blocked'])('refuses a resend when the agent status is %s', async status => {
    const { call, sent } = harness('codex', { status: () => status })
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'retry-not-idle' })
    expect(sent).toEqual([])
  })

  it('refuses an idle Claude with a queue hint wrapped across two lines', async () => {
    const { call, sent } = harness('claude', { screen: () => ({ lines: ['› ', '  Press up to edit', '  queued messages'] }) })
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'retry-queued' })
    expect(sent).toEqual([])
  })

  it.each([
    'Press up to edit queued messages',
    'Press up to edit your queued message',
    'Press up to select a queued message to edit, or Enter to send them now',
    'Press up to select a queued message, then Enter to edit it'
  ])('recognizes the Claude queue hint %s', async hint => {
    const { call, sent } = harness('claude', { screen: () => ({ lines: ['❯ ', '  ' + hint] }) })
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'retry-queued' })
    expect(sent).toEqual([])
  })

  it('checks the Claude footer past the last eight rows', async () => {
    const lines = [...Array(18).fill('Draft'), 'Press up to select a', 'queued message, then Enter to edit it', ...Array(12).fill('')]
    const { call, sent } = harness('claude', { screen: () => ({ lines, footerRow: 18 }) })
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'retry-queued' })
    expect(sent).toEqual([])
  })

  it('ignores the same wording in conversation history above a visible Claude composer', async () => {
    const lines = ['Press up to select a queued message, then Enter to edit it', ...Array(18).fill(''), 'Idle']
    const { call, sent } = harness('claude', { chats: emptyTranscriptCheck, screen: () => ({ lines, footerRow: 19 }) })
    expect(await call('agent-chat-send', request())).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
  })

  it('returns the transcript record instead of sending another copy', async () => {
    const recorded = { id: 'user:late', kind: 'user', text: '확인해 줘', time: Date.now() }
    const chats = { ...emptyTranscriptCheck, findRecordedSend: async (shellId, retry) => {
      expect(shellId).toBe('local:1')
      expect(retry).toMatchObject({ text: recorded.text, hasImage: false, transcriptId: 'a'.repeat(64), ignoreIds: [] })
      return recorded
    } }
    const { call, sent } = harness('codex', { chats })
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'already-recorded', recorded })
    expect(sent).toEqual([])
  })

  it('refuses a resend when its transcript can no longer be read', async () => {
    const { call, sent } = harness('codex', {
      chats: { ...emptyTranscriptCheck, findRecordedSend: async () => undefined }
    })
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'retry-transcript' })
    expect(sent).toEqual([])
  })

  it('rechecks the agent and queue when the terminal is about to send', async () => {
    let queue = false
    const { call, sent } = harness('claude', {
      chats: emptyTranscriptCheck, duringSend: () => { queue = true },
      screen: () => ({ lines: queue ? ['↑ to edit queued messages'] : [] })
    })
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'retry-queued' })
    expect(sent).toEqual([])
  })

  it('allows only one retry in flight per shell', async () => {
    let finishReading
    const { call, sent } = harness('codex', {
      chats: { ...emptyTranscriptCheck, findRecordedSend: () => new Promise(resolve => { finishReading = resolve }) }
    })
    const first = call('agent-chat-send', request())
    expect(await call('agent-chat-send', request())).toMatchObject({ ok: false, reason: 'busy' })
    finishReading(null)
    expect(await first).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
  })
})

describe('screenshots sent from quick capture', () => {
  it.each(['codex', 'claude'])('delivers the saved region and comment via %s chat input', async kind => {
    const { sendCapture, sent, captures } = harness(kind)
    const files = ['C:\\tmp\\capture.png']
    const preview = Buffer.from('preview png')
    const target = { id: 'agent-1', shellId: 'local:1', kind }
    expect(await sendCapture(target, '화면 확인', () => ({ file: files[0], preview }), () => true)).toEqual({ ok: true })
    expect(sent[0]).toEqual(kind === 'codex'
      ? { prompt: '화면 확인', images: { files } }
      : { prompt: files[0] + '\n\n화면 확인', images: { count: 1, text: '화면 확인' } })
    expect(captures).toEqual([{ shellId: target.shellId, id: expect.stringMatching(/^outgoing:/), time: expect.any(Number), text: '화면 확인', preview, queued: false }])
  })

  it('retracts the capture bubble when input is refused', async () => {
    const { sendCapture, captures } = harness('claude', { result: { ok: false, reason: 'busy' } })
    const target = { id: 'agent-1', shellId: 'local:1', kind: 'claude' }
    const attachment = { file: 'capture.png', preview: Buffer.from('preview') }
    expect(await sendCapture(target, '봐 줘', () => attachment, () => true)).toMatchObject({ ok: false, reason: 'busy' })
    expect(captures).toHaveLength(2)
    expect(captures[1]).toEqual({ shellId: target.shellId, id: captures[0].id, discard: true })
  })

  it('refuses a stale target, a closed overlay or control characters before storing the image', async () => {
    const { sendCapture, sent } = harness()
    const target = { id: 'agent-1', shellId: 'local:1', kind: 'claude' }
    const file = () => { throw new Error('the capture was stored') }
    expect((await sendCapture({ ...target, id: 'previous-agent' }, '봐 줘', file, () => true)).ok).toBe(false)
    expect((await sendCapture(target, '봐 줘', file, () => false)).ok).toBe(false)
    expect((await sendCapture(target, '봐 줘\x1b', file, () => true)).ok).toBe(false)
    expect(sent).toEqual([])
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

describe('answering a Claude question from the chat card', () => {
  const color = { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Green', description: '' }] }
  function setup({ pending = { questions: [color] }, result = { ok: true } } = {}) {
    const handlers = new Map()
    const calls = []
    registerAgentChatIpc({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
      fromMainWindow: () => true,
      isLocked: () => false,
      chats: { pendingQuestion: (id, itemId) => (id === 'local:1' && itemId === 'tool:toolu_q' ? pending : null) },
      shells: () => ({ answerQuestions: async (...args) => { calls.push(args); return result } }),
      clipboard: {}
    })
    const answer = request => handlers.get('agent-chat-answer-questions')({}, request)
    return { answer, calls }
  }

  it('answers with main’s own questions and the checked choices', async () => {
    const { answer, calls } = setup()
    expect(await answer({ shellId: 'local:1', itemId: 'tool:toolu_q', answers: [{ picks: [1] }] })).toEqual({ ok: true })
    expect(calls).toEqual([['local:1', [color], [{ picks: [1], other: null }]]])
  })

  it('refuses an answer that does not fit, a question already answered and a bad id, pressing nothing', async () => {
    const { answer, calls } = setup()
    for (const answers of [[{ picks: [0, 1] }], [{ picks: [5] }], [{ picks: [], other: 'a\rb' }], [], [{ picks: [0] }, { picks: [0] }]]) {
      expect((await answer({ shellId: 'local:1', itemId: 'tool:toolu_q', answers })).ok).toBe(false)
    }
    expect(await answer({ shellId: 'local:1', itemId: 'tool:other', answers: [{ picks: [0] }] })).toMatchObject({ ok: false, reason: 'answered' })
    expect((await answer({ shellId: 'local:1', itemId: 'tool:../x', answers: [{ picks: [0] }] })).ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('names why the keys stopped', async () => {
    const { answer } = setup({ result: { ok: false, reason: 'mismatch' } })
    expect(await answer({ shellId: 'local:1', itemId: 'tool:toolu_q', answers: [{ picks: [0] }] })).toMatchObject({ ok: false, reason: 'mismatch', error: expect.stringContaining('제출하지 않았습니다') })
  })
})

describe('opening a link of an answer', () => {
  it('opens a folder in the file manager instead of refusing it (2026-11-23 user report: `mockups/`)', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-link-'))
    fs.mkdirSync(path.join(root, 'mockups'))
    fs.writeFileSync(path.join(root, 'a.md'), '#')
    const handlers = new Map()
    const folders = []
    const files = []
    registerAgentChatIpc({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
      fromMainWindow: () => true, isLocked: () => false, shells: () => null, clipboard: null,
      chats: { cwdOf: () => root, knowsLink: () => true },
      links: { openFolder: target => folders.push(target), openLocalFile: target => { files.push(target); return { ok: true } } }
    })
    const open = href => handlers.get('agent-chat-open-link')({ sender: {} }, { shellId: 'local:1', href, how: 'app' })
    try {
      expect(await open('mockups/')).toEqual({ ok: true })
      expect(folders).toEqual([fs.realpathSync(path.join(root, 'mockups'))])
      expect(await open('a.md')).toEqual({ ok: true })
      expect(files).toEqual([fs.realpathSync(path.join(root, 'a.md'))])
      expect(folders).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
