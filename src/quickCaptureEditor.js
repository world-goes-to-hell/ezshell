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
 * Installs window.captureEditor on the overlay: start(selection) over the chosen region, reset(), and
 * exportImage() (a PNG data URL of the region with its marks, or null when nothing was drawn).
 * onBadge(n) is called when badge n is placed (the overlay adds "n. " to the comment).
 */
function installCaptureEditor() {
  const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff']
  const WIDTHS = [2, 4, 7]
  const snapshot = document.querySelector('#snapshot')
  const box = document.querySelector('#selection')
  const canvas = document.querySelector('#ink')
  const tools = document.querySelector('#tools')
  const ctx = canvas.getContext('2d')
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

  function mosaic(target, mark) {
    const area = cornerBox(mark.from, mark.to)
    const w = Math.round(area.width)
    const h = Math.round(area.height)
    if (w < 1 || h < 1) return
    const block = Math.max(6, Math.round(mark.block))
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.ceil(w / block))
    small.height = Math.max(1, Math.ceil(h / block))
    const sctx = small.getContext('2d')
    sctx.drawImage(base, Math.round(area.x), Math.round(area.y), w, h, 0, 0, small.width, small.height)
    target.save()
    target.imageSmoothingEnabled = false
    target.drawImage(small, 0, 0, small.width, small.height, Math.round(area.x), Math.round(area.y), w, h)
    target.restore()
  }

  function draw(target, mark) {
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
      mosaic(target, mark)
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

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
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
  }

  function undo() {
    if (!past.length) return
    future = [marks, ...future]
    marks = past[past.length - 1]
    past = past.slice(0, -1)
    render()
  }

  function redo() {
    if (!future.length) return
    past = [...past, marks]
    marks = future[0]
    future = future.slice(1)
    render()
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
      if (key.key === 'Enter' && !key.isComposing) { key.preventDefault(); finishTyping(true) }
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
      const n = marks.filter(mark => mark.type === 'badge').length + 1
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

  window.captureEditor = {
    start(selection, options = {}) {
      onBadge = options.onBadge ?? (() => {})
      region = pixelRegion(selection, { width: snapshot.naturalWidth, height: snapshot.naturalHeight })
      if (!region) return false
      base = document.createElement('canvas')
      base.width = region.width
      base.height = region.height
      base.getContext('2d').drawImage(snapshot, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height)
      canvas.width = region.width
      canvas.height = region.height
      marks = []
      past = []
      future = []
      draft = null
      canvas.hidden = false
      place()
      selectTool('arrow')
      selectColor(COLORS[0])
      selectWidth(WIDTHS[1])
      render()
      return true
    },
    reset() {
      finishTyping(false)
      region = null
      base = null
      marks = []
      past = []
      future = []
      draft = null
      canvas.hidden = true
    },
    hasMarks: () => marks.length > 0 || Boolean(typing?.input.value.trim()),
    exportImage() {
      finishTyping(true)
      if (!region || !marks.length) return null
      const out = document.createElement('canvas')
      out.width = region.width
      out.height = region.height
      const octx = out.getContext('2d')
      octx.drawImage(base, 0, 0)
      for (const mark of marks) draw(octx, mark)
      return out.toDataURL('image/png')
    }
  }
}

const EDITOR_SCRIPT = [pixelRegion, arrowHead, cornerBox, commentWithBadge, isMark, installCaptureEditor]
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

module.exports = { pixelRegion, arrowHead, cornerBox, commentWithBadge, isMark, markedImage, EDITOR_SCRIPT }
