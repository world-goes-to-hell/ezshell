const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('node:crypto')
const { createClaudeParser } = require('./claudeTranscript.js')
const { createClaudeShellTracker } = require('./claudeShells.js')
const { createCodexParser } = require('./codexTranscript.js')
const { createAntigravityParser } = require('./antigravityTranscript.js')
const { antigravityBrainRoot, antigravitySessionId, openAntigravityTranscript } = require('./antigravitySessions.js')
const { createInterface } = require('node:readline')
const { createInboxQuestionReader } = require('./inboxQuestions.js')
const { createSubagentTracker } = require('./subagents.js')
const { createSubagentPreview } = require('./subagentPreview.js')
const { linkKeysIn } = require('./links.js')
const { oneLine } = require('./items.js')
const { readLinesFromStart, readLinesFromEnd } = require('../agentHistory/boundedRead.js')

// The chat views that are open (one per shell), each following its agent's transcript file: on
// opening the last part of the file, then what is appended, and earlier parts when the view scrolls
// up. Files are read in bounded parts only (one transcript can be tens of MB) and nothing is kept on
// disk. Frames go to the window as `agent-chat-frame`.

const FIRST_BYTES = 2 * 1024 * 1024
const OLDER_BYTES = 2 * 1024 * 1024
// A running task can precede several MB of tool output. Recover its state independently of the chat page.
const ACTIVITY_HISTORY_BYTES = 32 * 1024 * 1024
const ACTIVITY_LINES = {
  claude: /"(?:Agent|Task|TaskStop|KillShell|KillBash|Bash|PowerShell|Shell|tool_result)"|<task-notification>/,
  codex: /"(?:spawn_agent|wait_agent|function_call_output|sub_agent_activity|SubAgentActivity|CollabAgentToolCall|inter_agent_communication)"|<subagent_notification>/
}
/** Read per look when the file grew a lot (the rest comes on the next looks) */
const STEP_BYTES = 4 * 1024 * 1024
const TICK_MS = 500
/** How often a Claude transcript not found yet is looked for again */
const FIND_RETRY_MS = 3000
// How long a compaction notice waits for the /compact line written after it (claudeTranscript.js)
const NOTICE_WAIT_MS = 1500
const MAX_CHATS = 24
/** Chats followed for remote devices (a phone), all devices together, apart from the PC's */
const MAX_REMOTE_CHATS = 8
// A Claude question's limits use the status line reading this long after its last answer (the report
// comes after the answer is written), and are looked at again on the ticks for this long
const LIMIT_SETTLE_MS = 10 * 1000
const LIMIT_FOLLOW_MS = 2 * 60 * 1000
/** Links remembered per view (the latest) */
const MAX_LINKS = 2000
const MAX_COPY_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_COPY_TEXT_CHARS = 8 * 1024 * 1024
const MAX_QUESTIONS = 10_000
const QUESTION_LINES = { claude: /"user"|__read_inbox"/, codex: /"UserMessage"|"read_inbox"/ }
const QUESTION_CONTEXT_BEFORE = 256 * 1024
const QUESTION_CONTEXT_AFTER = 2 * 1024 * 1024
const COPY_KINDS = new Set(['user', 'assistant', 'notice', 'output'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PARSERS = new Map([
  ['claude', createClaudeParser], ['codex', createCodexParser], ['antigravity', createAntigravityParser]
])
const parserFor = kind => PARSERS.get(kind)?.()
const antigravityTranscriptId = sessionId => sessionId && createHash('sha256').update(`antigravity:${sessionId}`).digest('hex')

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

async function readRange(file, start, end, retainedHandle) {
  const handle = retainedHandle ?? await fs.promises.open(file, 'r')
  try {
    const length = Math.max(0, end - start)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    if (!retainedHandle) await handle.close()
  }
}

// A truncate and refill can grow past tail without changing the file's identity.
const anchorAt = (source, end) => readRange(source.file, Math.max(0, end - 128), end, source.handle)

async function readOpenedLines(source, onLine) {
  const input = source.handle.createReadStream({ start: 0, end: source.stat.size - 1, autoClose: false })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const raw of lines) {
      let value
      try { value = JSON.parse(raw) } catch { continue }
      if (value && typeof value === 'object' && onLine(value)) break
    }
  } finally {
    lines.close()
    input.destroy()
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

async function readClaudeChildResults(file, tracker, isLive) {
  const parent = file.slice(0, -'.jsonl'.length)
  for (const [id, child] of tracker.takeChildResults()) {
    if (!isLive()) return
    const lines = await readLinesFromEnd(path.join(parent, 'subagents', `agent-${child}.jsonl`)).catch(() => null)
    const answers = (lines ?? []).filter(line => line.type === 'assistant' && Array.isArray(line.message?.content))
    let lastMessageId = null
    const parts = []
    for (const line of answers.reverse()) {
      const blocks = line.message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
      if (!blocks.length) continue
      if (lastMessageId !== null && line.message.id !== lastMessageId) break
      parts.unshift(...blocks.map(block => block.text))
      lastMessageId = line.message.id ?? line.uuid
      if (!lastMessageId) break
    }
    if (parts.length) tracker.setChildResult(id, parts.join('\n'))
  }
}

/**
 * @param {object} deps
 * @param {(shellId: string) => Promise<{ kind: 'claude' | 'codex' | 'antigravity', status?: string, sessionId?: string | null, cwd?: string | null, file?: string | null, approval?: object | null, backgroundShellCount?: number | null, codexSpeed?: { speed: string | null, ultrafastAvailable: boolean } | null } | null>} deps.resolve
 *   the agent running in a shell now (null when there is none), with the prompt it shows if any
 * @param {(channel: string, payload: object) => void} deps.send to the main window
 * @param {string} deps.claudeRoot `$CLAUDE_CONFIG_DIR` or `~/.claude`
 * @param {(shellId: string) => boolean} deps.isGone the shell is closed (not just its agent ended)
 * @param {(from: number, to: number, profileId?: string) => object | undefined} [deps.claudeLimits] Claude's before and after
 *   usage rates and their increase from status line reports (limitHistory.js)
 */
function createAgentChats({ resolve, send, claudeRoot, antigravityRoot = antigravityBrainRoot(), isGone = () => false, claudeLimits = null, tickMs = TICK_MS, now = () => Date.now() }) {
  // The PC window's chats are keyed by the shell id; a remote device's by shell and viewer, so the
  // PC's view and a phone's follow the same transcript each at its own pace (opening one never
  // starts the other over). Lookups by shell id alone (links, questions, copy) are the PC's.
  const chats = new Map()
  let timer = null

  const keyOf = (shellId, viewer) => (viewer ? `${shellId}\u0000${viewer}` : shellId)
  const live = chat => chats.get(chat.key) === chat

  /** A question's usage as the view gets it: Claude's limits added, the time it was worked out from left out */
  function viewUsage(chat, item) {
    const { lastAt, ...usage } = item.usage
    if (chat.kind !== 'claude' || !claudeLimits || item.time === null || lastAt === undefined) return usage
    const limits = claudeLimits(item.time, lastAt + LIMIT_SETTLE_MS, chat.claudeProfileId)
    return limits ? { ...usage, limits } : usage
  }

  function withUsage(chat, items, older) {
    return items.map(item => {
      if (!item.usage) return item
      // The latest question: its limits are looked at again while the status line catches up
      if (!older && (!chat.lastTurn || (item.time ?? 0) >= (chat.lastTurn.time ?? 0))) chat.lastTurn = item
      const usage = viewUsage(chat, item)
      if (item === chat.lastTurn) chat.lastTurnLimits = JSON.stringify(usage.limits ?? null)
      return { ...item, usage }
    })
  }

  /** The latest Claude question again when a later status line report changed what it took */
  function refreshLimits(chat) {
    const turn = chat.lastTurn
    if (chat.kind !== 'claude' || !claudeLimits || !turn?.usage?.lastAt || now() - turn.usage.lastAt > LIMIT_FOLLOW_MS) return
    if (JSON.stringify(viewUsage(chat, turn).limits ?? null) !== chat.lastTurnLimits) frame(chat, { items: [turn] })
  }

  /** Only links in messages shown by this chat may be opened from it. */
  function rememberLinks(chat, items) {
    for (const item of items) {
      if (item.kind !== 'assistant') continue
      for (const key of linkKeysIn(item.text, process.platform, chat.cwd)) {
        chat.links.delete(key)
        chat.links.add(key)
        if (chat.links.size > MAX_LINKS) chat.links.delete(chat.links.values().next().value)
      }
    }
  }

  function frame(chat, fields) {
    if (!live(chat)) return
    if (fields.reset) {
      chat.lastTurn = null
      chat.links.clear()
    }
    if (fields.items) {
      fields = { ...fields, items: withUsage(chat, fields.items, fields.older) }
      rememberLinks(chat, fields.items)
    }
    if (chat.onFrame) chat.onFrame({ shellId: chat.shellId, ...fields })
    else send('agent-chat-frame', { shellId: chat.shellId, ...fields })
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
    const root = target.claudeProfileId ? target.claudeRoot : claudeRoot
    if (!root) return null
    const file = await findClaudeFile(root, target.cwd, target.sessionId)
    chat.lookup = { sessionId: target.sessionId, file, at: now() }
    return file
  }

  async function currentAntigravitySource(chat) {
    const { sessionId, file, identity, subagentScope, tail, anchor } = chat
    const source = await openAntigravityTranscript(antigravityRoot, sessionId, file)
    if (!source) return null
    try {
      if (source.identity === identity && source.stat.size >= tail && anchor?.equals(await anchorAt(source, tail))
        && live(chat) && chat.file === file && chat.subagentScope === subagentScope) return source
    } catch { /* The reader will pick up the new file on the next tick. */ }
    await source.handle.close()
    return null
  }

  /** Starts over on a (new) file: its last part */
  async function load(chat, file, kind, source) {
    const { size } = source?.stat ?? await fs.promises.stat(file)
    const start = Math.max(0, size - FIRST_BYTES)
    let buffer = await readRange(file, start, size, source?.handle)
    let oldest = start
    if (start > 0) {
      // The window starts inside a line: that line belongs to the part before
      const first = buffer.indexOf(10)
      buffer = first === -1 ? Buffer.alloc(0) : buffer.subarray(first + 1)
      oldest = first === -1 ? size : start + first + 1
    }
    const parser = parserFor(kind)
    const subagents = kind === 'antigravity' ? null : createSubagentTracker(kind)
    const shellTracker = kind === 'claude' ? createClaudeShellTracker() : null
    if (oldest > 0 && subagents) {
      const start = Math.max(0, size - ACTIVITY_HISTORY_BYTES)
      await readLinesFromStart(file, line => {
        if (!live(chat)) return true
        subagents.feed(line)
        shellTracker?.feed(line)
      }, { start, end: oldest - 1, maxBytes: oldest - start, maxLine: STEP_BYTES, matchLine: line => ACTIVITY_LINES[kind].test(line) }).catch(() => {})
    }
    const { lines, used } = completeLines(buffer)
    const items = []
    let title
    for (const line of lines) {
      subagents?.feed(line)
      shellTracker?.feed(line)
      const result = parser.feed(line)
      items.push(...result.items)
      title = result.title ?? title
    }
    // A compaction notice the part read ends with (claudeTranscript.js holds it for the command after it)
    items.push(...(parser.flush?.(0) ?? []))
    if (kind === 'claude') await readClaudeChildResults(file, subagents, () => live(chat))
    const tail = oldest + used
    const anchor = source ? await anchorAt(source, tail) : null
    if (!live(chat)) return
    const transcriptId = source ? antigravityTranscriptId(chat.sessionId) : createHash('sha256').update(file).digest('hex')
    Object.assign(chat, { file, kind, parser, subagents, shellTracker, previewChild: subagents ? createSubagentPreview(file, kind, now) : null,
      subagentScope: randomUUID(), transcriptId, oldest, tail, anchor, identity: source?.identity, skipping: false, title: title ?? null, state: 'live' })
    chat.questionIndex = null
    frame(chat, { reset: true, scope: chat.subagentScope, transcriptId, kind, state: 'live', items: latestById(items), subagents: subagents?.snapshot(true) ?? [], title: title ?? null, hasOlder: oldest > 0 })
  }

  async function indexQuestions(chat, file, scope, tail) {
    const kind = chat.kind
    const parser = parserFor(kind)
    const readInboxQuestions = createInboxQuestionReader(kind)
    const anchors = new Map()
    let limited = false
    const add = (question, offset, bytes, call) => {
      anchors.set(question.id, { question, offset, bytes, call })
      if (anchors.size > MAX_QUESTIONS) {
        anchors.delete(anchors.keys().next().value)
        limited = true
      }
    }
    if (tail > 0) await readLinesFromStart(file, (line, offset, bytes) => {
      if (!live(chat) || chat.file !== file || chat.subagentScope !== scope) return true
      const userLine = kind === 'claude' ? line.type === 'user'
        : line.type === 'event_msg' && line.payload?.type === 'item_completed' && line.payload.item?.type === 'UserMessage'
      if (userLine) {
        for (const item of parser.feed(line).items) {
          if (item.kind !== 'user' || item.inboxNotice) continue
          add({ id: item.id, time: item.time, text: oneLine(item.text || '스크린샷 첨부', 280) }, offset, bytes)
        }
      }
      for (const { call, ...message } of readInboxQuestions(line, offset, bytes)) {
        if (!anchors.has(message.id)) add(message, offset, bytes, call)
      }
    }, { end: tail - 1, maxBytes: tail, maxLine: STEP_BYTES, matchLine: line => QUESTION_LINES[kind].test(line) })
    return { anchors, limited }
  }

  function questionIndex(chat, refresh = true) {
    const { file, subagentScope: scope, tail } = chat
    const index = chat.questionIndex
    if (index?.scope === scope && (!refresh || index.tail === tail)) return index.pending
    const pending = indexQuestions(chat, file, scope, tail).catch(error => {
      if (chat.questionIndex?.pending === pending) chat.questionIndex = null
      throw error
    })
    chat.questionIndex = { scope, tail, pending }
    return pending
  }

  async function follow(chat, source) {
    const { size } = source?.stat ?? await fs.promises.stat(chat.file)
    if (size < chat.tail || (source && !chat.anchor?.equals(await anchorAt(source, chat.tail)))) {
      return load(chat, chat.file, chat.kind, source)
    }
    if (size === chat.tail) {
      // Nothing new: a compaction notice held for its /compact line comes out after a while anyway
      const late = chat.parser.flush?.(NOTICE_WAIT_MS) ?? []
      if (late.length) frame(chat, { items: late })
      refreshLimits(chat)
      return
    }
    let buffer = await readRange(chat.file, chat.tail, Math.min(size, chat.tail + STEP_BYTES), source?.handle)
    if (!live(chat)) return
    if (chat.skipping) {
      // Inside a line longer than a whole step: skip to its end
      const end = buffer.indexOf(10)
      if (end === -1) {
        chat.tail += buffer.length
        if (source) chat.anchor = await anchorAt(source, chat.tail)
        return
      }
      chat.tail += end + 1
      chat.skipping = false
      buffer = buffer.subarray(end + 1)
    }
    const { lines, used } = completeLines(buffer)
    if (!used && buffer.length >= STEP_BYTES) {
      chat.tail += buffer.length
      chat.skipping = true
      if (source) chat.anchor = await anchorAt(source, chat.tail)
      return
    }
    chat.tail += used
    if (source) chat.anchor = await anchorAt(source, chat.tail)
    const items = []
    let title = chat.title
    for (const line of lines) {
      chat.subagents?.feed(line)
      chat.shellTracker?.feed(line)
      const result = chat.parser.feed(line)
      items.push(...result.items)
      title = result.title ?? title
    }
    items.push(...(chat.parser.flush?.(NOTICE_WAIT_MS) ?? []))
    if (chat.kind === 'claude') await readClaudeChildResults(chat.file, chat.subagents, () => live(chat))
    const subagents = chat.subagents?.snapshot()
    const renamed = title !== chat.title
    chat.title = title
    if (items.length || renamed || subagents) frame(chat, {
      ...(items.length ? { items: latestById(items) } : {}),
      ...(renamed ? { title } : {}),
      ...(subagents ? { subagents } : {})
    })
  }

  function syncShells(chat, observed = null, jobs = []) {
    const count = observed ?? jobs.length
    // The CLI can remove a shell from its footer before writing its completion to the transcript.
    const backgroundShells = count > 0 ? { count, jobs: count >= jobs.length ? jobs : [] } : null
    const signature = backgroundShells && JSON.stringify(backgroundShells)
    if (chat.backgroundShells === signature) return
    chat.backgroundShells = signature
    frame(chat, { backgroundShells })
  }

  function resetTranscript(chat, kind, sessionId, state) {
    const transcriptId = kind === 'antigravity' ? antigravityTranscriptId(sessionId) : null
    Object.assign(chat, { kind, sessionId, state, file: null, identity: null, anchor: null,
      parser: null, subagents: null, previewChild: null, shellTracker: null, subagentScope: null,
      transcriptId, title: null, oldest: 0, tail: 0, questionIndex: null, lookup: null })
    frame(chat, { reset: true, ...(kind ? { kind } : {}), ...(transcriptId ? { transcriptId } : {}), state, items: [], subagents: [], title: null, hasOlder: false })
  }

  async function syncAntigravity(chat, target) {
    const sessionId = antigravitySessionId(target.sessionId)
    const source = await openAntigravityTranscript(antigravityRoot, sessionId)
    try {
      if (!live(chat)) return
      const changed = chat.kind !== target.kind || chat.sessionId !== sessionId
      if (!source) {
        if (changed || chat.file) resetTranscript(chat, target.kind, sessionId, 'waiting')
        else setState(chat, 'waiting')
        return
      }
      chat.sessionId = sessionId
      if (changed || source.file !== chat.file || source.identity !== chat.identity) await load(chat, source.file, target.kind, source)
      else {
        setState(chat, 'live')
        await follow(chat, source)
      }
    } finally {
      await source?.handle.close()
    }
  }

  async function sync(chat) {
    if (isGone(chat.shellId)) {
      // The shell was closed (its tab or pane): nothing more to follow
      frame(chat, { gone: true })
      chats.delete(chat.key)
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
    const codexSpeed = target?.codexSpeed ?? null
    if (codexSpeed?.speed !== chat.codexSpeed?.speed || codexSpeed?.ultrafastAvailable !== chat.codexSpeed?.ultrafastAvailable) {
      chat.codexSpeed = codexSpeed
      frame(chat, { codexSpeed })
    }
    const status = target?.kind === 'antigravity' ? target.status ?? 'unknown' : null
    if (status !== chat.status) {
      chat.status = status
      frame(chat, { status })
    }
    if (!target) {
      if (chat.state === 'live' && chat.file && chat.kind !== 'antigravity') await follow(chat).catch(() => {})
      if (!live(chat)) return
      syncShells(chat)
      setState(chat, 'ended')
      return
    }
    if (!PARSERS.has(target.kind)) {
      if (chat.kind || chat.file) resetTranscript(chat, null, null, 'ended')
      else setState(chat, 'ended')
      return
    }
    if (target.kind === 'antigravity') {
      syncShells(chat)
      await syncAntigravity(chat, target)
      return
    }
    if (chat.kind === 'antigravity') resetTranscript(chat, target.kind, null, 'waiting')
    const sessionId = target.sessionId ?? null
    const changed = chat.kind && (chat.kind !== target.kind || chat.claudeProfileId !== target.claudeProfileId ||
      (sessionId && chat.sessionId && sessionId !== chat.sessionId))
    if (chat.claudeProfileId !== target.claudeProfileId) chat.lookup = null
    chat.claudeProfileId = target.claudeProfileId
    const file = await fileFor(chat, target)
    if (!live(chat)) return
    if (!file) {
      syncShells(chat, target.backgroundShellCount)
      if (changed) resetTranscript(chat, target.kind, sessionId, 'waiting')
      else setState(chat, 'waiting')
      return
    }
    chat.sessionId = sessionId ?? (changed ? null : chat.sessionId)
    if (changed || file !== chat.file || target.kind !== chat.kind) await load(chat, file, target.kind)
    else {
      if (chat.state !== 'live') setState(chat, 'live')
      await follow(chat)
    }
    if (live(chat)) syncShells(chat, target.backgroundShellCount, chat.shellTracker?.running())
  }

  /** One read at a time per chat, in order */
  function run(chat, work) {
    chat.chain = chat.chain.then(() => (live(chat) ? work() : undefined)).catch(() => {
      // A file that went away or cannot be read: looked for again on the next tick
      if (live(chat)) {
        chat.file = null
        if (chat.state === 'live') setState(chat, 'waiting')
      }
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
    /**
     * Starts following; what is read comes as frames. Opening a shell's view again starts it over.
     * A remote device passes its `viewer` key and `onFrame`: its frames go there, not to the window.
     */
    open(shellId, { viewer = null, onFrame = null } = {}) {
      const key = keyOf(shellId, viewer)
      if (!chats.has(key)) {
        const remote = [...chats.values()].filter(chat => chat.viewer).length
        if (viewer && remote >= MAX_REMOTE_CHATS) return { ok: false, error: `휴대폰에서는 채팅을 ${MAX_REMOTE_CHATS}개까지 열 수 있습니다.` }
        if (!viewer && chats.size - remote >= MAX_CHATS) return { ok: false, error: `채팅 보기는 ${MAX_CHATS}개까지 열 수 있습니다.` }
      }
      const chat = { shellId, key, viewer, onFrame: viewer ? onFrame : null, chain: Promise.resolve(), pending: false, file: null, kind: null, parser: null, state: null, status: null, title: null, lookup: null, approval: null, codexSpeed: null, backgroundShells: null, links: new Set() }
      chats.set(key, chat)
      startTimer()
      chat.pending = true
      void run(chat, () => sync(chat)).finally(() => { chat.pending = false })
      return { ok: true }
    },
    /** The part of the file before what the view has (its frame is sent before the promise settles) */
    older(shellId, viewer = null) {
      const chat = chats.get(keyOf(shellId, viewer))
      if (!chat) return Promise.resolve()
      return run(chat, async () => {
        if (!chat.file || !(chat.oldest > 0)) return
        const start = Math.max(0, chat.oldest - OLDER_BYTES)
        const source = chat.kind === 'antigravity' ? await currentAntigravitySource(chat) : null
        if (chat.kind === 'antigravity' && !source) return
        let buffer
        try { buffer = await readRange(chat.file, start, chat.oldest, source?.handle) }
        finally { await source?.handle.close() }
        let oldest = start
        if (start > 0) {
          const first = buffer.indexOf(10)
          buffer = first === -1 ? Buffer.alloc(0) : buffer.subarray(first + 1)
          oldest = first === -1 ? chat.oldest : start + first + 1
        }
        // The part ends where the view's first line starts: every line in it is complete
        const lines = completeLines(Buffer.concat([buffer, Buffer.from('\n')])).lines
        const items = []
        // The part's last question gets the usage lines that open the part after it (turnUsage.js)
        chat.parser.beginOlder?.()
        for (const line of lines) items.push(...chat.parser.feed(line, { older: true }).items)
        items.push(...(chat.parser.endOlder?.() ?? []))
        if (!live(chat)) return
        chat.oldest = oldest
        frame(chat, { older: true, items: latestById(items), hasOlder: oldest > 0 })
      })
    },
    async questions(shellId) {
      const chat = chats.get(shellId)
      if (!chat?.file || !QUESTION_LINES[chat.kind]) return { ok: true, scope: null, questions: [], limited: false }
      const { file, subagentScope: scope } = chat
      try {
        const { anchors, limited } = await questionIndex(chat)
        if (live(chat) && chat.file === file && chat.subagentScope === scope) {
          const questions = [...anchors.values()].reverse().map(({ question }) => question)
          return { ok: true, scope, questions, limited }
        }
      } catch { /* transcript unavailable */ }
      return { ok: false, error: '질문 목록을 읽을 수 없습니다.' }
    },
    async questionContext(shellId, scope, id) {
      const chat = chats.get(shellId)
      if (!chat?.file || !QUESTION_LINES[chat.kind] || scope !== chat.subagentScope) return { ok: false, error: '대화가 바뀌었습니다. 질문 목록을 다시 열어 주세요.' }
      const { file, kind } = chat
      try {
        const { anchors } = await questionIndex(chat, false)
        const anchor = anchors.get(id)
        if (anchor && live(chat) && chat.file === file && scope === chat.subagentScope) {
          const start = Math.max(0, anchor.offset - QUESTION_CONTEXT_BEFORE)
          let buffer = await readRange(file, start, Math.min(chat.tail, anchor.offset + anchor.bytes + QUESTION_CONTEXT_AFTER))
          if (start > 0) buffer = buffer.subarray(buffer.indexOf(10) + 1)
          const parser = parserFor(kind)
          // A Claude tool call can be outside this window. Prime the parser so it emits the
          // original tool card where the result was read.
          const call = anchor.call
          if (call && start > 0 && call.offset <= start) {
            const line = await readRange(file, call.offset, call.offset + call.bytes)
            parser.feed(JSON.parse(line.toString('utf8')))
          }
          const items = []
          for (const line of completeLines(buffer).lines) items.push(...parser.feed(line).items)
          items.push(...(parser.flush?.(0) ?? []))
          const parsed = latestById(items)
          const at = parsed.findIndex(item => item.id === (anchor.question.itemId ?? id))
          if (at >= 0 && live(chat) && chat.file === file && scope === chat.subagentScope) {
            const context = withUsage(chat, parsed.slice(Math.max(0, at - 20), at + 101), true)
            rememberLinks(chat, context)
            return { ok: true, scope, items: context }
          }
        }
      } catch { /* transcript unavailable */ }
      return { ok: false, error: '선택한 질문 위치를 불러올 수 없습니다.' }
    },
    async subagentPreview(shellId, agentId) {
      const chat = chats.get(shellId)
      const tracker = chat?.subagents
      const child = tracker?.childOf(agentId)
      if (!chat?.file || !child) return []
      const activity = await chat.previewChild(child)
      return live(chat) && chat.subagents === tracker && tracker.childOf(agentId) ? activity : []
    },
    async subagentConversation(shellId, agentId) {
      const chat = chats.get(shellId)
      const tracker = chat?.subagents
      const child = tracker?.childOf(agentId)
      if (!chat?.file || !child) return null
      const [identity, messages] = await Promise.all([chat.previewChild.identity(child), chat.previewChild.conversation(child)])
      if (!live(chat) || chat.subagents !== tracker || !tracker.childOf(agentId)) return null
      return { kind: chat.kind, child, identity, messages, live: chat.state === 'live', scope: chat.subagentScope }
    },
    hasSubagentScope(shellId, scope) {
      const chat = chats.get(shellId)
      return Boolean(chat?.file && chat.subagents && chat.state === 'live' && chat.subagentScope === scope)
    },
    hasTranscript(shellId, transcriptId) {
      const chat = chats.get(shellId)
      return Boolean(chat?.file && chat.state === 'live' && chat.transcriptId === transcriptId)
    },
    /** Recheck the tail without moving the reader. Undefined means the transcript could not be checked. */
    async findRecordedSend(shellId, { transcriptId, acceptedAt, ignoreIds, text, hasImage }) {
      const chat = chats.get(shellId)
      if (!chat?.file || chat.state !== 'live' || chat.transcriptId !== transcriptId) return undefined
      const { file, kind, subagentScope } = chat
      let source
      try {
        const { matchesEchoText } = await import('./echoText.mjs')
        let lines
        if (kind === 'antigravity') {
          source = await currentAntigravitySource(chat)
          if (!source) return undefined
          const start = Math.max(0, source.stat.size - FIRST_BYTES)
          let buffer = await readRange(file, start, source.stat.size, source.handle)
          if (start) {
            const first = buffer.indexOf(10)
            buffer = first < 0 ? Buffer.alloc(0) : buffer.subarray(first + 1)
          }
          lines = completeLines(buffer).lines
        } else lines = await readLinesFromEnd(file, { maxBytes: FIRST_BYTES })
        if (!lines || !live(chat) || chat.file !== file || chat.subagentScope !== subagentScope || chat.state !== 'live') return undefined
        const parser = parserFor(kind)
        const ignored = new Set(ignoreIds)
        const expected = { text, hasImage }
        let approximate = null
        for (const line of lines) {
          for (const item of parser.feed(line).items) {
            // The CLI can record just before the renderer receives acknowledgement or round timestamps.
            if (item.kind !== 'user' || item.time === null || item.time < acceptedAt - 1000 || ignored.has(item.id)) continue
            if (matchesEchoText(item, expected, false)) return item
            if (!approximate && matchesEchoText(item, expected, true)) approximate = item
          }
        }
        return approximate
      } catch { return undefined }
      finally { await source?.handle.close() }
    },
    /** Read a snapshot of the conversation without widening or moving the window's current view. */
    async transcriptForCopy(shellId) {
      const chat = chats.get(shellId)
      if (!chat) return { ok: false, error: '열려 있는 채팅을 찾을 수 없습니다.' }
      const { file, kind, subagentScope } = chat
      if (!file) return { ok: true, items: [] }
      const tooLarge = { ok: false, error: '한 번에 복사하기에는 대화 기록이 너무 큽니다.' }
      const parser = parserFor(kind)
      if (!parser) return { ok: false, error: '지원하지 않는 대화 기록입니다.' }
      const items = new Map()
      let chars = 0
      const add = entries => {
        for (const item of entries) {
          if (!COPY_KINDS.has(item.kind) || (!item.text && !item.hasImage)) continue
          const previous = items.get(item.id)
          chars += (item.text?.length ?? 0) - (previous?.text?.length ?? 0) + (previous ? 0 : 16)
          if (chars > MAX_COPY_TEXT_CHARS) return true
          items.set(item.id, item)
        }
        return false
      }
      let source
      try {
        source = kind === 'antigravity' ? await currentAntigravitySource(chat) : null
        if (kind === 'antigravity' && !source) return { ok: false, error: '대화 기록을 읽을 수 없습니다.' }
        const { size } = source?.stat ?? await fs.promises.stat(file)
        if (!size) return { ok: true, items: [] }
        if (size > MAX_COPY_SOURCE_BYTES) return tooLarge
        const current = () => live(chat) && chat.file === file && chat.subagentScope === subagentScope
        const read = line => !current() || add(parser.feed(line).items)
        if (source) await readOpenedLines(source, read)
        else await readLinesFromStart(file, read, { end: size - 1, maxBytes: size, maxLine: size })
        if (!current()) return { ok: false, error: '채팅이 바뀌었습니다. 다시 복사해 주세요.' }
        if (chars > MAX_COPY_TEXT_CHARS || add(parser.flush?.() ?? [])) return tooLarge
        return { ok: true, items: [...items.values()] }
      } catch {
        return { ok: false, error: '대화 기록을 읽을 수 없습니다.' }
      } finally { await source?.handle.close() }
    },
    close(shellId, viewer = null) {
      chats.delete(keyOf(shellId, viewer))
      stopTimerIfIdle()
    },
    /** A remote device went away: every chat it followed stops */
    closeViewer(viewer) {
      if (!viewer) return
      for (const [key, chat] of chats) if (chat.viewer === viewer) chats.delete(key)
      stopTimerIfIdle()
    },
    /** Whether that device follows the shell's chat now */
    isOpen: (shellId, viewer = null) => chats.has(keyOf(shellId, viewer)),
    /** App locked or quitting: stop following everything */
    closeAll() {
      chats.clear()
      stopTimerIfIdle()
    },
    /** Whether a link (linkTarget's key) was in an answer this shell's view was sent */
    knowsLink: (shellId, key) => chats.get(shellId)?.links.has(key) === true,
    /** Keep an in-flight read tied to the same chat, transcript scope and working folder. */
    linkAuthority(shellId, key) {
      const chat = chats.get(shellId)
      const scope = chat?.subagentScope
      const cwd = chat?.cwd
      return () => Boolean(chat && chats.get(shellId) === chat && chat.subagentScope === scope
        && chat.cwd === cwd && chat.links.has(key))
    },
    /** The folder of the shell's agent (relative links are read against it), or null */
    cwdOf: shellId => chats.get(shellId)?.cwd ?? null,
    /** A Claude AskUserQuestion of the shell's conversation not answered yet (`tool:<id>`): its questions, or null */
    pendingQuestion: (shellId, itemId) => {
      const chat = chats.get(shellId)
      return chat?.kind === 'claude' ? chat.parser?.question?.(itemId) ?? null : null
    },
    count: () => [...chats.values()].filter(chat => !chat.viewer).length,
    tick
  }
}

module.exports = { createAgentChats, claudeFolderName, findClaudeFile, completeLines, latestById, MAX_CHATS, MAX_REMOTE_CHATS }
