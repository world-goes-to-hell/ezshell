const { OVERLAY_URL } = require('./quickCaptureOverlay.js')

/** Convert the overlay's normalized rectangle to image pixels, independent of monitor DPI. */
function pixelRegion(region, imageSize) {
  if (!region) return null
  const { left, top, width, height } = region
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const clamp = (value, limit) => Math.max(0, Math.min(value, limit))
  const x = clamp(Math.floor(left * imageSize.width), imageSize.width)
  const y = clamp(Math.floor(top * imageSize.height), imageSize.height)
  const right = clamp(Math.ceil((left + width) * imageSize.width), imageSize.width)
  const bottom = clamp(Math.ceil((top + height) * imageSize.height), imageSize.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

function createQuickCapture({ desktopCapturer, clipboard, ClipboardItem, BrowserWindow, getDisplay, isAvailable, onError = () => {} }) {
  let active = null

  function cancel() {
    const task = active
    active = null
    if (task?.window && !task.window.isDestroyed()) task.window.destroy()
  }

  async function start() {
    if (active || !isAvailable()) return false
    const task = { window: null }
    active = task
    let timer
    try {
      const display = getDisplay()
      const { bounds, scaleFactor } = display
      const sources = await Promise.race([
        desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.round(bounds.width * scaleFactor), height: Math.round(bounds.height * scaleFactor) }
        }),
        new Promise(resolve => { timer = setTimeout(resolve, 4000, []); timer.unref?.() })
      ])
      if (active !== task || !isAvailable()) return false
      const image = sources.find(source => source.display_id === String(display.id))?.thumbnail
      if (!image || image.isEmpty()) throw new Error('해당 모니터의 화면을 읽지 못했습니다.')

      const win = new BrowserWindow({
        ...bounds, show: false, frame: false, movable: false, skipTaskbar: true,
        hasShadow: false, backgroundColor: '#131820',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
      })
      task.window = win
      const closed = new Promise(resolve => win.once('closed', () => resolve(null)))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', event => event.preventDefault())
      win.webContents.once('render-process-gone', () => { if (!win.isDestroyed()) win.destroy() })
      win.setAlwaysOnTop(true, 'screen-saver')
      await win.loadURL(OVERLAY_URL)
      win.webContents.setZoomFactor(1)
      await win.webContents.executeJavaScript(`window.setCaptureImage(${JSON.stringify(image.toDataURL())})`)
      if (active !== task || win.isDestroyed() || !isAvailable()) return false
      const confirming = win.webContents.executeJavaScript('window.pickCaptureRegion()')
      // A normal Windows window stops at the taskbar; the selection must cover the whole display.
      win.setFullScreen(true)
      win.show()
      win.moveTop()
      win.focus()
      const capture = await Promise.race([confirming, closed])
      const region = pixelRegion(capture?.region, image.getSize())
      if (active !== task || !region || !isAvailable()) return false
      const contents = { 'image/png': new Blob([image.crop(region).toPNG()], { type: 'image/png' }) }
      if (typeof capture.comment === 'string' && capture.comment.trim()) contents['text/plain'] = capture.comment
      await clipboard.write([new ClipboardItem(contents)])
      return true
    } catch (error) {
      if (active === task && !task.window?.isDestroyed()) onError(error)
      return false
    } finally {
      clearTimeout(timer)
      if (active === task) cancel()
    }
  }

  return { start, cancel }
}

module.exports = { createQuickCapture, pixelRegion }
