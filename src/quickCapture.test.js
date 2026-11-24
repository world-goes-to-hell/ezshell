import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { captureProjects, createQuickCapture, pixelRegion } from './quickCapture.js'
import { captureThemeCss } from './quickCaptureOverlay.js'

const selection = { left: 0.25, top: 0.5, width: 0.5, height: 0.25 }

function setup(result = { action: 'copy', region: selection, comment: '' }, options = {}) {
  const actions = Array.isArray(result) ? [...result] : [result && { action: 'copy', ...result }]
  const png = Buffer.from('cropped png')
  const cropped = { toPNG: () => png }
  const image = { toDataURL: () => 'data:image/png;base64,image', isEmpty: () => false, getSize: () => ({ width: 1920, height: 1440 }), crop: vi.fn(() => cropped) }
  const sources = [{ display_id: '8' }, { display_id: '5', thumbnail: image }]
  const display = { id: 5, scaleFactor: 1.5, bounds: { x: -1280, y: 0, width: 1280, height: 960 } }
  const windows = []
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      windows.push(this)
      this.options = options
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(), setZoomFactor: vi.fn(),
        executeJavaScript: vi.fn(async code => /pickCaptureRegion|chooseCaptureTarget/.test(code) ? actions.shift() : undefined)
      })
      this.loadURL = vi.fn(async () => {})
      this.show = vi.fn()
      this.hide = vi.fn()
      this.moveTop = vi.fn()
      this.focus = vi.fn()
      this.setAlwaysOnTop = vi.fn()
      this.setFullScreen = vi.fn()
      this.isDestroyed = () => this.destroyed === true
      this.destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
    }
  }
  class ClipboardItem {
    constructor(contents) { this.contents = contents }
  }
  const clipboard = { write: vi.fn(async () => {}) }
  const desktopCapturer = { getSources: vi.fn(async () => sources) }
  const isAvailable = vi.fn(() => true)
  const onError = vi.fn()
  const capture = createQuickCapture({ desktopCapturer, clipboard, ClipboardItem, BrowserWindow: FakeWindow, getDisplay: () => display, isAvailable, onError, ...options })
  return { capture, desktopCapturer, clipboard, image, png, windows, display, isAvailable, onError }
}

describe('the quick screen capture', () => {
  it('applies the validated palette before showing each newly opened overlay', async () => {
    const copy = { action: 'copy', region: selection, comment: '' }
    const { capture, windows } = setup([copy, copy])
    capture.setTheme({ surface: '#f8fbff', scheme: 'light', text: 'invalid' })
    expect(await capture.start()).toBe(true)
    expect(decodeURIComponent(windows[0].loadURL.mock.calls[0][0])).toContain(':root{--capture-surface:#f8fbff;--capture-scheme:light;}')
    expect(windows[0].loadURL.mock.invocationCallOrder[0]).toBeLessThan(windows[0].show.mock.invocationCallOrder[0])

    capture.setTheme({ surface: '#17181b', scheme: 'dark' })
    expect(await capture.start()).toBe(true)
    expect(decodeURIComponent(windows[1].loadURL.mock.calls[0][0])).toContain(':root{--capture-surface:#17181b;--capture-scheme:dark;}')
  })
  it('clamps the selection to the image and rejects empty or invalid rectangles', () => {
    const size = { width: 100, height: 50 }
    expect(pixelRegion({ left: -0.05, top: 0.5, width: 0.15, height: 0.6 }, size)).toEqual({ x: 0, y: 25, width: 10, height: 25 })
    expect(pixelRegion({ left: 0.2, top: 0.5, width: 0, height: 0.2 }, size)).toBeNull()
    expect(pixelRegion({ left: Infinity, top: 0.5, width: 0.2, height: 0.2 }, size)).toBeNull()
  })

  it('crops only the chosen part of a high-DPI monitor and copies it with the entered comment', async () => {
    const comment = '이 부분을 확인해 주세요.\n두 번째 줄'
    const focusWindow = vi.fn()
    const { capture, desktopCapturer, clipboard, image, png, windows, display } = setup({ region: selection, comment }, { focusWindow })
    expect(await capture.start()).toBe(true)
    expect(desktopCapturer.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 1920, height: 1440 } })
    expect(windows[0].options).toMatchObject({ ...display.bounds, frame: false, show: false })
    expect(windows[0].loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html/))
    expect(windows[0].show).toHaveBeenCalledTimes(1)
    expect(focusWindow).toHaveBeenCalledExactlyOnceWith(windows[0])
    expect(windows[0].setFullScreen).toHaveBeenCalledWith(true)
    expect(image.crop).toHaveBeenCalledWith({ x: 480, y: 720, width: 960, height: 360 })
    expect(clipboard.write).toHaveBeenCalledOnce()
    const [items] = clipboard.write.mock.calls[0]
    expect(items).toHaveLength(1)
    expect(items[0].contents['text/plain']).toBe(comment)
    expect(Buffer.from(await items[0].contents['image/png'].arrayBuffer())).toEqual(png)
    expect(windows[0].destroy).toHaveBeenCalledTimes(1)
  })

  it.each(['', ' \n '])('copies only the image for a blank comment (%j)', async comment => {
    const { capture, clipboard } = setup({ region: selection, comment })
    expect(await capture.start()).toBe(true)
    expect(Object.keys(clipboard.write.mock.calls[0][0][0].contents)).toEqual(['image/png'])
  })

  it('preserves the clipboard when the user cancels', async () => {
    const { capture, clipboard, windows } = setup(null)
    expect(await capture.start()).toBe(false)
    expect(clipboard.write).not.toHaveBeenCalled()
    expect(windows[0].destroy).toHaveBeenCalled()
  })

  it('cancels before the display thumbnail arrives so the overlay cannot appear later', async () => {
    const { capture, desktopCapturer, clipboard, windows, onError } = setup()
    let resolveSources
    desktopCapturer.getSources.mockImplementationOnce(() => new Promise(resolve => { resolveSources = resolve }))
    const pending = capture.start()
    capture.cancel()
    expect(await pending).toBe(false)
    resolveSources([])
    expect(windows).toHaveLength(0)
    expect(clipboard.write).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(await capture.start()).toBe(true)
  })

  it('never captures while locked or opens multiple overlays', async () => {
    const { capture, desktopCapturer, clipboard, windows, isAvailable } = setup()
    isAvailable.mockReturnValue(false)
    expect(await capture.start()).toBe(false)
    expect(desktopCapturer.getSources).not.toHaveBeenCalled()
    isAvailable.mockReturnValue(true)
    const pending = capture.start()
    expect(await capture.start()).toBe(false)
    capture.cancel()
    expect(await pending).toBe(false)
    expect(windows).toHaveLength(0)
    expect(clipboard.write).not.toHaveBeenCalled()
  })

  it('refuses to capture an unrelated monitor when the chosen display disappears', async () => {
    const { capture, desktopCapturer, clipboard, onError } = setup()
    desktopCapturer.getSources.mockResolvedValue([{ display_id: '8' }])
    expect(await capture.start()).toBe(false)
    expect(clipboard.write).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('waits for the clipboard and reports a rejected write', async () => {
    const { capture, clipboard, onError } = setup()
    const error = new Error('clipboard unavailable')
    clipboard.write.mockRejectedValueOnce(error)
    expect(await capture.start()).toBe(false)
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('lists linked worktrees under the same project and includes folders outside Git', async () => {
    const repo = path.resolve('service')
    const linked = path.resolve('service-fix')
    const tools = path.resolve('tools')
    const agents = [repo, linked, tools].map((cwd, index) => ({ id: `codex-${index + 1}`, cwd }))
    const folders = cwd => cwd === tools ? [] : [cwd, repo, linked]
    expect(await captureProjects(agents, folders)).toEqual([
      { folder: repo, name: 'service', agents: agents.slice(0, 2) },
      { folder: tools, name: 'tools', agents: agents.slice(2) }
    ])
  })

  it('sends the selected region to the chosen agent, retains it across retry, and never writes the clipboard', async () => {
    const agent = { id: 'codex-2', kind: 'codex', shellId: 'local:2', cwd: path.resolve('service') }
    const request = { action: 'send', agentId: agent.id, region: selection, comment: '이 부분 봐 줘' }
    const attachment = { file: 'capture.png', preview: Buffer.from('preview') }
    const storeAttachment = vi.fn(() => attachment)
    const onSent = vi.fn()
    const sendCapture = vi.fn(async (target, comment, getAttachment, available) => {
      expect(target).toEqual(agent)
      expect(comment).toBe(request.comment)
      expect(getAttachment()).toBe(attachment)
      expect(available()).toBe(true)
      return sendCapture.mock.calls.length === 1 ? { ok: false, error: '다시 시도' } : { ok: true }
    })
    const { capture, clipboard, image, windows } = setup(
      [{ action: 'targets' }, { ...request, agentId: 'unknown' }, request, request],
      { listAgents: () => [agent], storeAttachment, sendCapture, onSent }
    )
    expect(await capture.start()).toBe(true)
    expect(windows[0].webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('다시 시도'))
    expect(sendCapture).toHaveBeenCalledTimes(2)
    expect(onSent).toHaveBeenCalledExactlyOnceWith(agent)
    expect(image.crop).toHaveBeenCalledExactlyOnceWith({ x: 480, y: 720, width: 960, height: 360 })
    expect(storeAttachment).toHaveBeenCalledOnce()
    expect(clipboard.write).not.toHaveBeenCalled()
  })
  it('copies and sends the region with the marks drawn on it, and only a mark image of the chosen size', async () => {
    const marked = { toPNG: () => Buffer.from('marked png') }
    const nativeImage = {
      createFromDataURL: value => ({ ...marked, isEmpty: () => false, getSize: () => (value.endsWith('wrong') ? { width: 10, height: 10 } : { width: 960, height: 360 }) })
    }
    const copy = setup({ region: selection, comment: '', image: 'data:image/png;base64,marks' }, { nativeImage })
    expect(await copy.capture.start()).toBe(true)
    expect(Buffer.from(await copy.clipboard.write.mock.calls[0][0][0].contents['image/png'].arrayBuffer()).toString()).toBe('marked png')
    expect(copy.image.crop).not.toHaveBeenCalled()

    const wrong = setup({ region: selection, comment: '', image: 'data:image/png;base64,wrong' }, { nativeImage })
    expect(await wrong.capture.start()).toBe(true)
    expect(Buffer.from(await wrong.clipboard.write.mock.calls[0][0][0].contents['image/png'].arrayBuffer())).toEqual(wrong.png)
  })

  it('stores the image again for a retry only when the marks changed', async () => {
    const agent = { id: 'codex-2', kind: 'codex', shellId: 'local:2', cwd: path.resolve('service') }
    const nativeImage = { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 960, height: 360 }) }) }
    const request = image => ({ action: 'send', agentId: agent.id, region: selection, comment: '', image })
    const storeAttachment = vi.fn(() => ({ file: 'capture-' + storeAttachment.mock.calls.length + '.png' }))
    const files = []
    const sendCapture = vi.fn(async (target, comment, getAttachment) => {
      files.push(getAttachment().file)
      return sendCapture.mock.calls.length < 3 ? { ok: false, error: '다시' } : { ok: true }
    })
    const { capture } = setup(
      [{ action: 'targets' }, request('data:image/png;base64,a'), request('data:image/png;base64,a'), request('data:image/png;base64,b')],
      { listAgents: () => [agent], storeAttachment, sendCapture, nativeImage }
    )
    expect(await capture.start()).toBe(true)
    expect(files).toEqual(['capture-1.png', 'capture-1.png', 'capture-2.png'])
  })

  it('ends a closed capture while its send is still settling and can start a new capture', async () => {
    const agent = { id: 'codex-1', kind: 'codex', shellId: 'local:1', cwd: path.resolve('service') }
    const sendCapture = vi.fn(async () => new Promise(() => {}))
    const onSent = vi.fn()
    const { capture, clipboard, windows } = setup([
      { action: 'targets' },
      { action: 'send', agentId: agent.id, region: selection, comment: '' },
      { action: 'copy', region: selection, comment: '' }
    ], { listAgents: () => [agent], sendCapture, onSent })
    const pending = capture.start()
    await vi.waitFor(() => expect(sendCapture).toHaveBeenCalledOnce())
    const stillOpen = sendCapture.mock.calls[0][3]
    windows[0].emit('close')
    windows[0].destroy()

    expect(windows[0].hide).toHaveBeenCalledOnce()
    expect(await pending).toBe(false)
    expect(stillOpen()).toBe(false)
    expect(onSent).not.toHaveBeenCalled()
    expect(clipboard.write).not.toHaveBeenCalled()
    expect(await capture.start()).toBe(true)
  })
})

describe('capture theme CSS', () => {
  it('emits only recognized variables with valid colors, sizes, and fonts', () => {
    expect(captureThemeCss({
      background: '#123', surface: '#1c1d21', border: '#112233ff', text: 'rgb(125, 136, 147)',
      muted: 'rgba(12, 34, 56, .5)', accent: 'rgb(100% 50% 0% / 75%)',
      radius: '0', panelRadius: '12px', font: "'Segoe UI', sans-serif", scheme: 'light', unknown: 'rejected'
    })).toBe(":root{--capture-background:#123;--capture-surface:#1c1d21;--capture-border:#112233ff;" +
      '--capture-text:rgb(125, 136, 147);--capture-muted:rgba(12, 34, 56, .5);--capture-accent:rgb(100% 50% 0% / 75%);' +
      "--capture-radius:0;--capture-panel-radius:12px;--capture-font:'Segoe UI', sans-serif;--capture-scheme:light;}")
  })

  it.each([
    null, [], 'blue', 'var(--other)', '#12', '#1234', 'rgb(256, 10, 0)', 'rgb(10%, 20, 0)',
    'rgba(0, 1, 2, 1.1)', 'rgb(1 2 3 / 101%)', 'rgb(1 2 3 /)', '#fff; x:y', '<invalid>', ' '.repeat(65) + '#fff',
    'rgb(1\u00a0,2,3)', 'rgb(1\u20282 3)', 'rgb(1 2 3 /\u300050%)', '\u00a0#fff', 'rgb(1\t2 3)'
  ])('drops invalid color values and keeps valid fields (%j)', value => {
    expect(captureThemeCss({ surface: value, text: '#fff' })).toBe(':root{--capture-text:#fff;}')
  })

  it('keeps the page defaults when no token passes validation', () => {
    expect(captureThemeCss(undefined)).toBe('')
    expect(captureThemeCss({ radius: '999px', panelRadius: '1em', font: 'serif; x:y', scheme: 'invalid' })).toBe('')
  })

  it('accepts ASCII spaces and drops non-printable characters in other theme tokens', () => {
    expect(captureThemeCss({ surface: ' rgb(1  2 3 / 50%) ', radius: '8px\n', font: "'Segoe UI',\u00a0sans-serif" }))
      .toBe(':root{--capture-surface:rgb(1  2 3 / 50%);}')
  })
})
