import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createQuickCapture, pixelRegion } from './quickCapture.js'

const selection = { left: 0.25, top: 0.5, width: 0.5, height: 0.25 }

function setup(result = { region: selection, comment: '' }) {
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
        executeJavaScript: vi.fn(async code => code === 'window.pickCaptureRegion()' ? result : undefined)
      })
      this.loadURL = vi.fn(async () => {})
      this.show = vi.fn()
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
  const capture = createQuickCapture({ desktopCapturer, clipboard, ClipboardItem, BrowserWindow: FakeWindow, getDisplay: () => display, isAvailable, onError })
  return { capture, desktopCapturer, clipboard, image, png, windows, display, isAvailable, onError }
}

describe('the quick screen capture', () => {
  it('clamps the selection to the image and rejects empty or invalid rectangles', () => {
    const size = { width: 100, height: 50 }
    expect(pixelRegion({ left: -0.05, top: 0.5, width: 0.15, height: 0.6 }, size)).toEqual({ x: 0, y: 25, width: 10, height: 25 })
    expect(pixelRegion({ left: 0.2, top: 0.5, width: 0, height: 0.2 }, size)).toBeNull()
    expect(pixelRegion({ left: Infinity, top: 0.5, width: 0.2, height: 0.2 }, size)).toBeNull()
  })

  it('crops only the chosen part of a high-DPI monitor and copies it with the entered comment', async () => {
    const comment = '이 부분을 확인해 주세요.\n두 번째 줄'
    const { capture, desktopCapturer, clipboard, image, png, windows, display } = setup({ region: selection, comment })
    expect(await capture.start()).toBe(true)
    expect(desktopCapturer.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 1920, height: 1440 } })
    expect(windows[0].options).toMatchObject({ ...display.bounds, frame: false, show: false })
    expect(windows[0].loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html/))
    expect(windows[0].show).toHaveBeenCalledTimes(1)
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
})
