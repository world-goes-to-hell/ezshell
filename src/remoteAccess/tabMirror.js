// The PC's SSH tabs as a phone sees them (remote access, step 3): each tab's latest output and the
// size the PC draws it at, and the devices following it. Memory only, a bounded amount per tab, and
// nothing is kept while remote access is off. The phone never resizes a tab: the PC's view would break.
// Design: docs/plan/2026-11-24-remote-access-tabs-and-agents.md
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.

/** Output kept per tab (characters of the raw stream, control sequences included) */
const MAX_KEPT_CHARS = 256 * 1024
/** After cutting the front, the snapshot starts at the next line when one comes this soon (a cut escape sequence is mostly skipped) */
const LINE_START_WINDOW = 4096
const COMPACT_AFTER_CHUNKS = 128
const DEFAULT_SIZE = { cols: 80, rows: 24 }

/** The kept output from a line start where one is near the front, so it does not begin inside a sequence */
function fromLineStart(text) {
  const newline = text.indexOf('\n')
  return newline !== -1 && newline < LINE_START_WINDOW ? text.slice(newline + 1) : text
}

/**
 * @param {object} [deps]
 * @param {() => boolean} [deps.isEnabled] remote access is on (otherwise nothing is kept)
 */
function createTabMirror({ isEnabled = () => true, maxChars = MAX_KEPT_CHARS } = {}) {
  /** Tab history is joined only when a device attaches. Output handlers append chunks. */
  const tabs = new Map()

  const tabOf = (id) => {
    let tab = tabs.get(id)
    if (!tab) {
      tab = { chunks: [], first: 0, length: 0, trimmed: false, ...DEFAULT_SIZE, followers: new Set() }
      tabs.set(id, tab)
    }
    return tab
  }

  return {
    /** Output of a tab's main terminal, as the PC's window gets it */
    record(id, data) {
      if (typeof id !== 'string' || !isEnabled()) return
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : ''
      if (!text) return
      const tab = tabOf(id)
      tab.chunks.push(text)
      tab.length += text.length
      if (tab.length > maxChars) {
        let excess = tab.length - maxChars
        while (tab.first < tab.chunks.length && excess >= tab.chunks[tab.first].length) {
          excess -= tab.chunks[tab.first].length
          tab.chunks[tab.first++] = ''
        }
        if (excess > 0 && tab.first < tab.chunks.length) tab.chunks[tab.first] = tab.chunks[tab.first].slice(excess)
        if (tab.first >= COMPACT_AFTER_CHUNKS && tab.first * 2 >= tab.chunks.length) {
          tab.chunks = tab.chunks.slice(tab.first)
          tab.first = 0
        }
        tab.length = maxChars
        tab.trimmed = true
      }
      for (const follower of [...tab.followers]) follower.onData(text)
    },
    /** The size the PC draws the tab at (its window resized the terminal) */
    resize(id, cols, rows) {
      if (typeof id !== 'string') return
      const c = Number(cols)
      const r = Number(rows)
      if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || r < 1 || c > 1000 || r > 1000) return
      const tab = tabs.get(id) ?? (isEnabled() ? tabOf(id) : null)
      if (tab) Object.assign(tab, { cols: c, rows: r })
    },
    /**
     * The tab ended: 'closed' (the PC closed it: its output is dropped) or 'disconnected' (the
     * connection was lost; a reconnect continues under the same id). Followers are told and let go.
     */
    ended(id, reason) {
      const tab = tabs.get(id)
      if (!tab) return
      const followers = [...tab.followers]
      tab.followers.clear()
      if (reason === 'closed') tabs.delete(id)
      for (const follower of followers) follower.onEnd(reason === 'closed' ? 'closed' : 'disconnected')
    },
    /**
     * A device starts following a tab: what was kept so far and the PC's size, then each new piece
     * through onData until the returned detach is called or the tab ends (onEnd).
     */
    attach(id, { onData, onEnd }) {
      const tab = tabOf(id)
      const follower = { onData, onEnd }
      tab.followers.add(follower)
      const text = tab.chunks.slice(tab.first).join('')
      return {
        cols: tab.cols,
        rows: tab.rows,
        snapshot: tab.trimmed ? fromLineStart(text) : text,
        detach: () => { tab.followers.delete(follower) }
      }
    },
    /** Remote access was switched off: nothing is kept any more */
    clear() {
      for (const tab of tabs.values()) tab.followers.clear()
      tabs.clear()
    },
    followerCount: (id) => tabs.get(id)?.followers.size ?? 0
  }
}

module.exports = { createTabMirror, MAX_KEPT_CHARS }
