import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { captureProjects, cleanMarks, createQuickCapture, pixelRegion, resolveShots } from './quickCapture.js'
import { captureThemeCss } from './quickCaptureOverlay.js'

const selection = { left: 0.25, top: 0.5, width: 0.5, height: 0.25 }
// What the overlay returns for one capture cut from the screen it shows (the older one-region form is turned into it)
const fromScreen = (extra = {}) => ({ source: -1, region: selection, marks: [], image: null, ...extra })
const normalize = action => action && action.region
  ? (({ region, image, ...rest }) => ({ ...rest, shots: [fromScreen({ region, image: image ?? null })] }))(action)
  : action

function setup(result = { action: 'copy', region: selection, comment: '' }, options = {}) {
  const actions = (Array.isArray(result) ? [...result] : [result && { action: 'copy', ...result }]).map(normalize)
  const png = Buffer.from('cropped png')
  const cropOf = region => ({
    toPNG: () => png, getSize: () => ({ width: region.width, height: region.height }),
    toDataURL: () => `data:image/png;base64,crop-${region.width}x${region.height}`,
    toBitmap: () => Buffer.alloc(region.width * region.height * 4, 1)
  })
  const image = { toDataURL: () => 'data:image/png;base64,image', isEmpty: () => false, getSize: () => ({ width: 1920, height: 1440 }), crop: vi.fn(cropOf) }
  const sources = [{ display_id: '8' }, { display_id: '5', thumbnail: image }]
  const display = { id: 5, scaleFactor: 1.5, bounds: { x: -1280, y: 0, width: 1280, height: 960 }, workArea: { x: -1280, y: 0, width: 1280, height: 920 } }
  const windows = []
  const scripts = []
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      windows.push(this)
      this.options = options
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(), setZoomFactor: vi.fn(),
        executeJavaScript: vi.fn(async code => {
          scripts.push(code)
          if (code.includes('waitChip')) return new Promise(resolve => { this.choose = resolve })
          if (!/pickCaptureRegion|chooseCaptureTarget|captureNotice/.test(code)) return undefined
          const next = actions.shift()
          // 'hold': the overlay is still open and the user has not chosen anything yet
          if (next === 'hold') return new Promise(() => {})
          // 'closed': the page closed itself (Esc); the pending request fails as its frame goes away
          if (next === 'closed') {
            this.emit('close')
            throw new Error('Render frame was disposed before the request completed')
          }
          return next
        })
      })
      this.loadURL = vi.fn(async () => {})
      this.show = vi.fn()
      this.showInactive = vi.fn()
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
  const capture = createQuickCapture({
    desktopCapturer, clipboard, ClipboardItem, BrowserWindow: FakeWindow, getDisplay: () => display, isAvailable, onError,
    delay: async () => {}, ...options
  })
  const overlays = () => windows.filter(win => !win.options.transparent)
  const chips = () => windows.filter(win => win.options.transparent)
  return { capture, desktopCapturer, clipboard, image, png, windows, overlays, chips, scripts, actions, display, isAvailable, onError }
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

  it('waits for the effects to be hidden and releases only the cancelled capture while it waits', async () => {
    let completeHide
    const ready = new Promise(resolve => { completeHide = resolve })
    const resume = vi.fn()
    const nextResume = vi.fn()
    const pausePointerEffects = vi.fn().mockReturnValueOnce({ ready, resume })
      .mockReturnValueOnce({ ready: Promise.resolve(), resume: nextResume })
    const { capture, desktopCapturer, windows } = setup(undefined, { pausePointerEffects })
    const first = capture.start()
    expect(desktopCapturer.getSources).not.toHaveBeenCalled()
    capture.cancelCapture()
    const next = capture.start()
    completeHide()
    expect(await first).toBe(false)
    expect(await next).toBe(true)
    expect(resume).toHaveBeenCalledOnce()
    expect(nextResume).toHaveBeenCalledOnce()
    expect(windows[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(nextResume.mock.invocationCallOrder[0])
    expect(desktopCapturer.getSources).toHaveBeenCalledOnce()
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

  it('does not report an error when the user closed the overlay', async () => {
    const { capture, onError } = setup(['closed'])
    expect(await capture.start()).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(capture.pending()).toBe(0)
  })

  it('closes without an error when the overlay answers that the user closed it', async () => {
    const more = { action: 'more', shots: [fromScreen()], comment: '' }
    const { capture, onError, overlays } = setup([more, { action: 'close' }])
    await capture.start()
    expect(await capture.start()).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(capture.pending()).toBe(0)
    expect(overlays()[1].destroyed).toBe(true)
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
    const parent = path.basename(path.dirname(repo))
    expect(await captureProjects(agents, folders)).toEqual([
      { folder: repo, name: `${parent} / service`, agents: agents.slice(0, 2) },
      { folder: tools, name: `${parent} / tools`, agents: agents.slice(2) }
    ])
  })

  it('names a project with its parent folder, so two backend folders of different projects can be told apart', async () => {
    const shop = path.resolve('shop', 'backend')
    const blog = path.resolve('blog', 'backend')
    const drive = path.parse(process.cwd()).root
    const atRoot = path.join(drive, 'service')
    const agents = [shop, blog, atRoot, drive].map((cwd, index) => ({ id: `claude-${index + 1}`, cwd }))
    expect((await captureProjects(agents, () => [])).map(project => project.name)).toEqual([
      'blog / backend', drive, 'service', 'shop / backend'
    ])
  })

  it('sends the selected region to the chosen agent, retains it across retry, and never writes the clipboard', async () => {
    const agent = { id: 'codex-2', kind: 'codex', shellId: 'local:2', cwd: path.resolve('service'), role: '리뷰어' }
    const request = { action: 'send', agentId: agent.id, region: selection, comment: '이 부분 봐 줘' }
    const attachment = { file: 'capture.png', preview: Buffer.from('preview') }
    const storeAttachment = vi.fn(() => attachment)
    const onSent = vi.fn()
    const sendCapture = vi.fn(async (target, comment, getAttachment, available) => {
      expect(target).toEqual(agent)
      expect(comment).toBe(request.comment)
      expect(getAttachment()).toEqual([attachment])
      expect(available()).toBe(true)
      return sendCapture.mock.calls.length === 1 ? { ok: false, error: '다시 시도' } : { ok: true }
    })
    const { capture, clipboard, image, windows } = setup(
      [{ action: 'targets' }, { ...request, agentId: 'unknown' }, request, request],
      { listAgents: () => [agent], storeAttachment, sendCapture, onSent }
    )
    expect(await capture.start()).toBe(true)
    const projects = [{ folder: agent.cwd, name: `${path.basename(process.cwd())} / service`, agents: [agent] }]
    expect(windows[0].webContents.executeJavaScript).toHaveBeenCalledWith(`window.chooseCaptureTarget(${JSON.stringify(projects)})`)
    expect(windows[0].webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('다시 시도'))
    expect(sendCapture).toHaveBeenCalledTimes(2)
    expect(onSent).toHaveBeenCalledExactlyOnceWith(agent)
    expect(image.crop).toHaveBeenCalledExactlyOnceWith({ x: 480, y: 720, width: 960, height: 360 })
    expect(storeAttachment).toHaveBeenCalledOnce()
    expect(clipboard.write).not.toHaveBeenCalled()
  })
  // docs/plan/2026-11-28-diagnostics.md: the request carries ezShell's state only when the capture shows ezShell
  it.each([
    ['overlaps an ezShell window', [{ x: -700, y: 500, width: 100, height: 100 }], true],
    ['shows only other programs', [{ x: 0, y: 0, width: 800, height: 600 }, { x: -1280, y: 0, width: 200, height: 400 }], false],
    ['has no ezShell window on screen', [], false]
  ])('tells the sender whether the region %s', async (_name, rects, aboutApp) => {
    const agent = { id: 'codex-2', kind: 'codex', shellId: 'local:2', cwd: path.resolve('service') }
    const sendCapture = vi.fn(async () => ({ ok: true }))
    const sendNewCapture = vi.fn(async () => ({ ok: true, agentId: 'codex-3' }))
    const request = { action: 'send', agentId: agent.id, region: selection, comment: '' }
    const { capture } = setup([{ action: 'targets' }, request], {
      listAgents: () => [agent], storeAttachment: () => ({ file: 'a.png' }), sendCapture, appWindowRects: () => rects
    })
    expect(await capture.start()).toBe(true)
    expect(sendCapture.mock.calls[0][4]).toBe(aboutApp)
    const fresh = setup([{ action: 'send-new', kind: 'codex', region: selection, comment: '' }], {
      storeAttachment: () => ({ file: 'a.png' }), sendNewCapture, appWindowRects: () => rects
    })
    expect(await fresh.capture.start()).toBe(true)
    expect(sendNewCapture.mock.calls[0][6]).toBe(aboutApp)
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
      files.push(getAttachment()[0].file)
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

// 2026-11-24 user request: `추가 캡처` takes another capture, and the run is edited, copied or sent together
describe('several captures in one run', () => {
  const arrow = { type: 'arrow', from: { x: 1, y: 1 }, to: { x: 40, y: 30 }, color: '#ff3b30', width: 4 }
  const second = { left: 0, top: 0, width: 0.25, height: 0.25 }
  const more = (extra = {}) => ({ action: 'more', shots: [fromScreen({ marks: [arrow] })], comment: '1. 버튼', ...extra })
  const sized = sizes => ({
    createFromDataURL: value => {
      const size = sizes[value.split(',')[1]] ?? { width: 1, height: 1 }
      return { isEmpty: () => false, getSize: () => size, toPNG: () => Buffer.from(value), toDataURL: () => 'kept:' + value, toBitmap: () => Buffer.alloc(size.width * size.height * 4) }
    },
    createFromBitmap: (buffer, size) => ({ getSize: () => size, toPNG: () => Buffer.from('stacked by main ' + size.width + 'x' + size.height) })
  })
  const stateOf = scripts => JSON.parse(scripts.filter(code => code.startsWith('window.pickCaptureRegion(')).at(-1).slice(25, -1))

  it('keeps a capture with its marks and comment, shows the strip, and brings them back to the next overlay', async () => {
    const { capture, overlays, chips, scripts, image } = setup([more(), 'hold'])
    expect(await capture.start()).toBe(false)
    expect(capture.pending()).toBe(1)
    expect(overlays()[0].destroyed).toBe(true)
    await vi.waitFor(() => expect(chips()[0]?.showInactive).toHaveBeenCalledOnce())
    const chip = chips()[0]
    expect(chip.options).toMatchObject({ x: -1280 + (1280 - 440) / 2, y: 12, frame: false, show: false })
    expect(decodeURIComponent(chip.loadURL.mock.calls[0][0])).toContain('<title>ezShell 캡처 보관</title>')
    expect(scripts).toContain('window.showCaptureCount(1)')
    expect(chip.show).not.toHaveBeenCalled()

    const pending = capture.start()
    await vi.waitFor(() => expect(overlays()).toHaveLength(2))
    expect(chip.destroyed).toBe(true)
    await vi.waitFor(() => expect(stateOf(scripts)).toEqual({
      captures: [{ image: 'data:image/png;base64,crop-960x360', marks: [arrow] }], comment: '1. 버튼', review: false
    }))
    expect(image.crop).toHaveBeenCalledExactlyOnceWith({ x: 480, y: 720, width: 960, height: 360 })
    capture.cancel()
    expect(await pending).toBe(false)
  })

  it('copies several captures stacked into one picture: the overlay picture of the expected size, else main stacks them', async () => {
    const copy = combined => ({ action: 'copy', comment: '두 화면', combined,
      shots: [{ source: 0, marks: [arrow], image: 'data:image/png;base64,first' }, fromScreen({ region: second })] })
    const nativeImage = sized({ first: { width: 960, height: 360 }, combined: { width: 960, height: 32 + 360 + 16 + 32 + 360 } })
    const run = setup([more(), copy('data:image/png;base64,combined')], { nativeImage })
    await run.capture.start()
    expect(await run.capture.start()).toBe(true)
    const [[[item]]] = run.clipboard.write.mock.calls
    expect(Buffer.from(await item.contents['image/png'].arrayBuffer()).toString()).toBe('data:image/png;base64,combined')
    expect(item.contents['text/plain']).toBe('두 화면')
    expect(run.capture.pending()).toBe(0)
    expect(run.chips().every(chip => chip.destroyed)).toBe(true)

    const wrong = setup([more(), copy('data:image/png;base64,wrong')], { nativeImage })
    await wrong.capture.start()
    expect(await wrong.capture.start()).toBe(true)
    const [[[fallback]]] = wrong.clipboard.write.mock.calls
    expect(Buffer.from(await fallback.contents['image/png'].arrayBuffer()).toString()).toBe('stacked by main 960x' + (32 + 360 + 16 + 32 + 360))
  })

  it('tells the user instead of copying one capture when the run is too big to stack', async () => {
    // Neither the overlay's stacked picture (past its canvas limits) nor main's own (past its buffer limit)
    const nativeImage = { ...sized({ first: { width: 960, height: 360 } }), createFromBitmap: () => null }
    const { capture, clipboard, scripts } = setup([more(), { action: 'copy', comment: '', combined: null,
      shots: [{ source: 0, marks: [arrow], image: 'data:image/png;base64,first' }, fromScreen({ region: second })] }, 'hold'], { nativeImage })
    await capture.start()
    const pending = capture.start()
    await vi.waitFor(() => expect(scripts.some(code => code.startsWith('window.captureNotice('))).toBe(true))
    expect(clipboard.write).not.toHaveBeenCalled()
    expect(capture.pending()).toBe(1)
    capture.cancel()
    expect(await pending).toBe(false)
  })

  it('keeps the marks drawn into the picture when they are too many to keep as marks', async () => {
    const nativeImage = sized({ marked: { width: 960, height: 360 } })
    const tooMany = Array.from({ length: 501 }, () => ({ type: 'badge', n: 1 }))
    const { capture, scripts } = setup([more({ shots: [fromScreen({ marks: tooMany, image: 'data:image/png;base64,marked' })] }), 'hold'], { nativeImage })
    await capture.start()
    const pending = capture.start()
    await vi.waitFor(() => expect(stateOf(scripts).captures).toEqual([{ image: 'kept:data:image/png;base64,marked', marks: [] }]))
    capture.cancel()
    expect(await pending).toBe(false)
  })

  it('throws the run away instead of leaving a strip that cannot capture while the app is unavailable', async () => {
    const { capture, chips, isAvailable, overlays } = setup([more()])
    await capture.start()
    await vi.waitFor(() => expect(chips()[0]?.choose).toBeTypeOf('function'))
    isAvailable.mockReturnValue(false)
    chips()[0].choose('capture')
    await vi.waitFor(() => expect(capture.pending()).toBe(0))
    expect(chips()[0].destroyed).toBe(true)
    expect(overlays()).toHaveLength(1)
  })

  it('sends every capture of the run to the chosen agent in one message', async () => {
    const agent = { id: 'codex-2', kind: 'codex', shellId: 'local:2', cwd: path.resolve('service') }
    const storeAttachment = vi.fn(picture => ({ file: 'capture-' + storeAttachment.mock.calls.length + '.png', size: picture.getSize() }))
    const sendCapture = vi.fn(async (target, comment, getAttachments) => {
      expect(getAttachments().map(item => item.size)).toEqual([{ width: 960, height: 360 }, { width: 480, height: 360 }])
      return { ok: true }
    })
    const { capture } = setup([more(), { action: 'targets' },
      { action: 'send', agentId: agent.id, comment: '', shots: [{ source: 0, marks: [] }, fromScreen({ region: second })] }],
    { listAgents: () => [agent], storeAttachment, sendCapture })
    await capture.start()
    expect(await capture.start()).toBe(true)
    expect(storeAttachment).toHaveBeenCalledTimes(2)
    expect(capture.pending()).toBe(0)
  })

  it('captures again, reopens the run or throws it away from the strip', async () => {
    const discard = setup([more()])
    await discard.capture.start()
    await vi.waitFor(() => expect(discard.chips()[0]?.choose).toBeTypeOf('function'))
    discard.chips()[0].choose('discard')
    await vi.waitFor(() => expect(discard.capture.pending()).toBe(0))
    expect(discard.chips()[0].destroyed).toBe(true)

    const reopen = setup([more(), 'hold'])
    await reopen.capture.start()
    await vi.waitFor(() => expect(reopen.chips()[0]?.choose).toBeTypeOf('function'))
    reopen.chips()[0].choose('open')
    await vi.waitFor(() => expect(reopen.overlays()).toHaveLength(2))
    await vi.waitFor(() => expect(stateOf(reopen.scripts).review).toBe(true))
    expect(reopen.desktopCapturer.getSources).toHaveBeenCalledTimes(2)
    reopen.capture.cancel()

    const again = setup([more(), 'hold'])
    await again.capture.start()
    await vi.waitFor(() => expect(again.chips()[0]?.choose).toBeTypeOf('function'))
    again.chips()[0].choose('capture')
    await vi.waitFor(() => expect(stateOf(again.scripts)).toMatchObject({ review: false, captures: [{ marks: [arrow] }] }))
    again.capture.cancel()
  })

  it('drops only the new capture on the helper Esc, but the whole run when the user closes it or the app locks', async () => {
    const run = setup([more(), 'hold', 'hold'])
    await run.capture.start()
    const pending = run.capture.start()
    await vi.waitFor(() => expect(run.overlays()).toHaveLength(2))
    run.capture.cancelCapture()
    expect(await pending).toBe(false)
    expect(run.capture.pending()).toBe(1)
    await vi.waitFor(() => expect(run.chips()[1]?.showInactive).toHaveBeenCalled())

    const closing = run.capture.start()
    await vi.waitFor(() => expect(run.overlays()).toHaveLength(3))
    run.overlays()[2].emit('close')
    run.overlays()[2].destroy()
    expect(await closing).toBe(false)
    expect(run.capture.pending()).toBe(0)

    const locked = setup([more()])
    await locked.capture.start()
    await vi.waitFor(() => expect(locked.chips()[0]?.showInactive).toHaveBeenCalled())
    locked.capture.cancel()
    expect(locked.capture.pending()).toBe(0)
    expect(locked.chips()[0].destroyed).toBe(true)
  })

  it('refuses a list that does not match the captures main holds, and an added capture past the limit', async () => {
    const forged = setup([more(), { action: 'copy', comment: '', shots: [{ source: 0 }, { source: 0 }] }])
    await forged.capture.start()
    expect(await forged.capture.start()).toBe(false)
    expect(forged.clipboard.write).not.toHaveBeenCalled()
    expect(forged.capture.pending()).toBe(0)

    const runOf = held => more({ shots: [...Array.from({ length: held }, (_, index) => ({ source: index })), fromScreen()] })
    const full = setup(Array.from({ length: 8 }, (_, held) => runOf(held)))
    for (let held = 1; held <= 7; held++) {
      await full.capture.start()
      expect(full.capture.pending()).toBe(held)
    }
    // An eighth capture fills the run: the overlay offers no 추가 캡처, and main refuses one
    expect(await full.capture.start()).toBe(false)
    expect(full.capture.pending()).toBe(0)
  })
})

describe('the capture list from the overlay', () => {
  const size = { width: 1920, height: 1440 }

  it('takes each earlier capture at most once and one region from this screen', () => {
    expect(resolveShots([{ source: 1, marks: [{ type: 'badge', n: 1 }], image: 'x' }, { source: -1, region: selection }], 2, size)).toEqual([
      { source: 1, region: null, marks: [{ type: 'badge', n: 1 }], dropped: false, image: 'x' },
      { source: -1, region: { x: 480, y: 720, width: 960, height: 360 }, marks: [], dropped: false, image: null }
    ])
  })

  it.each([
    ['nothing', []], ['not a list', { source: 0 }], ['a repeated capture', [{ source: 0 }, { source: 0 }]],
    ['an unknown capture', [{ source: 2 }]], ['a negative index', [{ source: -2 }]], ['two regions of this screen', [fromScreen(), fromScreen()]],
    ['an empty region', [fromScreen({ region: { left: 0, top: 0, width: 0, height: 1 } })]], ['a fractional index', [{ source: 0.5 }]]
  ])('refuses %s', (_, list) => {
    expect(resolveShots(list, 2, size)).toBeNull()
  })

  it('refuses more than eight captures even when main holds them', () => {
    expect(resolveShots(Array.from({ length: 9 }, (_, index) => ({ source: index })), 9, size)).toBeNull()
    expect(resolveShots(Array.from({ length: 8 }, (_, index) => ({ source: index })), 9, size)).toHaveLength(8)
  })

  it('keeps marks only as a bounded list of known mark types', () => {
    const marks = [{ type: 'text', text: '여기', at: { x: 1, y: 2 } }]
    const kept = cleanMarks(marks)
    expect(kept).toEqual(marks)
    expect(kept).not.toBe(marks)
    expect(cleanMarks([{ type: 'script' }])).toEqual([])
    expect(cleanMarks([null])).toEqual([])
    expect(cleanMarks('arrow')).toEqual([])
    expect(cleanMarks(Array.from({ length: 501 }, () => ({ type: 'badge' })))).toEqual([])
    expect(cleanMarks([{ type: 'pen', points: 'x'.repeat(2 * 1024 * 1024) }])).toEqual([])
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
