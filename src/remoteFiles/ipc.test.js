import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { registerRemoteFileIpc } = require('./ipc.js')
const { createRemoteDocuments, MESSAGES } = require('./documents.js')
const { createFakeSftp } = require('../mcp/fakeSftp.testhelper.js')

function fakeWindow(id) {
  const win = new EventEmitter()
  const sent = []
  let destroyed = false
  Object.assign(win, {
    webContents: { id, send: (channel) => sent.push(channel) },
    sent,
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore: () => {},
    focus: () => { win.focused = true },
    isFocused: () => Boolean(win.focused),
    flashFrame: (flag) => { win.flashing = flag },
    close: () => {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      win.emit('close', event)
      if (!event.defaultPrevented) { destroyed = true; win.emit('closed') }
    }
  })
  return win
}

function setup({ isLocked } = {}) {
  const handlers = new Map()
  const listeners = new Map()
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on: (channel, fn) => listeners.set(channel, fn) }
  const sftp = createFakeSftp({ '/etc': { type: 'dir' }, '/etc/a.conf': { type: 'file', data: 'a\n' }, '/etc/b.log': { type: 'file', data: 'b\n' } })
  const docs = createRemoteDocuments({ openSftp: async () => sftp, serverOf: () => null, backups: { root: 'unused', store: {} } })
  const windows = []
  let nextId = 100
  const { closeViewWindows } = registerRemoteFileIpc({ ipcMain, docs, isLocked, createWindow: () => { const win = fakeWindow(nextId++); windows.push(win); return win }, openFolder: async () => {} })
  const invoke = (channel, senderId, request) => handlers.get(channel)({ sender: { id: senderId } }, request)
  const send = (channel, senderId, request) => listeners.get(channel)({ sender: { id: senderId } }, request)
  return { invoke, send, windows, docs, closeViewWindows }
}

const openRequest = { sessionId: 'tab-1', sessionName: 'dev', remotePath: '/etc/a.conf', mode: 'edit' }

describe('file window IPC', () => {
  it('follows a log only while the app is unlocked', async () => {
    let locked = false
    const { invoke, windows, docs } = setup({ isLocked: () => locked })
    const request = { ...openRequest, remotePath: '/etc/b.log', mode: 'tail' }
    await invoke('remote-file-open', 1, request)
    const { docId } = docs.register(request)
    const owner = windows[0].webContents.id
    const { follow } = await invoke('remote-file-load', owner, { docId })
    expect(await invoke('remote-file-tail', owner, { docId, ...follow })).toMatchObject({ success: true, status: 'same' })
    locked = true
    expect(await invoke('remote-file-tail', owner, { docId, ...follow })).toMatchObject({ success: false })
    expect(await invoke('remote-file-load', owner, { docId })).toMatchObject({ success: false })
    expect(await invoke('remote-file-open', 1, { ...request, remotePath: '/etc/a.conf' })).toMatchObject({ success: false })
  })

  it('closes the windows that only look at a file when the app locks, and keeps edit windows', async () => {
    const { invoke, windows, closeViewWindows } = setup()
    await invoke('remote-file-open', 1, openRequest)
    await invoke('remote-file-open', 1, { ...openRequest, remotePath: '/etc/b.log', mode: 'tail' })
    await invoke('remote-file-open', 1, { ...openRequest, mode: 'preview' })
    closeViewWindows()
    expect(windows.map(win => win.isDestroyed())).toEqual([false, true, true])
  })

  it('flashes a background window for a new error, and stops when it gets focus', async () => {
    const { invoke, send, windows, docs } = setup()
    const request = { ...openRequest, remotePath: '/etc/b.log', mode: 'tail' }
    await invoke('remote-file-open', 1, request)
    const { docId } = docs.register(request)
    const win = windows[0]
    send('remote-file-attention', 999, { docId })
    expect(win.flashing).toBeUndefined()
    send('remote-file-attention', win.webContents.id, { docId })
    expect(win.flashing).toBe(true)
    win.emit('focus')
    expect(win.flashing).toBe(false)
  })

  it('opens one window per file and answers only that window', async () => {
    const { invoke, windows } = setup()
    expect(await invoke('remote-file-open', 1, openRequest)).toEqual({ success: true, existing: false })
    expect(await invoke('remote-file-open', 1, openRequest)).toEqual({ success: true, existing: true })
    expect(windows).toHaveLength(1)
    expect(windows[0].focused).toBe(true)
  })

  it('refuses another window asking for the document', async () => {
    const { invoke, windows, docs } = setup()
    await invoke('remote-file-open', 1, openRequest)
    const { docId } = docs.register(openRequest)
    expect(await invoke('remote-file-load', 1, { docId })).toEqual({ success: false, error: MESSAGES.gone })
    const own = await invoke('remote-file-load', windows[0].webContents.id, { docId })
    expect(own).toMatchObject({ success: true, content: 'a\n' })
  })

  it('holds a window with unsaved changes until the user chooses to close it', async () => {
    const { invoke, send, windows, docs } = setup()
    await invoke('remote-file-open', 1, openRequest)
    const { docId } = docs.register(openRequest)
    const win = windows[0]
    send('remote-file-dirty', 999, { docId, isDirty: true })
    win.close()
    expect(win.isDestroyed()).toBe(true)

    await invoke('remote-file-open', 1, openRequest)
    const second = windows[1]
    const { docId: secondId } = docs.register(openRequest)
    send('remote-file-dirty', second.webContents.id, { docId: secondId, isDirty: true })
    second.close()
    expect(second.isDestroyed()).toBe(false)
    expect(second.sent).toEqual(['remote-file-close-requested'])
    await invoke('remote-file-close', 1, { docId: secondId })
    expect(second.isDestroyed()).toBe(false)
    await invoke('remote-file-close', second.webContents.id, { docId: secondId })
    expect(second.isDestroyed()).toBe(true)
    expect(docs.find(secondId)).toBeNull()
  })

  it('rejects requests that are not a server path or mode', async () => {
    const { invoke } = setup()
    expect((await invoke('remote-file-open', 1, { ...openRequest, remotePath: 'relative' })).success).toBe(false)
    expect((await invoke('remote-file-open', 1, { ...openRequest, mode: 'write' })).success).toBe(false)
  })
})
