const path = require('node:path')
const { OVERLAY_URL } = require('./quickCaptureOverlay.js')
// The overlay computes the same rectangle to draw its marks in (quickCaptureEditor.js)
const { pixelRegion, markedImage } = require('./quickCaptureEditor.js')

async function captureProjects(agents, repoFolders) {
  const folders = new Map()
  const projects = new Map()
  const keyOf = folder => path.normalize(folder).toLowerCase()
  const locations = await Promise.all(agents.map(async agent => {
    const key = keyOf(agent.cwd)
    if (!folders.has(key)) folders.set(key, repoFolders(agent.cwd))
    // Git lists the main checkout first, even when the agent is in a linked worktree.
    const [top, main] = await folders.get(key)
    return main ?? top ?? agent.cwd
  }))
  agents.forEach((agent, index) => {
    const folder = locations[index]
    const key = keyOf(folder)
    if (!projects.has(key)) projects.set(key, { folder, name: path.basename(folder) || folder, agents: [] })
    projects.get(key).agents.push(agent)
  })
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.folder.localeCompare(b.folder, 'ko'))
}

function createQuickCapture({
  desktopCapturer, clipboard, ClipboardItem, BrowserWindow, getDisplay, isAvailable, nativeImage = null,
  listAgents = () => [], repoFolders = async () => [], storeAttachment, sendCapture, onSent = () => {}, onError = () => {}
}) {
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
      const available = () => active === task && !win.isDestroyed() && isAvailable()
      const action = code => Promise.race([win.webContents.executeJavaScript(code), closed])
      let next = action('window.pickCaptureRegion()')
      // A normal Windows window stops at the taskbar; the selection must cover the whole display.
      win.setFullScreen(true)
      win.show()
      win.moveTop()
      win.focus()
      let projects = []
      let targets = new Map()
      // The stored file of the image last sent: a retry reuses it unless the marks changed meanwhile
      let stored = null
      while (available()) {
        const capture = await next
        if (!capture || !available()) return false
        if (capture.action === 'targets') {
          projects = await captureProjects(listAgents(), repoFolders)
          if (!available()) return false
          targets = new Map(projects.flatMap(project => project.agents.map(agent => [agent.id, agent])))
          next = action(`window.chooseCaptureTarget(${JSON.stringify(projects)})`)
          continue
        }
        const region = pixelRegion(capture.region, image.getSize())
        if (!region || typeof capture.comment !== 'string') return false
        // The region with the user's marks when the overlay drew any (checked), else the plain crop
        const picture = () => markedImage(capture.image, region, nativeImage) ?? image.crop(region)
        if (capture.action === 'copy') {
          const contents = { 'image/png': new Blob([picture().toPNG()], { type: 'image/png' }) }
          if (capture.comment.trim()) contents['text/plain'] = capture.comment
          await clipboard.write([new ClipboardItem(contents)])
          return true
        }
        if (capture.action !== 'send') return false
        const agent = targets.get(capture.agentId)
        let error = '선택한 에이전트를 찾을 수 없습니다.'
        if (agent) {
          try {
            // Reuse the same file if the user retries. Keep it available to the CLI as long as
            // other chat attachments, including if the input was left in its composer.
            const key = JSON.stringify(capture.region) + (typeof capture.image === 'string' ? capture.image : '')
            const result = await sendCapture(agent, capture.comment, () => {
              if (stored?.key !== key) stored = { key, attachment: storeAttachment(picture()) }
              return stored.attachment
            }, available)
            if (result.ok) {
              if (available()) onSent(agent)
              return true
            }
            error = result.error
          } catch {
            error = '캡처와 코멘트를 보내지 못했습니다. 다시 시도해 주세요.'
          }
        }
        if (!available()) return false
        next = action(`window.chooseCaptureTarget(${JSON.stringify(projects)}, ${JSON.stringify(error)}, ${JSON.stringify(capture.agentId)})`)
      }
      return false
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

module.exports = { createQuickCapture, pixelRegion, captureProjects }
