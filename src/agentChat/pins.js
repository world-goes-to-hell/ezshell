// Agent answers pinned out of the chat view into small windows of their own, read while working in
// another tab (docs/plan/2026-11-20-pinned-agent-replies.md). The text lives here, in memory only; a
// window asks for its own pin and may open only the links this answer had in the conversation.
const { linkTarget, linkKeysIn } = require('./links.js')

const MAX_PINS = 5
const MAX_TEXT = 100_000
const MAX_LABEL = 160
const SHELL_ID = /^local:\d+$/
const ITEM_ID = /^[\w:.-]{1,200}$/
const KINDS = new Set(['claude', 'codex'])
/** The window's header alone, when folded */
const FOLDED_HEIGHT = 40
const MIN_WIDTH = 260
const MIN_HEIGHT = 120

/** One line of plain text for a header: no control or invisible format characters */
function cleanLabel(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
}

/**
 * createWindow(pinId): a new window for a pin (a BrowserWindow). chats: the open chat views
 * (knowsLink, cwdOf).
 */
function createPins({ createWindow, chats, platform = process.platform, now = () => Date.now() }) {
  const pins = new Map()
  let seq = 0

  const alive = pin => pin.win && !pin.win.isDestroyed()

  function show(pin) {
    if (pin.win.isMinimized()) pin.win.restore()
    pin.win.show()
    pin.win.focus()
  }

  return {
    MAX_PINS,
    /** Pins an answer of an open chat view; the same answer again brings its window forward */
    pin(request) {
      const shellId = typeof request?.shellId === 'string' && SHELL_ID.test(request.shellId) ? request.shellId : null
      const itemId = typeof request?.itemId === 'string' && ITEM_ID.test(request.itemId) ? request.itemId : null
      const text = typeof request?.text === 'string' && request.text.trim() && request.text.length <= MAX_TEXT ? request.text : null
      if (!shellId || !itemId || !text) return { ok: false, error: '띄울 답변을 찾지 못했습니다.' }
      const existing = [...pins.values()].find(pin => pin.shellId === shellId && pin.itemId === itemId && alive(pin))
      if (existing) {
        show(existing)
        return { ok: true, id: existing.id, existing: true }
      }
      if (pins.size >= MAX_PINS) return { ok: false, error: `답변은 ${MAX_PINS}개까지 띄울 수 있습니다. 띄운 창을 하나 닫고 다시 해 주세요.` }
      const cwd = chats.cwdOf(shellId)
      // Only links this conversation has shown already (what the chat view could open), found in this answer
      const links = new Set(linkKeysIn(text, platform, cwd).filter(key => chats.knowsLink(shellId, key)))
      const id = `pin-${++seq}`
      const pin = {
        id,
        shellId,
        itemId,
        text,
        cwd,
        links,
        kind: KINDS.has(request.kind) ? request.kind : null,
        title: cleanLabel(request.title) || '에이전트 답변',
        time: Number.isFinite(request.time) ? request.time : null,
        pinnedAt: now(),
        folded: false,
        win: null
      }
      pins.set(id, pin)
      pin.win = createWindow(id)
      pin.win.on('closed', () => pins.delete(id))
      return { ok: true, id }
    },
    /** The pin whose window sent a request, or null */
    ofSender(sender) {
      for (const pin of pins.values()) {
        if (alive(pin) && pin.win.webContents === sender) return pin
      }
      return null
    },
    /** What the window draws */
    view(pin) {
      return {
        text: pin.text, kind: pin.kind, title: pin.title, time: pin.time, pinnedAt: pin.pinnedAt,
        folded: pin.folded, maximized: pin.win.isMaximized()
      }
    },
    /** The target of a link the window asks to open, or null when the answer had no such link */
    linkFor(pin, href) {
      const target = linkTarget(href, platform, pin.cwd)
      return target && pin.links.has(target.key) ? target : null
    },
    /** Folds the window to its header, or gives it its height back */
    fold(pin, folded) {
      if (!alive(pin) || pin.folded === Boolean(folded)) return
      const win = pin.win
      const { width, height } = win.getNormalBounds()
      pin.folded = Boolean(folded)
      if (pin.folded) {
        pin.unfoldMaximized = win.isMaximized()
        if (pin.unfoldMaximized) win.unmaximize()
        // Where the window's place is saved (src/ipc/detachedWindows.js): the height it unfolds to
        win.pinnedUnfoldedHeight = height
        win.setMinimumSize(MIN_WIDTH, FOLDED_HEIGHT)
        win.setSize(width, FOLDED_HEIGHT)
        win.setResizable(false)
        win.setMaximizable(false)
      } else {
        const unfoldedHeight = win.pinnedUnfoldedHeight
        win.pinnedUnfoldedHeight = null
        win.setResizable(true)
        win.setMaximizable(true)
        win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
        win.setSize(width, Math.max(MIN_HEIGHT, unfoldedHeight))
        if (pin.unfoldMaximized) win.maximize()
      }
    },
    /** All windows close (the app locks) */
    closeAll() {
      for (const pin of [...pins.values()]) {
        if (alive(pin)) pin.win.close()
      }
      pins.clear()
    },
    size: () => pins.size
  }
}

module.exports = { createPins, cleanLabel, MAX_PINS, MIN_WIDTH, MIN_HEIGHT, FOLDED_HEIGHT }
