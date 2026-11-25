const path = require('node:path')
const { OVERLAY_URL, captureOverlayUrl, captureChipUrl } = require('./quickCaptureOverlay.js')
// The overlay computes the same rectangles to draw its marks in and to stack several captures (quickCaptureEditor.js)
const { pixelRegion, markedImage, stackLayout, composeStack, MAX_SHOTS } = require('./quickCaptureEditor.js')

const MAX_MARKS = 500
const MAX_MARKS_JSON = 2 * 1024 * 1024
const MAX_COMMENT = 20000
const MARK_TYPES = new Set(['arrow', 'box', 'pen', 'text', 'badge', 'mosaic'])
// The strip between captures is hidden this long before the screen is read, so it is not in the picture
const CHIP_HIDE_MS = 150
const CHIP_SIZE = { width: 440, height: 48 }
const TOO_BIG_TO_STACK = '캡처가 너무 커서 한 장으로 합쳐 복사할 수 없습니다. 바로작업으로 보내거나 캡처 수를 줄여 주세요.'

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

/**
 * The marks the overlay drew on a capture. Main keeps them between captures only to give them back to the next
 * overlay as data, so they stay editable: a bounded list of known mark types, or nothing.
 */
function cleanMarks(value) {
  if (!Array.isArray(value) || value.length > MAX_MARKS) return []
  if (!value.every(mark => mark && typeof mark === 'object' && !Array.isArray(mark) && MARK_TYPES.has(mark.type))) return []
  try {
    const text = JSON.stringify(value)
    return text.length <= MAX_MARKS_JSON ? JSON.parse(text) : []
  } catch {
    return []
  }
}

/**
 * The captures the overlay returns (docs/plan/2026-11-24-capture-multiple-shots.md): each one an earlier capture
 * main holds (its index, at most once) or the one cut from this screen (-1, at most once, with a valid region).
 * Null when the list does not match: then nothing is copied or sent. The pixels always come from main.
 */
function resolveShots(list, earlierCount, imageSize) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_SHOTS) return null
  const seen = new Set()
  const shots = []
  for (const item of list) {
    const source = item?.source
    if (!Number.isInteger(source) || source < -1 || source >= earlierCount || seen.has(source)) return null
    seen.add(source)
    const region = source === -1 ? pixelRegion(item.region, imageSize) : null
    if (source === -1 && !region) return null
    const marks = cleanMarks(item.marks)
    // Marks main cannot keep as data (too many, too big): the picture with them drawn in is kept instead
    const dropped = Array.isArray(item.marks) && item.marks.length > 0 && marks.length === 0
    shots.push({ source, region, marks, dropped, image: typeof item.image === 'string' ? item.image : null })
  }
  return shots
}

function createQuickCapture({
  desktopCapturer, clipboard, ClipboardItem, BrowserWindow, getDisplay, isAvailable, nativeImage = null,
  listAgents = () => [], repoFolders = async () => [], storeAttachment, sendCapture, focusWindow = () => {},
  onSent = () => {}, onError = () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  let active = null
  // The captures of a run that goes on after `추가 캡처`: each one's cropped pixels (main's own) and marks, the
  // comment, the display of the last capture and the strip shown meanwhile. Memory only; never written to disk.
  let session = null
  let theme
  let overlayUrl = OVERLAY_URL

  function setTheme(next) {
    theme = next
    overlayUrl = captureOverlayUrl(next)
  }

  function closeChip(run = session) {
    const chip = run?.chip
    if (run) run.chip = null
    if (chip && !chip.isDestroyed()) chip.destroy()
  }

  function clearSession() {
    closeChip()
    session = null
  }

  function endTask(task) {
    if (active === task) active = null
    task.abort()
    if (task.window && !task.window.isDestroyed()) task.window.destroy()
  }

  /** Everything ends, earlier captures included: lock, quit, the main window closing */
  function cancel() {
    clearSession()
    if (active) endTask(active)
  }

  /** Esc reported by the helper right after the hotkey: only this capture; earlier ones stay with their strip */
  function cancelCapture() {
    if (active) endTask(active)
  }

  // The strip between captures: it does not take the keyboard from the program the user is changing the screen in
  async function showChip(run) {
    if (session !== run || run.chip) return
    // A run nobody can see or go on with is not kept
    if (!isAvailable()) return clearSession()
    const area = run.display?.workArea ?? run.display?.bounds
    if (!area) return clearSession()
    const chip = new BrowserWindow({
      ...CHIP_SIZE, x: Math.round(area.x + (area.width - CHIP_SIZE.width) / 2), y: Math.round(area.y + 12),
      show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
      maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    run.chip = chip
    // Closed by the user (Alt+F4) rather than by us: the captures are thrown away, not kept out of sight
    chip.once('closed', () => {
      if (run.chip !== chip) return
      run.chip = null
      if (session === run && !active) session = null
    })
    chip.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    chip.webContents.on('will-navigate', event => event.preventDefault())
    chip.setAlwaysOnTop(true, 'screen-saver')
    const current = () => session === run && run.chip === chip && !chip.isDestroyed()
    try {
      await chip.loadURL(captureChipUrl(theme))
      if (!current()) return
      await chip.webContents.executeJavaScript(`window.showCaptureCount(${run.captures.length})`)
      if (!current()) return
      chip.showInactive()
      const choice = await chip.webContents.executeJavaScript('window.waitChip()')
      if (!current()) return
      if (choice === 'discard' || active || !isAvailable()) clearSession()
      else if (choice === 'capture' || choice === 'open') void start({ review: choice === 'open' })
    } catch {
      // The strip was closed while it loaded or waited
    }
  }

  /**
   * Freeze the display under the pointer and let the user choose and mark a region. With earlier captures of
   * the run, they come back into the overlay; `review` opens them without choosing a new region.
   * True when the captures were copied or sent.
   */
  async function start({ review = false, released } = {}) {
    if (active || !isAvailable()) return false
    if (!session) session = { captures: [], comment: '', display: null, chip: null }
    const run = session
    let abort
    const cancelled = new Promise(resolve => { abort = () => resolve(null) })
    const wait = (...operations) => Promise.race([...operations, cancelled])
    const task = { window: null, abort, userClosed: false }
    const available = () => active === task && !task.window?.isDestroyed() && isAvailable()
    active = task
    // closed (or failed): keep earlier captures unless the user closed the overlay; paused: keep them all; done: clear
    let outcome = 'closed'
    let timer
    try {
      if (run.chip) {
        closeChip(run)
        await wait(delay(CHIP_HIDE_MS))
        if (!available()) return false
      }
      const display = getDisplay()
      run.display = display
      const { bounds, scaleFactor } = display
      const sources = await wait(
        desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.round(bounds.width * scaleFactor), height: Math.round(bounds.height * scaleFactor) }
        }),
        new Promise(resolve => { timer = setTimeout(resolve, 4000, []); timer.unref?.() })
      )
      if (!available()) return false
      const image = sources.find(source => source.display_id === String(display.id))?.thumbnail
      if (!image || image.isEmpty()) throw new Error('해당 모니터의 화면을 읽지 못했습니다.')
      if (released && (!await wait(released) || !available())) return false

      const win = new BrowserWindow({
        ...bounds, show: false, frame: false, movable: false, skipTaskbar: true,
        hasShadow: false, backgroundColor: '#131820',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
      })
      task.window = win
      // The page closes itself on Esc or 취소: that throws the captures away
      win.on('close', () => {
        task.userClosed = true
        win.hide()
      })
      win.once('closed', () => {
        task.window = null
        if (active === task) endTask(task)
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', event => event.preventDefault())
      win.webContents.once('render-process-gone', () => { if (!win.isDestroyed()) win.destroy() })
      win.setAlwaysOnTop(true, 'screen-saver')
      await wait(win.loadURL(overlayUrl))
      if (!available()) return false
      win.webContents.setZoomFactor(1)
      await wait(win.webContents.executeJavaScript(`window.setCaptureImage(${JSON.stringify(image.toDataURL())})`))
      if (!available()) return false
      const action = code => wait(win.webContents.executeJavaScript(code))
      const earlier = run.captures
      const state = {
        captures: earlier.map(capture => ({ image: capture.crop.toDataURL(), marks: capture.marks })),
        comment: run.comment,
        review: review && earlier.length > 0
      }
      let next = action(`window.pickCaptureRegion(${JSON.stringify(state)})`)
      // A normal Windows window stops at the taskbar; the selection must cover the whole display.
      win.setFullScreen(true)
      win.show()
      win.moveTop()
      win.focus()
      focusWindow(win)
      let projects = []
      let targets = new Map()
      // The stored files of the images last sent: a retry reuses them unless the marks changed meanwhile
      let stored = null
      while (available()) {
        const capture = await next
        if (!capture || !available()) return false
        // Esc or 취소 while main waits on the overlay: the page answers instead of closing itself, so no request
        // is left to fail as its frame goes away (that failure came before the window's close event)
        if (capture.action === 'close') {
          task.userClosed = true
          return false
        }
        if (capture.action === 'targets') {
          projects = await wait(captureProjects(listAgents(), repoFolders))
          if (!available()) return false
          targets = new Map(projects.flatMap(project => project.agents.map(agent => [agent.id, agent])))
          next = action(`window.chooseCaptureTarget(${JSON.stringify(projects)})`)
          continue
        }
        const shots = resolveShots(capture.shots, earlier.length, image.getSize())
        if (!shots || typeof capture.comment !== 'string') {
          outcome = 'invalid'
          return false
        }
        const cropOf = shot => shot.source === -1 ? image.crop(shot.region) : earlier[shot.source].crop
        // Each capture with the user's marks when the overlay drew any (checked against main's size), else main's crop
        const pictureOf = shot => {
          const size = shot.source === -1 ? shot.region : earlier[shot.source].crop.getSize()
          return markedImage(shot.image, size, nativeImage) ?? cropOf(shot)
        }
        if (capture.action === 'more') {
          if (shots.length >= MAX_SHOTS) {
            outcome = 'invalid'
            return false
          }
          run.captures = shots.map(shot => ({ crop: shot.dropped ? pictureOf(shot) : cropOf(shot), marks: shot.marks }))
          run.comment = capture.comment.slice(0, MAX_COMMENT)
          outcome = 'paused'
          return false
        }
        if (capture.action === 'copy') {
          // The clipboard holds one picture: several captures are copied stacked into one
          const pictures = shots.map(pictureOf)
          const picture = pictures.length === 1 ? pictures[0]
            : markedImage(capture.combined, stackLayout(pictures.map(item => item.getSize())), nativeImage)
              ?? composeStack(pictures, nativeImage)
          if (!picture) {
            // Never copy only some of the captures: say so and leave the overlay open
            next = action(`window.captureNotice(${JSON.stringify(TOO_BIG_TO_STACK)})`)
            continue
          }
          const contents = { 'image/png': new Blob([picture.toPNG()], { type: 'image/png' }) }
          if (capture.comment.trim()) contents['text/plain'] = capture.comment
          await wait(clipboard.write([new ClipboardItem(contents)]))
          if (!available()) return false
          outcome = 'done'
          return true
        }
        if (capture.action !== 'send') return false
        const agent = targets.get(capture.agentId)
        let error = '선택한 에이전트를 찾을 수 없습니다.'
        if (agent) {
          try {
            // Reuse the same files if the user retries. Keep them available to the CLI as long as
            // other chat attachments, including if the input was left in its composer.
            const key = JSON.stringify(shots.map(shot => [shot.source, shot.region, shot.image]))
            const result = await wait(sendCapture(agent, capture.comment, () => {
              if (stored?.key !== key) stored = { key, attachments: shots.map(shot => storeAttachment(pictureOf(shot))) }
              return stored.attachments
            }, available))
            if (!available()) return false
            if (result.ok) {
              onSent(agent)
              outcome = 'done'
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
      // A request still pending when the user closes the overlay (Esc) fails as its frame goes away: not an error
      if (active === task && !task.userClosed && !task.window?.isDestroyed()) onError(error)
      return false
    } finally {
      clearTimeout(timer)
      endTask(task)
      if (session === run) {
        const keep = outcome === 'paused' || (outcome === 'closed' && !task.userClosed)
        if (keep && run.captures.length) void showChip(run)
        else clearSession()
      }
    }
  }

  return { start, cancel, cancelCapture, setTheme, pending: () => session?.captures.length ?? 0 }
}

module.exports = { createQuickCapture, pixelRegion, captureProjects, resolveShots, cleanMarks }
