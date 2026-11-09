// The server files open in file windows (one window per file). main.js creates the window and
// passes every request here with the id of the window it came from: a window only reaches its own file.
// Saving: the window asks for a review (the diff it shows), then saves exactly the reviewed text.
// The server file is backed up on this PC first, and only overwritten when it is still what was opened.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const crypto = require('crypto')
const remoteFile = require('../mcp/remoteFile.js')
const { describeChange } = require('../mcp/fileEdit.js')
const { previewKind } = require('./fileKind.js')
const read = require('./remoteRead.js')
const { backupTarget } = require('./backups.js')
const { pollTail, startTail } = require('./logTail.js')

const MAX_DIFF_LINES = 3000
// A look at a followed log that gets no answer this long is given up (a half-dead connection)
const TAIL_TIMEOUT_MS = 30000
const MAX_OPEN_DOCUMENTS = 20
// 'tail' is a text preview that follows the end of the file ("실시간 보기")
const MODES = new Set(['edit', 'preview', 'tail'])

const MESSAGES = {
  gone: '이 파일 창의 정보가 없습니다. 창을 닫고 다시 열어 주세요.',
  readOnly: '이 파일을 쓸 권한이 없습니다 (읽기 전용으로 열림).',
  notReviewed: '저장할 내용을 다시 확인해 주세요.',
  busy: '저장하는 중입니다.',
  tooLarge: `저장할 수 있는 내용은 ${read.EDIT_MAX_BYTES / 1024 / 1024}MB 까지입니다.`,
  backupFailed: 'PC 에 백업을 만들지 못해 저장하지 않았습니다.',
  conflict: '연 뒤에 서버의 파일이 바뀌어 저장하지 않았습니다.',
  noConnection: '탭의 SSH 연결이 없습니다.',
  channelRefused: '서버가 파일 창용 채널을 열어 주지 않았습니다 (연결당 채널 수 제한). 분할 터미널이나 다른 창을 닫은 뒤 다시 시도해 주세요.',
  slow: '서버가 30초 동안 답하지 않았습니다.',
  noBackup: '백업을 읽지 못했습니다.',
  notFollowable: '텍스트 미리보기에서만 실시간으로 볼 수 있습니다.',
  tooMany: `파일 창은 ${MAX_OPEN_DOCUMENTS}개까지 열 수 있습니다. 다른 창을 닫아 주세요.`
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** The diff to show, cut to a size the window can draw (the counts stay exact). */
function reviewOf(before, after) {
  const change = describeChange(before, after)
  let budget = MAX_DIFF_LINES
  const hunks = []
  for (const hunk of change.hunks) {
    if (budget <= 0) break
    const lines = hunk.lines.slice(0, budget)
    budget -= lines.length
    hunks.push({ ...hunk, lines })
  }
  const shown = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const total = change.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  return { added: change.added, removed: change.removed, isWholeFile: Boolean(change.isWholeFile), hunks, truncated: shown < total }
}

class DocumentError extends Error {
  constructor(userMessage) {
    super(userMessage)
    this.userMessage = userMessage
  }
}

/**
 * `openSftp(sessionId)` resolves with a new SFTP channel on the tab's connection (rejects without one).
 * `serverOf(sessionId)` gives { username, host } for the backup folder. `backups` is a backup store.
 */
function createRemoteDocuments({ openSftp, serverOf, backups, newId = () => crypto.randomUUID(), tailTimeoutMs = TAIL_TIMEOUT_MS }) {
  const docs = new Map()
  // One SFTP channel per tab connection, shared by its file windows: a server allows only a few
  // channels per connection (OpenSSH MaxSessions, 10 by default) and the tab's shells need them too.
  // sessionId → { sftp, opening, users: Set<docId> }
  const channels = new Map()
  // Numbers the follow states, so a window says which answer it took in (see tail)
  let followSeq = 0
  // Saves still running, so closing a window waits for them before ending the channel
  const savings = new Map()

  function register({ sessionId, sessionName, remotePath, mode }) {
    if (typeof sessionId !== 'string' || !sessionId) throw new DocumentError(MESSAGES.noConnection)
    if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) throw new DocumentError(read.MESSAGES.notFound)
    if (!MODES.has(mode)) throw new DocumentError(MESSAGES.gone)
    const existing = [...docs.values()].find(doc => doc.sessionId === sessionId && doc.requestedPath === remotePath && doc.mode === mode)
    if (existing) return { docId: existing.docId, existing: true }
    if (docs.size >= MAX_OPEN_DOCUMENTS) throw new DocumentError(MESSAGES.tooMany)
    const docId = newId()
    docs.set(docId, {
      docId, sessionId, mode, requestedPath: remotePath,
      sessionName: typeof sessionName === 'string' ? sessionName.slice(0, 200) : '',
      // The server (user@host) is taken from main once, when the document is made
      server: serverOf(sessionId) || {},
      ownerId: null, seen: null, canWrite: false, review: null, isSaving: false,
      // Following the end of a text preview: { generation, committed, pending } and whether a look is running
      tail: null, isTailing: false
    })
    return { docId, existing: false }
  }

  function attach(docId, ownerId) {
    const doc = docs.get(docId)
    if (doc) docs.set(docId, { ...doc, ownerId })
  }

  /** The document of this window; anything else is refused. */
  function own(ownerId, docId) {
    const doc = docs.get(docId)
    if (!doc || doc.ownerId === null || doc.ownerId !== ownerId) throw new DocumentError(MESSAGES.gone)
    return doc
  }
  const patch = (docId, fields) => {
    const doc = docs.get(docId)
    if (doc) docs.set(docId, { ...doc, ...fields })
  }

  /** The tab's shared SFTP channel for this window, opened again after the connection came back. */
  async function sftpOf(doc) {
    if (!docs.has(doc.docId)) throw new DocumentError(MESSAGES.gone)
    const sessionId = doc.sessionId
    let entry = channels.get(sessionId)
    if (!entry) {
      entry = { sftp: null, opening: null, users: new Set() }
      channels.set(sessionId, entry)
    }
    entry.users.add(doc.docId)
    if (entry.sftp) return entry.sftp
    if (!entry.opening) entry.opening = openChannel(sessionId, entry)
    return entry.opening
  }

  function openChannel(sessionId, entry) {
    return openSftp(sessionId).then((sftp) => {
      // Every window of the tab closed while it was opening
      if (channels.get(sessionId) !== entry) {
        try { sftp.end() } catch { /* already closed */ }
        throw new DocumentError(MESSAGES.gone)
      }
      sftp.on?.('close', () => { if (entry.sftp === sftp) entry.sftp = null })
      entry.sftp = sftp
      return sftp
    }, (err) => {
      throw err instanceof DocumentError ? err : new DocumentError(err && err.code === 'NO_CONNECTION' ? MESSAGES.noConnection : MESSAGES.channelRefused)
    }).finally(() => { entry.opening = null })
  }

  /** The window no longer uses the channel; the last one of the tab ends it. */
  function releaseChannel(doc) {
    const entry = channels.get(doc.sessionId)
    if (!entry) return
    entry.users.delete(doc.docId)
    if (entry.users.size > 0) return
    channels.delete(doc.sessionId)
    try { entry.sftp?.end() } catch { /* already closed */ }
  }

  async function loadEdit(doc) {
    const sftp = await sftpOf(doc)
    const { seen, canWrite } = await read.readForEdit(sftp, doc.requestedPath)
    patch(doc.docId, { seen, canWrite, review: null })
    return { kind: 'text', editable: true, path: seen.path, content: seen.content, canWrite }
  }

  async function loadPreview(doc) {
    const sftp = await sftpOf(doc)
    const { kind, mime } = doc.mode === 'tail' ? { kind: 'text' } : previewKind(doc.requestedPath)
    if (kind === 'text') {
      // A followed log may hold NUL bytes (left by copytruncate): drop them instead of refusing the file
      const text = await read.readTextPreview(sftp, doc.requestedPath, { dropNul: doc.mode === 'tail' })
      // Following starts after what the window shows now; a refresh starts a new generation
      const generation = ++followSeq
      const committed = { ...startTail({ requestedPath: doc.requestedPath, path: text.path, size: text.size }), seq: generation }
      patch(doc.docId, { tail: { generation, committed, pending: null } })
      const follow = { generation, cursor: generation }
      return { kind, editable: false, path: text.path, content: text.text, truncated: text.truncated, size: text.size, follow }
    }
    const media = await read.readMedia(sftp, doc.requestedPath)
    return { kind, mime, path: media.path, size: media.size, data: media.data }
  }

  /** What the window shows: the text to edit, or the preview. Read again on every call ("새로고침"). */
  async function load(ownerId, docId) {
    const doc = own(ownerId, docId)
    const info = { sessionName: doc.sessionName, requestedPath: doc.requestedPath, mode: doc.mode }
    return { ...info, ...(doc.mode === 'edit' ? await loadEdit(doc) : await loadPreview(doc)) }
  }

  /**
   * One look at the end of a text preview: what was added since the last look. Looks never overlap
   * (a slow server gets one request at a time), and nothing is read while the file stays the same.
   *
   * Nothing is lost when the window drops an answer (paused meanwhile, or refreshed): each answer
   * carries a `cursor`, and the place moves on only when the next look names that cursor. Otherwise
   * the next look starts again from the last place the window took in. `generation` is from the
   * load the window shows; looks from before a refresh get 'stale'.
   */
  async function tail(ownerId, docId, { generation, cursor } = {}) {
    const doc = own(ownerId, docId)
    if (doc.mode === 'edit' || !doc.tail) throw new DocumentError(MESSAGES.notFollowable)
    if (generation !== doc.tail.generation) return { status: 'stale' }
    if (doc.isTailing) return { status: 'busy' }
    const { committed, pending } = doc.tail
    const base = pending && cursor === pending.seq ? pending : committed
    patch(docId, { isTailing: true })
    try {
      const sftp = await sftpOf(doc)
      const { result, state } = await withTimeout(pollTail(sftp, base), tailTimeoutMs)
      const next = { ...state, seq: ++followSeq }
      const latest = docs.get(docId)
      if (latest && latest.tail && latest.tail.generation === generation) {
        patch(docId, { tail: { generation, committed: base, pending: next } })
      }
      return { ...result, cursor: next.seq }
    } finally {
      patch(docId, { isTailing: false })
    }
  }

  function editable(ownerId, docId) {
    const doc = own(ownerId, docId)
    if (doc.mode !== 'edit' || !doc.seen) throw new DocumentError(MESSAGES.gone)
    return doc
  }

  /** The change a save would make, and the token that lets exactly this text be saved. */
  function review(ownerId, docId, content) {
    const doc = editable(ownerId, docId)
    if (typeof content !== 'string') throw new DocumentError(MESSAGES.notReviewed)
    if (Buffer.byteLength(content, 'utf8') > read.EDIT_MAX_BYTES) throw new DocumentError(MESSAGES.tooLarge)
    if (content === doc.seen.content) return { unchanged: true }
    // A fresh token per review: only a save that follows this review (and its dialog) can use it
    const token = crypto.randomUUID()
    patch(docId, { review: { token, hash: sha256(content), base: doc.seen } })
    return { unchanged: false, token, change: reviewOf(doc.seen.content, content) }
  }

  /**
   * Save the reviewed text: back up the server's content (which the write checks is unchanged),
   * then overwrite. A conflict leaves the file and removes the backup just made; older copies are
   * pruned only after a save went through. Each review is good for one save attempt.
   */
  async function save(ownerId, docId, content, token) {
    const doc = editable(ownerId, docId)
    if (!doc.canWrite) throw new DocumentError(MESSAGES.readOnly)
    if (doc.isSaving) throw new DocumentError(MESSAGES.busy)
    if (!doc.review || doc.review.base !== doc.seen || typeof content !== 'string' || token !== doc.review.token || sha256(content) !== doc.review.hash) {
      throw new DocumentError(MESSAGES.notReviewed)
    }
    patch(docId, { isSaving: true, review: null })
    const running = writeReviewed(doc, content)
    savings.set(docId, running)
    try {
      return await running
    } finally {
      savings.delete(docId)
      patch(docId, { isSaving: false })
    }
  }

  async function writeReviewed(doc, content) {
    const docId = doc.docId
    const sftp = await sftpOf(doc)
    const target = targetOf(doc)
    let backupName
    try {
      backupName = await backups.store.save(target, doc.seen.content)
    } catch {
      throw new DocumentError(MESSAGES.backupFailed)
    }
    let hasStarted = false
    try {
      await remoteFile.writeIfUnchanged(sftp, doc.seen, content, { maxBytes: read.EDIT_MAX_BYTES, onWriteStart: () => { hasStarted = true } })
    } catch (err) {
      // Nothing was written: the copy is not of a version that was replaced
      if (!hasStarted) await backups.store.remove(target, backupName).catch(() => {})
      if (err instanceof remoteFile.RemoteFileError && err.userMessage === remoteFile.MESSAGES.changed) {
        return { ok: false, conflict: true, message: MESSAGES.conflict }
      }
      throw err
    }
    await backups.store.prune(target, backupName).catch(() => {})
    patch(docId, { seen: { ...doc.seen, content }, review: null })
    return { ok: true, backupName }
  }

  const targetOf = (doc) => backupTarget(backups.root, { ...doc.server, sessionName: doc.sessionName }, doc.seen.path)

  async function listBackups(ownerId, docId) {
    const doc = editable(ownerId, docId)
    const target = targetOf(doc)
    return { folder: target.dir, backups: await backups.store.list(target) }
  }

  async function readBackup(ownerId, docId, name) {
    const doc = editable(ownerId, docId)
    const target = targetOf(doc)
    try {
      return { content: await backups.store.read(target, name) }
    } catch {
      throw new DocumentError(MESSAGES.noBackup)
    }
  }

  function backupFolder(ownerId, docId) {
    const doc = editable(ownerId, docId)
    return targetOf(doc).dir
  }

  /**
   * The window closed: forget the file at once (no further requests), and let go of the channel after
   * a save that is still writing has ended; ending it halfway could leave the server file cut short.
   */
  function close(docId) {
    const doc = docs.get(docId)
    if (!doc) return
    docs.delete(docId)
    const release = () => releaseChannel(doc)
    const running = savings.get(docId)
    if (running) void running.then(release, release)
    else release()
  }

  const find = (docId) => docs.get(docId) || null

  return { register, attach, load, tail, review, save, listBackups, readBackup, backupFolder, close, find }
}

/** `promise`, or a DocumentError once `ms` passed without an answer. */
function withTimeout(promise, ms) {
  let timer
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new DocumentError(MESSAGES.slow)), ms)
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

/** The message for the window: ours, the read and write modules' own, or a plain one. */
function userMessage(err) {
  if (err instanceof DocumentError) return err.userMessage
  return read.messageFor(err)
}

module.exports = { createRemoteDocuments, userMessage, DocumentError, MESSAGES, MAX_DIFF_LINES }
