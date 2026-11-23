import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPreviewLocalPath, readLinkPreview, TEXT_HEAD_BYTES, TEXT_MAX_BYTES, MEDIA_MAX_BYTES, DIRECTORY_LIMIT } from './localPreview.js'
import { registerAgentChatIpc } from './ipc.js'

let root
const file = name => path.join(root, name)
const target = (name, line) => ({ path: file(name), line })
const put = (name, data) => fs.writeFileSync(file(name), data)

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-chat-preview-'))) })
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('previewing an approved local link', () => {
  it('rejects network, device, stream and drive-relative forms', () => {
    for (const unsafe of [
      '\\\\host\\share\\text.md', '\\\\?\\UNC\\host\\share', '\\\\.\\pipe\\preview', '\\\\?\\C:\\text.md',
      'C:\\dir\\LPT¹.txt', 'C:\\dir\\NUL .txt', 'C:\\dir\\CONIN$', 'C:\\dir\\note.md:stream', 'C:note.md'
    ]) expect(isPreviewLocalPath(unsafe, 'win32')).toBe(false)
    expect(isPreviewLocalPath('C:\\dir\\notes.md', 'win32')).toBe(true)
    expect(isPreviewLocalPath('//server/share/a', 'linux')).toBe(false)
    expect(isPreviewLocalPath('/work/example.md', 'linux')).toBe(true)
  })

  it('reads UTF-8 metadata and preserves the requested source line', async () => {
    put('notes.md', '\uFEFF# 계획\n검토 항목\n')
    const result = await readLinkPreview(target('notes.md', 2))
    expect(result).toEqual({
      kind: 'text', path: file('notes.md'), name: 'notes.md', linked: false, line: 2, text: '# 계획\n검토 항목\n',
      size: fs.statSync(file('notes.md')).size, modifiedAt: fs.statSync(file('notes.md')).mtimeMs, truncated: false
    })
  })

  it('keeps complete UTF-8 at the head limit and leaves large text and media unopened', async () => {
    put('medium.txt', 'a'.repeat(TEXT_HEAD_BYTES - 1) + '한\n뒤')
    const head = await readLinkPreview(target('medium.txt'))
    expect(head).toMatchObject({ kind: 'text', truncated: true })
    expect(head.text).toBe('a'.repeat(TEXT_HEAD_BYTES - 1))
    put('large.txt', '')
    fs.truncateSync(file('large.txt'), TEXT_MAX_BYTES + 1)
    put('large.png', '')
    fs.truncateSync(file('large.png'), MEDIA_MAX_BYTES + 1)
    const open = vi.spyOn(fs.promises, 'open')
    for (const name of ['large.txt', 'large.png']) {
      expect(await readLinkPreview(target(name))).toMatchObject({ kind: 'unavailable', reason: 'too-large' })
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('recognizes image and PDF bytes and uses the unsupported view for binary or a disguised document', async () => {
    put('image.png', Buffer.from('89504e470d0a1a0a', 'hex'))
    put('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    put('paper.pdf', '%PDF-1.4\n')
    put('wrong.pdf', '<html>not a PDF</html>')
    put('binary.bin', Buffer.from([0x01, 0xd9, 0x00]))
    expect(await readLinkPreview(target('image.png'))).toMatchObject({ kind: 'image', mime: 'image/png' })
    expect(await readLinkPreview(target('drawing.svg'))).toMatchObject({ kind: 'image', mime: 'image/svg+xml' })
    expect(await readLinkPreview(target('paper.pdf'))).toMatchObject({ kind: 'pdf', mime: 'application/pdf' })
    for (const name of ['wrong.pdf', 'binary.bin']) {
      expect(await readLinkPreview(target(name))).toMatchObject({ kind: 'unavailable', reason: 'unsupported' })
    }
  })

  it('reads through local directory links and returns the requested path with a link indicator', async () => {
    fs.mkdirSync(file('files'))
    for (let i = 0; i <= DIRECTORY_LIMIT; i++) put(path.join('files', 'entry-' + i), '')
    fs.symlinkSync(file('files'), file('alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await readLinkPreview(target('alias'))
    expect(result).toMatchObject({ kind: 'directory', path: file('alias'), name: 'alias', linked: true, size: null, truncated: true })
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(file('files')).slice(1, -1))
    expect(result.entries).toHaveLength(DIRECTORY_LIMIT)
    expect(result.entries.every(child => child.kind === 'file')).toBe(true)
    expect(await readLinkPreview(target(path.join('alias', 'entry-0')))).toMatchObject({
      kind: 'text', path: file(path.join('alias', 'entry-0')), name: 'entry-0', linked: true
    })
  })

  it('checks a parent link without statting the reported network destination', async () => {
    fs.mkdirSync(file('files'))
    fs.symlinkSync(file('files'), file('alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const readlink = vi.spyOn(fs.promises, 'readlink').mockResolvedValue('\\\\example.invalid\\share')
    const stat = vi.spyOn(fs.promises, 'lstat')
    await expect(readLinkPreview(target(path.join('alias', 'notes.md')))).rejects.toThrow('Non-local link')
    expect(readlink).toHaveBeenCalledWith(file('alias'))
    expect(stat.mock.calls.every(([value]) => !value.includes('example.invalid'))).toBe(true)
  })
})

describe('chat preview permission', () => {
  function setup() {
    put('approved.txt', 'approved text')
    put('other.txt', 'other text')
    const handlers = new Map()
    const main = { mainFrame: {} }
    const preview = { mayRead: true, locked: false }
    const key = process.platform === 'win32' ? file('approved.txt').toLowerCase() : file('approved.txt')
    registerAgentChatIpc({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
      fromMainWindow: event => event.sender === main, isLocked: () => preview.locked,
      chats: {
        cwdOf: () => root,
        knowsLink: (shellId, value) => shellId === 'local:1' && value === key,
        linkAuthority: () => () => preview.mayRead
      },
      shells: () => null
    })
    const call = (link, event = { sender: main, senderFrame: main.mainFrame }) =>
      handlers.get('agent-chat-preview-link')(event, { shellId: 'local:1', link })
    return { call, main, preview }
  }

  it('resolves a known relative key only for the unlocked main frame', async () => {
    const { call, main, preview } = setup()
    expect(await call('approved.txt:2')).toMatchObject({ ok: true, preview: { text: 'approved text', line: 2 } })
    expect(await call('other.txt')).toMatchObject({ ok: false })
    expect(await call('https://example.com/approved.txt')).toMatchObject({ ok: false })
    expect(await call('approved.txt', { sender: {}, senderFrame: main.mainFrame })).toMatchObject({ ok: false })
    expect(await call('approved.txt', { sender: main, senderFrame: {} })).toMatchObject({ ok: false })
    preview.locked = true
    expect(await call('approved.txt')).toMatchObject({ ok: false })
  })

  it('drops a pending result after lock, scope invalidation, or a newer link request', async () => {
    const { call, preview } = setup()
    const locked = call('approved.txt')
    preview.locked = true
    expect(await locked).toMatchObject({ ok: false })
    preview.locked = false
    const stale = call('approved.txt:2')
    preview.mayRead = false
    expect(await stale).toMatchObject({ ok: false })
    preview.mayRead = true
    const previous = call('approved.txt:1')
    const latest = call('approved.txt:2')
    expect(await previous).toMatchObject({ ok: false })
    expect(await latest).toMatchObject({ ok: true, preview: { line: 2 } })
  })
})
