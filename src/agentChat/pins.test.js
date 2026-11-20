import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPins, cleanLabel, MAX_PINS, FOLDED_HEIGHT, MIN_HEIGHT } = require('./pins.js')
const { linkKeysIn } = require('./links.js')

function fakeWindow() {
  const win = new EventEmitter()
  win.webContents = {}
  win.size = [420, 520]
  win.destroyed = false
  win.isDestroyed = () => win.destroyed
  win.isMinimized = () => false
  win.restore = () => {}
  win.show = () => {}
  win.focus = () => { win.focused = (win.focused ?? 0) + 1 }
  win.close = () => { win.destroyed = true; win.emit('closed') }
  win.getSize = () => win.size
  win.setSize = (width, height) => { win.size = [width, height] }
  win.setMinimumSize = () => {}
  win.setResizable = value => { win.resizable = value }
  return win
}

function setup(known = []) {
  const windows = []
  const chats = {
    cwdOf: () => 'D:\\work\\app',
    knowsLink: (shellId, key) => known.includes(key)
  }
  const pins = createPins({ createWindow: () => { const win = fakeWindow(); windows.push(win); return win }, chats, platform: 'win32', now: () => 1000 })
  return { pins, windows }
}

const answer = { shellId: 'local:3', itemId: 'msg_1:0', text: '화면은 http://localhost:5173 에서 보면 됩니다. `docs/plan/a.md` 참고', kind: 'claude', title: '정렬\u0007 순서', time: 5 }

describe('pinned replies', () => {
  it('pins an answer into a window of its own and answers that window only', () => {
    const { pins, windows } = setup()
    expect(pins.pin(answer)).toEqual({ ok: true, id: 'pin-1' })
    const pin = pins.ofSender(windows[0].webContents)
    expect(pins.view(pin)).toEqual({ text: answer.text, kind: 'claude', title: '정렬 순서', time: 5, pinnedAt: 1000, folded: false })
    expect(pins.ofSender({})).toBeNull()
  })

  it('brings the window of an answer already pinned forward', () => {
    const { pins, windows } = setup()
    pins.pin(answer)
    expect(pins.pin(answer)).toEqual({ ok: true, id: 'pin-1', existing: true })
    expect(windows).toHaveLength(1)
    expect(windows[0].focused).toBe(1)
  })

  it('refuses a malformed request and more than the limit', () => {
    const { pins } = setup()
    expect(pins.pin({ ...answer, shellId: 'ssh-1' }).ok).toBe(false)
    expect(pins.pin({ ...answer, text: '   ' }).ok).toBe(false)
    expect(pins.pin({ ...answer, itemId: 'a b' }).ok).toBe(false)
    for (let index = 0; index < MAX_PINS; index++) expect(pins.pin({ ...answer, itemId: `m${index}` }).ok).toBe(true)
    expect(pins.pin({ ...answer, itemId: 'one-more' })).toMatchObject({ ok: false })
  })

  it('forgets a pin when its window closes, and closes all of them', () => {
    const { pins, windows } = setup()
    pins.pin(answer)
    pins.pin({ ...answer, itemId: 'msg_2' })
    windows[0].close()
    expect(pins.size()).toBe(1)
    pins.closeAll()
    expect(pins.size()).toBe(0)
    expect(windows[1].destroyed).toBe(true)
  })

  it('opens only links of this answer that the conversation had shown', () => {
    const shown = linkKeysIn('http://localhost:5173', 'win32', 'D:\\work\\app')
    const { pins, windows } = setup(shown)
    pins.pin(answer)
    const pin = pins.ofSender(windows[0].webContents)
    expect(pins.linkFor(pin, 'http://localhost:5173')?.kind).toBe('url')
    // In the answer but never shown by the chat view, and not in the answer at all
    expect(pins.linkFor(pin, 'docs/plan/a.md')).toBeNull()
    expect(pins.linkFor(pin, 'https://example.com')).toBeNull()
  })

  it('folds the window to its header and gives the height back', () => {
    const { pins, windows } = setup()
    pins.pin(answer)
    const pin = pins.ofSender(windows[0].webContents)
    pins.fold(pin, true)
    expect(windows[0].size).toEqual([420, FOLDED_HEIGHT])
    expect(windows[0].resizable).toBe(false)
    pins.fold(pin, false)
    expect(windows[0].size).toEqual([420, 520])
    expect(windows[0].size[1]).toBeGreaterThanOrEqual(MIN_HEIGHT)
  })

  it('cleans a header label', () => {
    expect(cleanLabel('a\u2028b\u200b  c')).toBe('a b c')
    expect(cleanLabel(3)).toBe('')
  })
})
