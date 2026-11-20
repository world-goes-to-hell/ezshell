const fs = require('fs')
const path = require('path')
const { createClaudeParser } = require('./claudeTranscript.js')
const { createCodexParser } = require('./codexTranscript.js')
const { linkKeysIn } = require('./links.js')

// The chat views that are open (one per shell), each following its agent's transcript file: on
// opening the last part of the file, then what is appended, and earlier parts when the view scrolls
// up. Files are read in bounded parts only (one transcript can be tens of MB) and nothing is kept on
// disk. Frames go to the window as `agent-chat-frame`.

const FIRST_BYTES = 2 * 1024 * 1024
const OLDER_BYTES = 2 * 1024 * 1024
/** Read per look when the file grew a lot (the rest comes on the next looks) */
const STEP_BYTES = 4 * 1024 * 1024
const TICK_MS = 500
/** How often a Claude transcript not found yet is looked for again */
const FIND_RETRY_MS = 3000
// How long a compaction notice waits for the /compact line written after it (claudeTranscript.js)
const NOTICE_WAIT_MS = 1500
const MAX_CHATS = 24
/** Links remembered per view (the latest) */
const MAX_LINKS = 2000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude Code's folder name for a working directory: every character but ASCII letters and digits is '-' */
const claudeFolderName = cwd => String(cwd).replace(/[^a-zA-Z0-9]/g, '-')

async function isFile(file) {
  try { return (await fs.promises.stat(file)).isFile() } catch { return false }
}

/** `projects/<folder of cwd>/<id>.jsonl`, or the file of that id in any project folder */
async function findClaudeFile(root, cwd, sessionId) {
  if (!UUID.test(sessionId ?? '')) return null
  const name = `${sessionId.toLowerCase()}.jsonl`
  const projects = path.join(root, 'projects')
  if (cwd) {
    const file = path.join(projects, claudeFolderName(cwd), name)
    if (await isFile(file)) return file
  }
  let folders
  try { folders = await fs.promises.readdir(projects, { withFileTypes: true }) } catch { return null }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const file = path.join(projects, folder.name, name)
    if (await isFile(file)) return file
  }
  return null
}

async function readRange(file, start, end) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const length = Math.max(0, end - start)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** The JSON objects of the complete lines in a chunk and how many bytes those lines take */
function completeLines(buffer) {
  const last = buffer.lastIndexOf(10)
  if (last === -1) return { lines: [], used: 0 }
  const lines = buffer.subarray(0, last).toString('utf8').split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line)
      return value !== null && typeof value === 'object' ? [value] : []
    } catch {
      return []
    }
  })
  return { lines, used: last + 1 }
}

/** One entry per id, where it first appeared, with its latest content (a tool gets its result later) */
function latestById(items) {
  const byId = new Map()
  for (const item of items) byId.set(item.id, item)
  return [...byId.values()]
}

/**
 * @param {object} deps
 * @param {(shellId: string) => Promise<{ kind: 'claude' | 'codex', sessionId?: string | null, cwd?: string | null, file?: string | null, approval?: object | null } | null>} deps.resolve
 *   the agent running in a shell now (null when there is none), with the prompt it shows if any
 * @param {(channel: string, payload: object) => void} deps.send to the main window
 * @param {string} deps.claudeRoot `$CLAUDE_CONFIG_DIR` or `~/.claude`
 * @param {(shellId: string) => boolean} deps.isGone the shell is closed (not just its agent ended)
 */
function createAgentChats({ resolve, send, claudeRoot, isGone = () => false, tickMs = TICK_MS, now = () => Date.now() }) {
  const chats = new Map()
  let timer = null

  const live = chat => chats.get(chat.shellId) === chat

  function frame(chat, fields) {
    if (!live(chat)) return
    // The links of what is sent: the only ones the view may ask main to open
    if (fields.reset) chat.links.clear()
    for (const item of fields.items ?? []) {
      if (item.kind !== 'assistant') continue
      for (const key of linkKeysIn(item.text, process.platform, chat.cwd)) {
        chat.links.delete(key)
        chat.links.add(key)
        if (chat.links.size > MAX_LINKS) chat.links.delete(chat.links.values().next().value)
      }
    }
    send('agent-chat-frame', { shellId: chat.shellId, ...fields })
  }

  function setState(chat, state) {
    if (chat.state === state) return
    chat.state = state
    frame(chat, { state })
  }

  /** The transcript file of the shell's agent now, or null (not started or not written yet) */
  async function fileFor(chat, target) {
    if (target.file) return target.file
    if (target.kind !== 'claude' || !target.sessionId) return null
    if (chat.lookup?.sessionId === target.sessionId) {
      if (chat.lookup.file) return chat.lookup.file
      if (now() - chat.lookup.at < FIND_RETRY_MS) return null
    }
    const file = await findClaudeFile(claudeRoot, target.cwd, target.sessionId)
    chat.lookup = { sessionId: target.sessionId, file, at: now() }
    return file
  }

  /** Starts over on a (new) file: its last part */
  async function load(chat, file, kind) {
    const { size } = await fs.promises.stat(file)
    const start = Math.max(0, size - FIRST_BYTES)
    let buffer = await readRange(file, start, size)
    let oldest = start
    if (start > 0) {
      // The window starts inside a line: that line belongs to the part before
      const first = buffer.indexOf(10)
      buffer = first === -1 ? Buffer.alloc(0) : buffer.subarray(first + 1)
      oldest = first === -1 ? size : start + first + 1
    }
    const parser = kind === 'codex' ? createCodexParser() : createClaudeParser()
    const { lines, used } = completeLines(buffer)
    const items = []
    let title
    for (const line of lines) {
      const result = parser.feed(line)
      items.push(...result.items)
      title = result.title ?? title
    }
    // A compaction notice the part read ends with (claudeTranscript.js holds it for the command after it)
    items.push(...(parser.flush?.(0) ?? []))
    if (!live(chat)) return
    Object.assign(chat, { file, kind, parser, oldest, tail: oldest + used, skipping: false, title: title ?? null, state: 'live' })
    frame(chat, { reset: true, kind, state: 'live', items: latestById(items), title: title ?? null, hasOlder: oldest > 0 })
  }

  async function follow(chat) {
    const { size } = await fs.promises.stat(chat.file)
    if (size < chat.tail) return load(chat, chat.file, chat.kind)
    if (size === chat.tail) {
      // Nothing new: a compaction notice held for its /compact line comes out after a while anyway
      const late = chat.parser.flush?.(NOTICE_WAIT_MS) ?? []
      if (late.length) frame(chat, { items: late })
      return
    }
    let buffer = await readRange(chat.file, chat.tail, Math.min(size, chat.tail + STEP_BYTES))
    if (!live(chat)) return
    if (chat.skipping) {
      // Inside a line longer than a whole step: skip to its end
      const end = buffer.indexOf(10)
      if (end === -1) { chat.tail += buffer.length; return }
      chat.tail += end + 1
      chat.skipping = false
      buffer = buffer.subarray(end + 1)
    }
    const { lines, used } = completeLines(buffer)
    if (!used && buffer.length >= STEP_BYTES) {
      chat.tail += buffer.length
      chat.skipping = true
      return
    }
    chat.tail += used
    const items = []
    let title = chat.title
    for (const line of lines) {
      const result = chat.parser.feed(line)
      items.push(...result.items)
      title = result.title ?? title
    }
    items.push(...(chat.parser.flush?.(NOTICE_WAIT_MS) ?? []))
    const renamed = title !== chat.title
    chat.title = title
    if (items.length || renamed) frame(chat, { items: latestById(items), ...(renamed ? { title } : {}) })
  }

  async function sync(chat) {
    if (isGone(chat.shellId)) {
      // The shell was closed (its tab or pane): nothing more to follow
      frame(chat, { gone: true })
      chats.delete(chat.shellId)
      stopTimerIfIdle()
      return
    }
    const target = await resolve(chat.shellId)
    if (!live(chat)) return
    // The agent's folder: relative links in its answers ("docs/x.md") are read against it
    if (target?.cwd) chat.cwd = target.cwd
    // The agent's prompt with choices (or its end), sent when it changes
    const approval = target?.approval ?? null
    if ((approval?.signature ?? null) !== chat.approval) {
      chat.approval = approval?.signature ?? null
      frame(chat, { approval })
    }
    if (!target) {
      setState(chat, 'ended')
      return
    }
    const file = await fileFor(chat, target)
    if (!live(chat)) return
    if (!file) {
      setState(chat, 'waiting')
      return
    }
    if (file !== chat.file || target.kind !== chat.kind) return load(chat, file, target.kind)
    if (chat.state !== 'live') setState(chat, 'live')
    return follow(chat)
  }

  /** One read at a time per chat, in order */
  function run(chat, work) {
    chat.chain = chat.chain.then(() => (live(chat) ? work() : undefined)).catch(() => {
      // A file that went away or cannot be read: looked for again on the next tick
      if (live(chat)) chat.file = null
    })
    return chat.chain
  }

  function tick() {
    for (const chat of chats.values()) {
      if (chat.pending) continue
      chat.pending = true
      void run(chat, () => sync(chat)).finally(() => { chat.pending = false })
    }
  }

  function startTimer() {
    if (timer || !chats.size) return
    timer = setInterval(tick, tickMs)
    timer.unref?.()
  }

  function stopTimerIfIdle() {
    if (timer && !chats.size) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    /** Starts following; what is read comes as frames. Opening a shell's view again starts it over. */
    open(shellId) {
      if (!chats.has(shellId) && chats.size >= MAX_CHATS) return { ok: false, error: `채팅 보기는 ${MAX_CHATS}개까지 열 수 있습니다.` }
      const chat = { shellId, chain: Promise.resolve(), pending: false, file: null, kind: null, parser: null, state: null, title: null, lookup: null, approval: null, links: new Set() }
      chats.set(shellId, chat)
      startTimer()
      chat.pending = true
      void run(chat, () => sync(chat)).finally(() => { chat.pending = false })
      return { ok: true }
    },
    /** The part of the file before what the view has */
    older(shellId) {
      const chat = chats.get(shellId)
      if (!chat) return Promise.resolve()
      return run(chat, async () => {
        if (!chat.file || !(chat.oldest > 0)) return
        const start = Math.max(0, chat.oldest - OLDER_BYTES)
        let buffer = await readRange(chat.file, start, chat.oldest)
        let oldest = start
        if (start > 0) {
          const first = buffer.indexOf(10)
          buffer = first === -1 ? Buffer.alloc(0) : buffer.subarray(first + 1)
          oldest = first === -1 ? chat.oldest : start + first + 1
        }
        // The part ends where the view's first line starts: every line in it is complete
        const lines = completeLines(Buffer.concat([buffer, Buffer.from('\n')])).lines
        const items = []
        for (const line of lines) items.push(...chat.parser.feed(line, { older: true }).items)
        if (!live(chat)) return
        chat.oldest = oldest
        frame(chat, { older: true, items: latestById(items), hasOlder: oldest > 0 })
      })
    },
    close(shellId) {
      chats.delete(shellId)
      stopTimerIfIdle()
    },
    /** App locked or quitting: stop following everything */
    closeAll() {
      chats.clear()
      stopTimerIfIdle()
    },
    /** Whether a link (linkTarget's key) was in an answer this shell's view was sent */
    knowsLink: (shellId, key) => chats.get(shellId)?.links.has(key) === true,
    /** The folder of the shell's agent (relative links are read against it), or null */
    cwdOf: shellId => chats.get(shellId)?.cwd ?? null,
    count: () => chats.size,
    tick
  }
}

module.exports = { createAgentChats, claudeFolderName, findClaudeFile, completeLines, latestById, MAX_CHATS }
