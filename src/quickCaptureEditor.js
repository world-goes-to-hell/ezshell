// Marks drawn on the captured region before it is copied or sent (docs/plan/2026-11-23-capture-annotation-editor.md):
// arrow, box, pen, text, numbered badge and mosaic, drawn in the captured image's own pixels so the result is
// sharp whatever the display scale. The functions below run inside the capture overlay: the page has no
// preload or Electron API, so they are put into it as source text (EDITOR_SCRIPT) and must use nothing but
// each other and the DOM. pixelRegion is shared with main, which crops the same rectangle.

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

/** The arrow's head: its tip and two back corners, and where the shaft ends (under the head) */
function arrowHead(from, to, lineWidth) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (!length) return null
  const size = Math.min(Math.max(lineWidth * 4, 12), length)
  const ux = dx / length
  const uy = dy / length
  const back = { x: to.x - ux * size, y: to.y - uy * size }
  const spread = size * 0.55
  return {
    tip: to,
    left: { x: back.x - uy * spread, y: back.y + ux * spread },
    right: { x: back.x + uy * spread, y: back.y - ux * spread },
    shaftEnd: { x: to.x - ux * size * 0.7, y: to.y - uy * size * 0.7 }
  }
}

/** A rectangle from two corners, whichever way it was dragged */
function cornerBox(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** The comment with the line for badge n: "1. " starts it, later badges begin a new line */
function commentWithBadge(text, n) {
  const kept = String(text ?? '').replace(/\s+$/, '')
  return kept ? kept + '\n' + n + '. ' : n + '. '
}

/** Whether a finished drag is a mark (a click without moving is not, except for text and badges) */
function isMark(mark, minimum) {
  if (mark.type === 'text') return Boolean(mark.text && mark.text.trim())
  if (mark.type === 'badge') return true
  if (mark.type === 'pen') return mark.points.length > 1
  return Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) >= minimum
}

/**
 * Several captures copied as one picture (docs/plan/2026-11-24-capture-multiple-shots.md): top to bottom,
 * each under a 32px band for its number, 16px apart. The overlay draws it and main checks its size against this.
 */
function stackLayout(sizes) {
  let cursor = 0
  const items = sizes.map((size, index) => {
    const item = { labelY: cursor, y: cursor + 32, width: size.width, height: size.height }
    cursor = item.y + size.height + (index < sizes.length - 1 ? 16 : 0)
    return item
  })
  return { width: Math.max(0, ...sizes.map(size => size.width)), height: cursor, items }
}

/**
 * Where an earlier capture is shown for editing (CSS pixels): at its own size, centered at the top, smaller
 * when needed to leave `reserved` pixels of height for the panel (never below a quarter of the screen).
 */
function fitBox(size, viewport, dpr, reserved) {
  const gap = 24
  const natural = { width: size.width / dpr, height: size.height / dpr }
  const maxWidth = viewport.width - gap * 2
  const maxHeight = Math.max(viewport.height * 0.25, viewport.height - reserved - gap * 3)
  const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height)
  const width = natural.width * scale
  const height = natural.height * scale
  return { left: (viewport.width - width) / 2, top: gap, width, height }
}

/** The next badge number: one more than the largest on any capture, so comment lines do not repeat */
function nextBadge(markLists) {
  const numbers = markLists.flat().filter(mark => mark && mark.type === 'badge' && Number.isFinite(mark.n)).map(mark => mark.n)
  return 1 + Math.max(0, ...numbers)
}

/** The undo history for marks brought back after another capture: undo takes them off one at a time */
function restoredHistory(marks) {
  return marks.map((_, index) => marks.slice(0, index))
}

/**
 * Installs window.captureEditor on the overlay. It keeps every capture of the run (shots), each with its own
 * picture, marks and undo history, and edits one at a time: addShot(selection) crops the frozen screen,
 * loadShots(list) brings back earlier captures (their pictures from main), select(i), removeShot(i).
 * exportShots(withImages) gives each capture's source, region and marks, and with withImages a PNG data URL of
 * the marked picture (null when it has no marks). exportCombined() stacks them all (stackLayout).
 * onBadge(n) is called when badge n is placed (the overlay adds "n. " to the comment), onChange() on any edit.
 */
function installCaptureEditor() {
  const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff']
  const WIDTHS = [2, 4, 7]
  const snapshot = document.querySelector('#snapshot')
  const box = document.querySelector('#selection')
  const canvas = document.querySelector('#ink')
  const tools = document.querySelector('#tools')
  const ctx = canvas.getContext('2d')
  // source: the index of an earlier capture in main, or -1 for one cut from this screen (with its selection)
  let shots = []
  let active = -1
  // The shot being edited; its marks and history live here until another one is selected (stash)
  let base = null
  let region = null
  let marks = []
  let past = []
  let future = []
  let draft = null
  let tool = 'arrow'
  let color = COLORS[0]
  let width = WIDTHS[1]
  let typing = null
  let onBadge = () => {}
  let onChange = () => {}

  const scale = () => canvas.width / Math.max(1, canvas.getBoundingClientRect().width)
  // Each axis on its own: the captured image need not have exactly the display's proportions
  const toImage = event => {
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / Math.max(1, rect.height)))
    }
  }

  function place() {
    if (!region) return
    const rect = box.getBoundingClientRect()
    Object.assign(canvas.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' })
  }

  function mosaic(target, mark, from) {
    const area = cornerBox(mark.from, mark.to)
    const w = Math.round(area.width)
    const h = Math.round(area.height)
    if (w < 1 || h < 1) return
    const block = Math.max(6, Math.round(mark.block))
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.ceil(w / block))
    small.height = Math.max(1, Math.ceil(h / block))
    const sctx = small.getContext('2d')
    sctx.drawImage(from, Math.round(area.x), Math.round(area.y), w, h, 0, 0, small.width, small.height)
    target.save()
    target.imageSmoothingEnabled = false
    target.drawImage(small, 0, 0, small.width, small.height, Math.round(area.x), Math.round(area.y), w, h)
    target.restore()
  }

  // A mosaic samples the picture of the capture the mark belongs to
  function draw(target, mark, from = base) {
    target.save()
    target.strokeStyle = mark.color
    target.fillStyle = mark.color
    target.lineWidth = mark.width
    target.lineCap = 'round'
    target.lineJoin = 'round'
    if (mark.type === 'arrow') {
      const head = arrowHead(mark.from, mark.to, mark.width)
      if (head) {
        target.beginPath()
        target.moveTo(mark.from.x, mark.from.y)
        target.lineTo(head.shaftEnd.x, head.shaftEnd.y)
        target.stroke()
        target.beginPath()
        target.moveTo(head.tip.x, head.tip.y)
        target.lineTo(head.left.x, head.left.y)
        target.lineTo(head.right.x, head.right.y)
        target.closePath()
        target.fill()
      }
    } else if (mark.type === 'box') {
      const area = cornerBox(mark.from, mark.to)
      target.strokeRect(area.x, area.y, area.width, area.height)
    } else if (mark.type === 'pen') {
      target.beginPath()
      mark.points.forEach((point, index) => (index ? target.lineTo(point.x, point.y) : target.moveTo(point.x, point.y)))
      target.stroke()
    } else if (mark.type === 'mosaic') {
      mosaic(target, mark, from)
    } else if (mark.type === 'text') {
      target.font = '600 ' + mark.size + 'px "Segoe UI", "Malgun Gothic", sans-serif'
      target.textBaseline = 'top'
      target.lineWidth = Math.max(2, mark.size / 6)
      target.strokeStyle = 'rgba(0, 0, 0, 0.75)'
      target.strokeText(mark.text, mark.at.x, mark.at.y)
      target.fillText(mark.text, mark.at.x, mark.at.y)
    } else if (mark.type === 'badge') {
      target.beginPath()
      target.arc(mark.at.x, mark.at.y, mark.radius, 0, Math.PI * 2)
      target.fill()
      target.lineWidth = Math.max(1.5, mark.radius / 8)
      target.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      target.stroke()
      target.fillStyle = mark.color === '#ffffff' || mark.color === '#ffcc00' ? '#111' : '#fff'
      target.font = '700 ' + Math.round(mark.radius * 1.15) + 'px "Segoe UI", sans-serif'
      target.textAlign = 'center'
      target.textBaseline = 'middle'
      target.fillText(String(mark.n), mark.at.x, mark.at.y + mark.radius * 0.05)
    }
    target.restore()
  }

  // The picture is drawn too: an earlier capture is not the frozen screen behind the canvas
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (base) ctx.drawImage(base, 0, 0)
    for (const mark of draft ? [...marks, draft] : marks) draw(ctx, mark)
    document.querySelector('#undo').disabled = !past.length
    document.querySelector('#redo').disabled = !future.length
    document.querySelector('#clear-marks').disabled = !marks.length
  }

  function commit(next) {
    past = [...past, marks]
    future = []
    marks = next
    render()
    onChange()
  }

  function undo() {
    if (!past.length) return
    future = [marks, ...future]
    marks = past[past.length - 1]
    past = past.slice(0, -1)
    render()
    onChange()
  }

  function redo() {
    if (!future.length) return
    past = [...past, marks]
    marks = future[0]
    future = future.slice(1)
    render()
    onChange()
  }

  // Keep the edited shot's marks and history with it before another one is shown or everything is exported
  function stash() {
    finishTyping(true)
    if (shots[active]) shots = shots.map((shot, index) => index === active ? { ...shot, marks, past, future } : shot)
  }

  function show(index) {
    const shot = shots[index]
    active = index
    base = shot.base
    region = { width: base.width, height: base.height }
    marks = shot.marks
    past = shot.past
    future = shot.future
    draft = null
    canvas.width = region.width
    canvas.height = region.height
    canvas.hidden = false
    place()
    render()
  }

  function hide() {
    finishTyping(false)
    active = -1
    base = null
    region = null
    marks = []
    past = []
    future = []
    draft = null
    canvas.hidden = true
  }

  function pictureOf(shot) {
    const out = document.createElement('canvas')
    out.width = shot.base.width
    out.height = shot.base.height
    const octx = out.getContext('2d')
    octx.drawImage(shot.base, 0, 0)
    for (const mark of shot.marks) draw(octx, mark, shot.base)
    return out
  }

  function cropCanvas(source, x, y, w, h) {
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    out.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h)
    return out
  }

  function finishTyping(keep) {
    if (!typing) return
    const { input, at, size } = typing
    typing = null
    const text = input.value.trim()
    input.remove()
    if (keep && text) commit([...marks, { type: 'text', text, at, size, color }])
  }

  function startTyping(event, at) {
    finishTyping(true)
    const s = scale()
    const size = Math.round((12 + width * 3) * s)
    const input = document.createElement('input')
    input.className = 'ink-text'
    input.setAttribute('aria-label', '표시할 글자')
    input.maxLength = 200
    Object.assign(input.style, {
      left: event.clientX + 'px', top: event.clientY + 'px', color,
      font: '600 ' + Math.round(size / s) + 'px "Segoe UI", "Malgun Gothic", sans-serif'
    })
    input.addEventListener('keydown', key => {
      // The overlay closes on Esc: here it only drops the text being typed
      key.stopPropagation()
      if (key.isComposing) return
      if (key.key === 'Enter') { key.preventDefault(); finishTyping(true) }
      if (key.key === 'Escape') { key.preventDefault(); finishTyping(false) }
    })
    input.addEventListener('blur', () => finishTyping(true))
    document.body.append(input)
    typing = { input, at, size }
    requestAnimationFrame(() => input.focus())
  }

  function selectTool(next) {
    finishTyping(true)
    tool = next
    canvas.dataset.inkTool = next
    for (const button of tools.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === next))
  }
  function selectColor(next) {
    color = next
    tools.style.setProperty('--ink', next)
    for (const button of tools.querySelectorAll('[data-color]')) button.setAttribute('aria-pressed', String(button.dataset.color === next))
  }
  function selectWidth(next) {
    width = next
    for (const button of tools.querySelectorAll('[data-width]')) button.setAttribute('aria-pressed', String(Number(button.dataset.width) === next))
  }

  let pointer = null
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !region) return
    event.preventDefault()
    event.stopPropagation()
    const at = toImage(event)
    const s = scale()
    // Drawing takes the keyboard from the comment, so Ctrl+Z and the tool keys reach the marks
    if (document.activeElement && document.activeElement.id === 'comment') document.activeElement.blur()
    if (tool === 'text') return startTyping(event, at)
    finishTyping(true)
    if (tool === 'badge') {
      const n = nextBadge([...shots.filter((_, index) => index !== active).map(shot => shot.marks), marks])
      commit([...marks, { type: 'badge', at, n, color, radius: Math.round((9 + width * 1.5) * s) }])
      onBadge(n)
      return
    }
    pointer = event.pointerId
    canvas.setPointerCapture(pointer)
    const lineWidth = width * s
    draft = tool === 'pen'
      ? { type: 'pen', points: [at], color, width: lineWidth }
      : { type: tool, from: at, to: at, color, width: lineWidth, block: 10 * s }
    render()
  })
  canvas.addEventListener('pointermove', event => {
    if (!draft || event.pointerId !== pointer) return
    const at = toImage(event)
    draft = draft.type === 'pen' ? { ...draft, points: [...draft.points, at] } : { ...draft, to: at }
    render()
  })
  const endDrag = keep => event => {
    if (!draft || event.pointerId !== pointer) return
    const done = draft
    draft = null
    pointer = null
    if (keep && isMark(done, 4 * scale())) commit([...marks, done])
    else render()
  }
  canvas.addEventListener('pointerup', endDrag(true))
  canvas.addEventListener('pointercancel', endDrag(false))
  canvas.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation() })

  tools.addEventListener('click', event => {
    const button = event.target.closest('button')
    if (!button) return
    if (button.dataset.tool) selectTool(button.dataset.tool)
    else if (button.dataset.color) selectColor(button.dataset.color)
    else if (button.dataset.width) selectWidth(Number(button.dataset.width))
    else if (button.id === 'undo') undo()
    else if (button.id === 'redo') redo()
    else if (button.id === 'clear-marks' && marks.length) commit([])
  })

  const TOOL_KEYS = { a: 'arrow', r: 'box', p: 'pen', t: 'text', n: 'badge', m: 'mosaic' }
  document.addEventListener('keydown', event => {
    if (!region || event.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return
    const key = event.key.toLowerCase()
    if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) { event.preventDefault(); undo() }
    else if ((event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey))) { event.preventDefault(); redo() }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && TOOL_KEYS[key]) { event.preventDefault(); selectTool(TOOL_KEYS[key]) }
  })
  window.addEventListener('resize', place)

  selectTool('arrow')
  selectColor(COLORS[0])
  selectWidth(WIDTHS[1])

  window.captureEditor = {
    configure(options = {}) {
      onBadge = options.onBadge ?? (() => {})
      onChange = options.onChange ?? (() => {})
    },
    /** Earlier captures of this run, from main: { image (PNG data URL), marks } each */
    async loadShots(list) {
      shots = await Promise.all(list.map(async (item, index) => {
        const image = new Image()
        image.src = item.image
        await image.decode()
        const kept = Array.isArray(item.marks) ? item.marks : []
        return {
          base: cropCanvas(image, 0, 0, image.naturalWidth, image.naturalHeight),
          source: index, selection: null, marks: kept, past: restoredHistory(kept), future: []
        }
      }))
      hide()
    },
    /** Cut the selection from the frozen screen as a new capture and edit it; its index, or -1 */
    addShot(selection) {
      const pixels = pixelRegion(selection, { width: snapshot.naturalWidth, height: snapshot.naturalHeight })
      if (!pixels || shots.length >= MAX_SHOTS || shots.some(shot => shot.source === -1)) return -1
      stash()
      const shot = {
        base: cropCanvas(snapshot, pixels.x, pixels.y, pixels.width, pixels.height),
        source: -1, selection, marks: [], past: [], future: []
      }
      shots = [...shots, shot]
      show(shots.length - 1)
      onChange()
      return shots.length - 1
    },
    /** Edit capture i; the overlay has put the selection box where it is shown first */
    select(index) {
      if (!shots[index]) return
      stash()
      show(index)
      onChange()
    },
    /** Drop capture i; nothing is edited until the overlay selects another */
    removeShot(index) {
      if (!shots[index]) return
      stash()
      shots = shots.filter((_, at) => at !== index)
      hide()
      onChange()
    },
    shots: () => shots.map(shot => ({ source: shot.source, width: shot.base.width, height: shot.base.height })),
    active: () => active,
    hasMarks: () => marks.length > 0 || Boolean(typing?.input.value.trim()),
    /** Capture i with its marks, scaled to `height` device pixels, for its thumbnail */
    drawThumbnail(index, target, height) {
      const shot = shots[index]
      if (!shot) return
      const picture = pictureOf(index === active ? { ...shot, marks } : shot)
      const scale = Math.min(height / picture.height, height * 3 / picture.width)
      target.width = Math.max(1, Math.round(picture.width * scale))
      target.height = Math.max(1, Math.round(picture.height * scale))
      target.getContext('2d').drawImage(picture, 0, 0, target.width, target.height)
    },
    exportShots(withImages) {
      stash()
      return shots.map(shot => ({
        source: shot.source,
        ...(shot.selection ? { region: shot.selection } : {}),
        marks: shot.marks,
        image: withImages && shot.marks.length ? pictureOf(shot).toDataURL('image/png') : null
      }))
    },
    /** All captures stacked into one picture with their numbers (copying several), or null past canvas limits */
    exportCombined() {
      stash()
      if (shots.length < 2) return null
      const layout = stackLayout(shots.map(shot => ({ width: shot.base.width, height: shot.base.height })))
      // The same pixel limit as main's own stacking (composeStack): copying more fails with a notice, not one capture
      if (layout.width > 16384 || layout.height > 32767 || layout.width * layout.height > 67108864) return null
      const out = document.createElement('canvas')
      out.width = layout.width
      out.height = layout.height
      const octx = out.getContext('2d')
      octx.fillStyle = '#20242c'
      octx.fillRect(0, 0, out.width, out.height)
      shots.forEach((shot, index) => {
        const item = layout.items[index]
        octx.fillStyle = '#ffffff'
        octx.font = '600 17px "Segoe UI", "Malgun Gothic", sans-serif'
        octx.textBaseline = 'middle'
        octx.fillText('캡처 ' + (index + 1), 8, item.labelY + 16)
        octx.drawImage(pictureOf(shot), 0, item.y)
      })
      return out.toDataURL('image/png')
    }
  }
}

const MAX_SHOTS = 8
const EDITOR_SCRIPT = 'const MAX_SHOTS = ' + MAX_SHOTS + '\n' +
  [pixelRegion, arrowHead, cornerBox, commentWithBadge, isMark, stackLayout, fitBox, nextBadge, restoredHistory, installCaptureEditor]
    .map(fn => fn.toString()).join('\n') + '\ninstallCaptureEditor()\n'

/**
 * The marked image the overlay sends back, or null to use the plain crop: a PNG data URL that decodes to
 * exactly the chosen region's size. The page is ours but draws on user input: main does not trust it further.
 */
const MAX_MARKED_IMAGE = 48 * 1024 * 1024
function markedImage(value, region, nativeImage) {
  if (typeof value !== 'string' || !nativeImage || !region) return null
  if (!value.startsWith('data:image/png;base64,') || value.length > MAX_MARKED_IMAGE) return null
  const image = nativeImage.createFromDataURL(value)
  if (!image || image.isEmpty()) return null
  const { width, height } = image.getSize()
  return width === region.width && height === region.height ? image : null
}

/**
 * Main's own stack of several captures when the overlay's picture cannot be used (wrong size, too big): the
 * same layout from the pictures main checked, on a gray background, without the number text.
 */
// 64M pixels: a 256MB buffer in main at most
const MAX_STACK_PIXELS = 64 * 1024 * 1024
function composeStack(pictures, nativeImage) {
  const sizes = pictures.map(picture => picture.getSize())
  const layout = stackLayout(sizes)
  if (!layout.width || layout.width * layout.height > MAX_STACK_PIXELS) return null
  const out = Buffer.alloc(layout.width * layout.height * 4)
  // The same value in every color channel: the order of the bitmap's channels does not matter
  out.fill(Buffer.from([0x22, 0x22, 0x22, 0xff]))
  for (const [index, picture] of pictures.entries()) {
    const { width, height } = sizes[index]
    const bitmap = picture.toBitmap()
    if (bitmap.length < width * height * 4) return null
    const top = layout.items[index].y
    for (let row = 0; row < height; row++) bitmap.copy(out, (top + row) * layout.width * 4, row * width * 4, (row + 1) * width * 4)
  }
  return nativeImage.createFromBitmap(out, { width: layout.width, height: layout.height })
}

module.exports = {
  pixelRegion, arrowHead, cornerBox, commentWithBadge, isMark, markedImage, stackLayout, fitBox, nextBadge, restoredHistory,
  composeStack, MAX_SHOTS, EDITOR_SCRIPT
}
