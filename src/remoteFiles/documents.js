// File requests come with the id of their window. A window only reaches its own documents.
// Saving: the window asks for a review (the diff it shows), then saves exactly the reviewed text.
// The server file is backed up on this PC first, and only overwritten when it is still what was opened.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const crypto = require('crypto')
const nodePath = require('path')
const remoteFile = require('../mcp/remoteFile.js')
const { describeChange } = require('../mcp/fileEdit.js')
const { previewKind } = require('./fileKind.js')
const read = require('./remoteRead.js')
const configRefs = require('./configRefs.js')
const { backupTarget } = require('./backups.js')
const { pollTail, startTail } = require('./logTail.js')
const { listServerBackups: findServerBackups } = require('./serverBackups.js')

const MAX_DIFF_LINES = 3000
// A look at a followed log that gets no answer this long is given up (a half-dead connection)
const TAIL_TIMEOUT_MS = 30000
const MAX_OPEN_DOCUMENTS = 20
/** How long after a window was asked for, its loads still say how it opens (line, comparison) */
const OPEN_HINT_MS = 5000
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
  backupTooLarge: `백업은 ${read.EDIT_MAX_BYTES / 1024 / 1024}MB 까지 열 수 있습니다.`,
  notFollowable: '텍스트 미리보기에서만 실시간으로 볼 수 있습니다.',
  tooMany: `파일은 ${MAX_OPEN_DOCUMENTS}개까지 열 수 있습니다. 다른 탭이나 창을 닫아 주세요.`,
  localConflict: '연 뒤에 파일이 바뀌어 저장하지 않았습니다. 다시 불러온 뒤 고쳐 주세요.'
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
/**
 * `localFiles` (optional) opens files on this PC in the same windows: { read: src/localFiles/localRead.js,
 * fileAt(folder, path, revision?) → the file's text or null, fileHistory(folder, path) → revisions }.
 * The caller has checked the path (roots.js).
 */
function createRemoteDocuments({ openSftp, serverOf, backups, containerLogs = null, localFiles = null, newId = () => crypto.randomUUID(), tailTimeoutMs = TAIL_TIMEOUT_MS }) {
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

  /**
   * A container's log (src/containers/logs.js) shown in the same window as a followed file. It has
   * no file behind it: `container` names what is read, and the looks run a short command instead
   * of reading the end of a file. The caller has checked the name against the tab's container list.
   */
  function registerContainerLog({ sessionId, sessionName, container }) {
    if (typeof sessionId !== 'string' || !sessionId) throw new DocumentError(MESSAGES.noConnection)
    if (!containerLogs || typeof container !== 'string' || !container) throw new DocumentError(MESSAGES.gone)
    const existing = [...docs.values()].find(doc => doc.sessionId === sessionId && doc.container === container)
    if (existing) return { docId: existing.docId, existing: true }
    if (docs.size >= MAX_OPEN_DOCUMENTS) throw new DocumentError(MESSAGES.tooMany)
    const docId = newId()
    docs.set(docId, {
      docId, sessionId, mode: 'tail', container, requestedPath: `컨테이너/${container}`,
      sessionName: typeof sessionName === 'string' ? sessionName.slice(0, 200) : '',
      server: serverOf(sessionId) || {},
      ownerId: null, seen: null, canWrite: false, review: null, isSaving: false,
      tail: null, isTailing: false
    })
    return { docId, existing: false }
  }

  /**
   * A file on this PC (the workspace panel). No SFTP channel, no backup on save (Git and the review
   * before saving are the safety net); the backup list offers the file's Git revisions instead.
   */
  /** `revealLine`: a new window opens at that line (a link "README.md:187" in the agent chat) */
  function registerLocal({ root, path: filePath, label, mode, compareHead = false, revealLine = null, previewText = false }) {
    if (!localFiles || typeof filePath !== 'string' || !filePath) throw new DocumentError(MESSAGES.gone)
    if (mode !== 'edit' && mode !== 'preview') throw new DocumentError(MESSAGES.gone)
    // Explorer sends large text files to a read-only preview so the editor limit does not block viewing.
    if (!previewText && previewKind(nodePath.basename(filePath)).kind === 'text') mode = 'edit'
    const existing = [...docs.values()].find(doc => doc.local && doc.local.path === filePath && doc.mode === mode)
    if (existing) return { docId: existing.docId, existing: true }
    if (docs.size >= MAX_OPEN_DOCUMENTS) throw new DocumentError(MESSAGES.tooMany)
    const docId = newId()
    docs.set(docId, {
      // Opened from the uncommitted changes: the window's first load starts the comparison with Git HEAD
      ...(compareHead && mode === 'edit' ? { compareHead: true, hintsUntil: Date.now() + OPEN_HINT_MS } : {}),
      // Told to every load for a while, like a definition's line (StrictMode loads twice in development)
      ...(Number.isInteger(revealLine) && revealLine > 0 ? { revealLine, hintsUntil: Date.now() + OPEN_HINT_MS } : {}),
      docId, sessionId: null, mode, requestedPath: filePath, local: { root, path: filePath },
      sessionName: typeof label === 'string' && label ? label.slice(0, 200) : '이 PC',
      server: {}, ownerId: null, seen: null, canWrite: false, review: null, isSaving: false,
      tail: null, isTailing: false
    })
    return { docId, existing: false }
  }

  async function loadLocal(doc) {
    const read = localFiles.read
    if (doc.mode === 'edit') {
      const { seen, canWrite } = await read.readForEdit(doc.local.path)
      patch(doc.docId, { seen, canWrite, review: null })
      return { kind: 'text', editable: true, path: seen.path, content: seen.content, canWrite }
    }
    const { kind, mime } = previewKind(nodePath.basename(doc.local.path))
    if (kind === 'text') {
      const { path, text, truncated, size } = await read.readTextPreview(doc.local.path)
      return { kind, editable: false, path, content: text, truncated, size }
    }
    const media = await read.readMedia(doc.local.path)
    return { kind, mime, path: media.path, size: media.size, data: media.data }
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

  /** The last lines of a container's log; following goes on from the newest line's timestamp */
  async function loadContainerLog(doc) {
    const first = await containerLogs.read(doc.sessionId, doc.container)
    if (!first.ok) throw new DocumentError(first.error)
    const generation = ++followSeq
    patch(doc.docId, { tail: { generation, committed: { since: first.last, seq: generation }, pending: null } })
    return {
      kind: 'text', editable: false, path: doc.requestedPath, content: first.text, truncated: false,
      size: Buffer.byteLength(first.text), follow: { generation, cursor: generation },
      // Each look runs a command on the server: the window looks less often than at a file
      pace: 'command'
    }
  }

  async function loadPreview(doc) {
    if (doc.container) return loadContainerLog(doc)
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

  /**
   * Where a placeholder's name is set (`${UPLOAD_DIR}` in a config file): definitions in the file's
   * work folder (a file of this PC) or in the server file's folder and the folders above it (read over
   * SFTP). The window gets keys; opening one goes through `openDefinition`, so a window cannot open a
   * path of its choosing.
   */
  async function findDefinitions(ownerId, docId, name) {
    const doc = own(ownerId, docId)
    if (!configRefs.isValidName(name)) throw new DocumentError('찾을 수 없는 이름입니다.')
    if (doc.container) throw new DocumentError(MESSAGES.gone)
    let found
    if (doc.local) {
      found = await configRefs.searchLocal(doc.local.root, name)
    } else {
      const sftp = await sftpOf(doc)
      found = await configRefs.searchRemote(doc.seen?.path ?? doc.requestedPath, name, {
        readdir: (dir) => new Promise((resolve, reject) => sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))),
        readText: async (file) => {
          const text = await read.readTextPreview(sftp, file, { wholeMaxBytes: 256 * 1024, tailBytes: 0 })
          if (text.truncated) throw new DocumentError(MESSAGES.gone)
          return text.text
        }
      })
    }
    if (!docs.has(docId)) throw new DocumentError(MESSAGES.gone)
    const targets = new Map(found.results.map((result, index) => [String(index), { path: result.path, line: result.line }]))
    patch(docId, { definitions: targets })
    return {
      results: found.results.map((result, index) => ({ key: String(index), path: result.shown, line: result.line, text: result.text })),
      scanned: found.scanned,
      truncated: found.truncated
    }
  }

  /** Opens one definition from the window's latest search, in the editor at its line */
  function openDefinition(ownerId, docId, key) {
    const doc = own(ownerId, docId)
    const target = typeof key === 'string' ? doc.definitions?.get(key) : undefined
    if (!target) throw new DocumentError('목록을 다시 연 뒤 골라 주세요.')
    const registered = doc.local
      ? registerLocal({ root: doc.local.root, path: target.path, label: doc.sessionName, mode: 'edit' })
      : register({ sessionId: doc.sessionId, sessionName: doc.sessionName, remotePath: target.path, mode: 'edit' })
    // A new window reads it with its first load; an open one is told by the IPC (remote-file-reveal-line)
    if (!registered.existing) patch(registered.docId, { revealLine: target.line, hintsUntil: Date.now() + OPEN_HINT_MS })
    return { registered, line: target.line }
  }

  /** What the window shows: the text to edit, or the preview. Read again on every call ("새로고침"). */
  async function load(ownerId, docId) {
    const doc = own(ownerId, docId)
    // How the window opens (a line to go to, comparing with Git HEAD): told to every load in the first
    // seconds, not only the first one. A page in development (React StrictMode) loads twice at start
    // and may draw the second answer; the window reads these only when it first shows the file.
    const isOpening = Date.now() < (doc.hintsUntil ?? 0)
    const revealLine = isOpening ? doc.revealLine ?? null : null
    const compareHead = isOpening && doc.compareHead === true
    const info = { sessionName: doc.sessionName || doc.server?.sessionName || '', requestedPath: doc.requestedPath, mode: doc.mode, ...(revealLine ? { revealLine } : {}), ...(compareHead ? { compareHead } : {}) }
    if (doc.local) return { ...info, local: true, ...(await loadLocal(doc)) }
    return { ...info, sessionColor: doc.server.color, ...(doc.mode === 'edit' ? await loadEdit(doc) : await loadPreview(doc)) }
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
    if (doc.mode === 'edit' || !doc.tail || doc.local) throw new DocumentError(MESSAGES.notFollowable)
    if (generation !== doc.tail.generation) return { status: 'stale' }
    if (doc.isTailing) return { status: 'busy' }
    const { committed, pending } = doc.tail
    const base = pending && cursor === pending.seq ? pending : committed
    patch(docId, { isTailing: true })
    try {
      if (doc.container) {
        const look = await withTimeout(containerLogs.read(doc.sessionId, doc.container, { since: base.since }), tailTimeoutMs)
        if (!look.ok) throw new DocumentError(look.error)
        const next = { since: look.last, seq: ++followSeq }
        const latest = docs.get(docId)
        if (latest && latest.tail && latest.tail.generation === generation) {
          patch(docId, { tail: { generation, committed: base, pending: next } })
        }
        return look.lines > 0 ? { status: 'append', text: look.text, cursor: next.seq } : { status: 'same', cursor: next.seq }
      }
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

  function canMoveEdit(ownerId, docId) {
    const doc = own(ownerId, docId)
    return doc.mode === 'edit' && !!doc.seen && !doc.isSaving
  }

  /** Moving the editor keeps the version already read for conflict detection. */
  function resumeEdit(ownerId, docId) {
    const doc = editable(ownerId, docId)
    return {
      kind: 'text', editable: true, mode: doc.mode, local: doc.local ? true : undefined,
      sessionName: doc.sessionName || doc.server?.sessionName || '', sessionColor: doc.server?.color, requestedPath: doc.requestedPath,
      path: doc.seen.path, content: doc.seen.content, canWrite: doc.canWrite
    }
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
    if (doc.local) {
      const written = await localFiles.read.writeIfUnchanged(doc.seen, content)
      if (!written.ok) return { ok: false, conflict: true, message: MESSAGES.localConflict }
      patch(docId, { seen: { ...doc.seen, content }, review: null })
      return { ok: true, backupName: null }
    }
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
    if (doc.local) return { folder: '', backups: [] }
    const target = targetOf(doc)
    return { folder: target.dir, backups: await backups.store.list(target) }
  }

  async function readBackup(ownerId, docId, name) {
    const doc = editable(ownerId, docId)
    if (doc.local) throw new DocumentError(MESSAGES.noBackup)
    const target = targetOf(doc)
    try {
      return { content: await backups.store.read(target, name) }
    } catch {
      throw new DocumentError(MESSAGES.noBackup)
    }
  }

  /**
   * Backups people left next to the file on the server ("compose.yaml.bak_20261020_1516"). The window
   * gets names only; the paths stay here, and only a name from the latest list can be read back.
   * A folder that cannot be listed gives an empty list (the file itself may still be readable).
   */
  async function listServerBackups(ownerId, docId) {
    const doc = editable(ownerId, docId)
    if (doc.local) {
      const { root, path: filePath } = doc.local
      const [head, history] = await Promise.all([
        localFiles.fileAt(root, filePath).catch(() => null),
        localFiles.fileHistory(root, filePath)
          .then(revisions => ({ revisions }), () => ({ revisions: [], error: 'Git 파일 이력을 읽지 못했습니다.' }))
      ])
      editable(ownerId, docId)
      patch(docId, { gitRevisions: new Map(history.revisions.map(revision => [revision.hash, revision])) })
      return {
        backups: [
          ...(head ? [{ name: 'HEAD', size: head.size, time: head.time, timeFrom: 'git' }] : []),
          ...history.revisions.map(({ hash, time, subject, deleted }) => ({ name: hash, time, subject, deleted, timeFrom: 'git' }))
        ],
        ...(history.error ? { historyError: history.error } : {})
      }
    }
    const sftp = await sftpOf(doc)
    let found = []
    try {
      found = await findServerBackups(sftp, doc.seen.path, doc.requestedPath)
    } catch {
      found = []
    }
    patch(docId, { serverBackups: new Map(found.map(b => [b.name, b.path])) })
    return { backups: found.map(({ name, size, time, timeFrom }) => ({ name, size, time, timeFrom })) }
  }

  /** Text of a listed server backup, whole and up to the editor's limit. */
  async function readServerBackup(ownerId, docId, name) {
    const doc = editable(ownerId, docId)
    if (doc.local) {
      // A renderer can read only revisions that main listed for this exact document.
      const revision = name === 'HEAD' ? null : doc.gitRevisions?.get(name)
      if (name !== 'HEAD' && !revision) throw new DocumentError(MESSAGES.noBackup)
      if (revision?.deleted) return { content: '' }
      const version = await localFiles.fileAt(doc.local.root, revision?.path ?? doc.local.path, revision?.hash).catch(() => null)
      editable(ownerId, docId)
      if (!version) throw new DocumentError(MESSAGES.noBackup)
      return { content: version.content }
    }
    const listed = typeof name === 'string' && doc.serverBackups ? doc.serverBackups.get(name) : undefined
    if (!listed) throw new DocumentError(MESSAGES.noBackup)
    const sftp = await sftpOf(doc)
    let text
    try {
      // tailBytes 0: a file over the limit is refused, not shown in part
      text = await read.readTextPreview(sftp, listed, { wholeMaxBytes: read.EDIT_MAX_BYTES, tailBytes: 0 })
    } catch (err) {
      throw new DocumentError(err && err.userMessage === read.MESSAGES.notText ? err.userMessage : MESSAGES.noBackup)
    }
    if (text.truncated) throw new DocumentError(MESSAGES.backupTooLarge)
    // Swapped for a link (or moved) since it was listed: not the file the list showed
    if (text.path !== listed) throw new DocumentError(MESSAGES.noBackup)
    return { content: text.text }
  }

  function backupFolder(ownerId, docId) {
    const doc = editable(ownerId, docId)
    if (doc.local) throw new DocumentError(MESSAGES.gone)
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

  return { register, registerContainerLog, registerLocal, attach, load, canMoveEdit, resumeEdit, findDefinitions, openDefinition, tail, review, save, listBackups, readBackup, listServerBackups, readServerBackup, backupFolder, close, find }
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
  // The local file modules' errors (src/localFiles) carry a message meant for the window too
  if (err && (err.name === 'LocalFileError' || err.name === 'LocalPathError' || err.constructor?.name === 'LocalFileError' || err.constructor?.name === 'LocalPathError') && typeof err.userMessage === 'string') return err.userMessage
  return read.messageFor(err)
}

module.exports = { createRemoteDocuments, userMessage, DocumentError, MESSAGES, MAX_DIFF_LINES }
