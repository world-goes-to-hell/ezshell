// The MCP tools that move one file between this PC and a server: upload_file and download_file.
// They are the only tools that touch this PC's files, so the local side is limited to the folders
// the user registered, every transfer waits for the user's yes, and the receiving side gets a
// partial file that takes the real name only when it is complete. Content never goes to the audit log.
const crypto = require('crypto')
const nodeFs = require('fs')
const { resolveLocalPath } = require('./localPath.js')
const { resolveRemotePath } = require('./filePath.js')
const { RemoteFileError } = require('./remoteFile.js')
const { classifyTransfer, refuseRemotePath } = require('./transferPolicy.js')
const { copyRange, CopyStopped, SourceShrank } = require('./transferCopy.js')
const local = require('./localFile.js')
const remote = require('./remoteTransfer.js')
const { combineSignals } = require('./signals.js')
const {
  LOCKED_MESSAGE, SESSION_CHANGED_MESSAGE, UNKNOWN_ERROR_MESSAGE, SESSIONS_UNREADABLE_MESSAGE, AUDIT_FAILED_MESSAGE,
  textResult, folderPath, exposedName, activityFields, activityState
} = require('./toolShared.js')

const MAX_TRANSFER_BYTES = 1024 * 1024 * 1024
/** A transfer has this long; a longer one is stopped */
const TRANSFER_LIMIT_MS = 60 * 60 * 1000
/** A request answers within this time: with the result, or with a job id to ask about later */
const QUICK_WAIT_MS = 20 * 1000
const PROGRESS_MS = 1000
/** After a stop, how long pending reads and writes (and then the cleanup) may take before they are abandoned */
const GIVE_UP_MS = 5000
/** Requests looked at but not yet answered; each upload among them holds a file open */
const MAX_WAITING = 4
const TRANSFER_LEVEL = 'danger'

const DENIAL_MESSAGES = {
  denied: '사용자가 전송을 거부했습니다.',
  expired: '제한 시간 안에 승인되지 않아 전송하지 않았습니다.',
  cancelled: '요청이 취소되어 전송하지 않았습니다.'
}
const JOB_LIMIT_HINT = 'list_jobs 로 확인하고, 끝나기를 기다리거나 stop_job 으로 중지하세요.'
const JOB_LIMIT_MESSAGES = {
  session: `이 세션에서 동시에 실행할 수 있는 작업 수를 넘었습니다. ${JOB_LIMIT_HINT}`,
  total: `동시에 실행할 수 있는 작업 수를 넘었습니다. ${JOB_LIMIT_HINT}`
}
const REMOTE_EXISTS_MESSAGE = '서버에 같은 이름의 파일이 이미 있습니다. 덮어쓰려면 overwrite: true 를 지정하세요.'
const LOCAL_EXISTS_MESSAGE = 'PC 에 같은 이름의 파일이 이미 있습니다. 덮어쓰려면 overwrite: true 를 지정하세요.'
const LOCAL_MOVED_MESSAGE = 'PC 의 받는 폴더가 바뀌어 전송하지 않았습니다. 다시 요청하세요.'
const TOO_MANY_WAITING_MESSAGE = (limit) => `답을 기다리는 전송 요청이 너무 많습니다 (대기 중인 요청 ${limit}개까지). 앞선 요청이 끝난 뒤 다시 요청하세요.`
const UNSURE_MESSAGE = '중지했지만 받는 쪽 파일을 바꾸는 중이어서 결과를 확인하지 못했습니다. 받는 쪽 파일을 확인하세요.'
const STOPPED_MESSAGE = '전송을 중지했습니다. 받는 쪽의 원래 파일은 그대로입니다.'
const TIMEOUT_MESSAGE = '제한 시간을 넘어 전송을 중지했습니다. 받는 쪽의 원래 파일은 그대로입니다.'
const DROPPED_MESSAGE = '서버와의 연결이 끊겨 전송을 마치지 못했습니다.'
const DIRECTION_LABELS = { upload: 'PC → 서버', download: '서버 → PC' }

const noop = () => {}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const shown = (value) => (typeof value === 'string' ? value : '')

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}바이트`
}

/** Rejects `giveUpMs` after `signal` aborts: a read or write that never answers must not hold the transfer forever. */
function stoppedFor(signal, giveUpMs) {
  let timer = null
  let onAbort = noop
  const promise = new Promise((resolve, reject) => {
    onAbort = () => { timer = setTimeout(() => reject(new CopyStopped()), giveUpMs) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(noop)
  return { promise, clear: () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) } }
}

function createTransferHandlers({
  isUnlocked, allowedSessions, findSession, getFolders, approvals, gateway, writeLog, track, activity, newRequestId, jobs,
  getTransferRoots = () => [], userDataPath = '', options = {}
}) {
  const {
    fsp = nodeFs.promises,
    maxBytes = MAX_TRANSFER_BYTES,
    limitMs = TRANSFER_LIMIT_MS,
    quickWaitMs = QUICK_WAIT_MS,
    progressMs = PROGRESS_MS,
    giveUpMs = GIVE_UP_MS,
    maxWaiting = MAX_WAITING,
    chunkBytes,
    window
  } = options
  const realpath = (target) => fsp.realpath(target)
  const lstat = (target) => fsp.lstat(target)
  const localPathOf = (input) => resolveLocalPath(input, { roots: getTransferRoots(), userDataDir: userDataPath, realpath, lstat })
  let waiting = 0

  function describe({ direction, session, localFile, remoteFile, isNew, size, digest }) {
    const fresh = isNew ? '새 파일' : '덮어쓰기'
    const isUpload = direction === 'upload'
    const lines = [
      `세션: ${exposedName(session)}`,
      `방향: ${DIRECTION_LABELS[direction]}`,
      `PC 파일: ${localFile.path}${isUpload ? '' : ` (${fresh})`}`,
      `서버 파일: ${remoteFile.path}${isUpload ? ` (${fresh})` : ''}`,
      `크기: ${size}바이트`
    ]
    return digest ? [...lines, `SHA-256: ${digest}`] : lines
  }

  /**
   * Move the bytes. Runs apart from the request that started it: it ends through its own limit,
   * stop_job, the activity view's stop, or a lock. Resolves (never rejects) with { ok, text } after
   * the partial file is gone or in place and the channel is closed.
   */
  async function runTransfer({ jobId, plan, session, source, stop, finish, requestId }) {
    const { direction, localFile, remoteFile, localSeen, size, mode, isNew } = plan
    const run = new AbortController()
    const stopRun = () => run.abort()
    let timedOut = false
    let dropped = false
    const limitTimer = setTimeout(() => { timedOut = true; stopRun() }, limitMs)
    if (stop.signal.aborted) stopRun()
    else stop.signal.addEventListener('abort', stopRun, { once: true })
    const hash = crypto.createHash('sha256')
    let lastReport = 0
    const report = (text) => {
      jobs.append(jobId, `${text}\n`)
      track(() => activity.appendOutput(requestId, 'stdout', `${text}\n`))
    }
    // The bar in the activity view; activity only, never the audit log. Speed counts from here, not from
    // the request, which may have waited for the user.
    const copyStartedAt = Date.now()
    const showProgress = (done) => track(() => activity.update(requestId, { transfer: { direction, size, done, startedAt: copyStartedAt } }))
    showProgress(0)
    const onProgress = (done) => {
      const now = Date.now()
      if (now - lastReport < progressMs || done >= size) return
      lastReport = now
      report(`진행: ${formatBytes(done)} / ${formatBytes(size)} (${Math.floor((done / size) * 100)}%)`)
      showProgress(done)
    }
    const copyOptions = { size, signal: run.signal, hash, onProgress, ...(chunkBytes ? { chunkBytes } : {}), ...(window ? { window } : {}) }

    let channel = null
    let discard = null
    let remoteHandle = null
    let failure = null
    // Set once cleanup has run: work that was given up on may still be going, and must not leave a file behind
    let isOver = false
    // From here the receiving side is being changed; a stop can no longer promise it is untouched
    let isCommitting = false
    const giveUp = stoppedFor(run.signal, giveUpMs)
    const assertRunning = () => {
      if (isOver || run.signal.aborted) throw new CopyStopped()
    }
    /** A partial file made after cleanup ran (by work that had been given up on) is removed at once. */
    const keepPart = async (remove) => {
      if (!isOver) { discard = remove; return }
      await remove().catch(noop)
      throw new CopyStopped()
    }
    const stillSameLocalPlace = async () => {
      const again = await localPathOf(localFile.requestedPath)
      return again.ok && again.path === localFile.path
    }

    async function upload(sftp) {
      if (!(await local.isLocalSourceUnchanged(source))) throw new local.LocalFileError(local.MESSAGES.sourceChanged)
      const current = await remote.inspectRemoteTarget(sftp, remoteFile.requestedPath, { refusePath: refuseRemotePath })
      if (!remote.sameTarget(current, remoteFile)) throw new RemoteFileError(remote.MESSAGES.targetChanged)
      assertRunning()
      const part = await remote.createRemotePart(sftp, remoteFile.path)
      await keepPart(() => remote.discardRemotePart(sftp, part))
      await copyRange({
        ...copyOptions,
        readAt: (position, length) => local.readLocal(source.handle, position, length),
        writeAt: (buffer, position) => remote.writeRemote(sftp, part.handle, buffer, position)
      })
      // Bytes read while the file was being rewritten are neither the old nor the new file
      if (!(await local.isLocalSourceUnchanged(source))) throw new local.LocalFileError(local.MESSAGES.sourceChanged)
      assertRunning()
      isCommitting = true
      await remote.commitRemotePart(sftp, part, remoteFile, { mode, bytes: size })
      discard = null
    }

    async function download(sftp) {
      remoteHandle = await remote.openRemoteSource(sftp, remoteFile)
      // The folder may have been swapped for a junction since the user was asked
      if (!(await stillSameLocalPlace())) throw new local.LocalFileError(LOCAL_MOVED_MESSAGE)
      assertRunning()
      const part = await local.createLocalPart(localFile.path, { fsp })
      await keepPart(() => local.discardLocalPart(part, { fsp }))
      await copyRange({
        ...copyOptions,
        readAt: (position, length) => remote.readRemote(sftp, remoteHandle, position, length),
        writeAt: (buffer, position) => part.handle.write(buffer, 0, buffer.length, position)
      })
      // A file that grew, or reports a smaller size than it holds, is not the one the user was shown
      const beyond = await remote.readRemote(sftp, remoteHandle, size, 1)
      if (beyond.length > 0 || !(await remote.isRemoteSourceUnchanged(sftp, remoteHandle, remoteFile))) {
        throw new RemoteFileError(remote.MESSAGES.sourceChanged)
      }
      // ...or swapped while the bytes were coming in: the name the file would take must still be the place shown
      if (!(await stillSameLocalPlace())) throw new local.LocalFileError(LOCAL_MOVED_MESSAGE)
      assertRunning()
      isCommitting = true
      await local.commitLocalPart(part, localFile.path, localSeen, { fsp })
      discard = null
    }

    async function work() {
      if (!jobs.attach(jobId, { cwd: null, stop: stopRun })) throw new CopyStopped()
      channel = await gateway.openTransfer(session, { signal: run.signal })
      if (channel.closed && typeof channel.closed.then === 'function') {
        channel.closed.then(() => { dropped = true; stopRun() }, noop)
      }
      if (run.signal.aborted) throw new CopyStopped()
      await (direction === 'upload' ? upload(channel.sftp) : download(channel.sftp))
    }

    let isUnsure = false
    try {
      const working = work()
      working.catch(noop)
      try {
        await Promise.race([working, giveUp.promise])
      } catch (err) {
        if (!isCommitting || !(err instanceof CopyStopped)) throw err
        // Given up on while the file was being put in place: wait for that step, it decides the outcome
        const settled = await Promise.race([working.then(() => 'done', () => 'failed'), delay(giveUpMs).then(() => 'unknown')])
        if (settled === 'failed') throw err
        isUnsure = settled === 'unknown'
      }
    } catch (err) {
      failure = err
    }
    isOver = true
    giveUp.clear()
    clearTimeout(limitTimer)
    stop.signal.removeEventListener('abort', stopRun)
    // Cleanup comes before the end is reported: once a job is over its connection may be closed
    const cleanup = async () => {
      if (discard) await discard().catch(noop)
      if (remoteHandle && channel) await remote.closeRemote(channel.sftp, remoteHandle)
      if (source) await source.handle.close().catch(noop)
    }
    await Promise.race([cleanup(), delay(giveUpMs)])
    if (channel) {
      try { channel.close() } catch { /* already closed */ }
    }

    if (isUnsure) {
      jobs.append(jobId, `${UNSURE_MESSAGE}\n`)
      jobs.finish(jobId, { state: 'error' })
      finish({ outcome: 'failed', error: UNSURE_MESSAGE }, UNSURE_MESSAGE)
      return { ok: false, text: UNSURE_MESSAGE }
    }
    if (!failure) {
      const digest = hash.digest('hex')
      const text = describe({ direction, session, localFile, remoteFile, isNew, size, digest }).join('\n')
      showProgress(size)
      jobs.append(jobId, `${text}\n`)
      jobs.finish(jobId, { state: 'done' })
      finish({ outcome: 'approved', exitCode: null, timedOut: false, cancelled: false, contentSha256: digest }, text)
      return { ok: true, text }
    }
    const wasStopped = !dropped && (failure instanceof CopyStopped || (run.signal.aborted && !failure.userMessage))
    if (wasStopped) {
      const text = timedOut ? TIMEOUT_MESSAGE : STOPPED_MESSAGE
      jobs.append(jobId, `${text}\n`)
      jobs.finish(jobId, { state: timedOut ? 'timeout' : 'stopped' })
      finish({ outcome: 'approved', exitCode: null, timedOut, cancelled: !timedOut }, text)
      return { ok: false, text }
    }
    const reason = dropped ? DROPPED_MESSAGE
      : failure instanceof SourceShrank ? (direction === 'upload' ? local.MESSAGES.sourceChanged : remote.MESSAGES.sourceChanged)
        : failure.userMessage || UNKNOWN_ERROR_MESSAGE
    const text = `전송하지 못했습니다: ${reason}`
    jobs.append(jobId, `${text}\n`)
    jobs.finish(jobId, { state: 'error' })
    finish({ outcome: 'failed', error: reason }, text)
    return { ok: false, text }
  }

  async function transfer({ tool, direction, ref, localRaw, remoteRaw, overwrite, signal }) {
    if (!isUnlocked()) return textResult(LOCKED_MESSAGE, true)
    let sessions
    try {
      sessions = allowedSessions()
    } catch {
      return textResult(SESSIONS_UNREADABLE_MESSAGE, true)
    }
    const found = findSession(sessions, ref)
    if (found.error) return textResult(found.error, true)
    const { session } = found
    const isUpload = direction === 'upload'

    const command = isUpload ? `${tool} ${shown(localRaw)} → ${shown(remoteRaw)}` : `${tool} ${shown(remoteRaw)} → ${shown(localRaw)}`
    const base = { requestId: newRequestId(), sessionId: session.id, sessionName: session.name, command, level: TRANSFER_LEVEL, reasons: ['파일 전송'] }
    // "중지" in the activity panel aborts this controller; the caller's own signal counts until the transfer starts.
    const stop = new AbortController()
    const requestSignal = combineSignals([signal, stop.signal])
    if (!writeLog({ ...base, phase: 'start' })) return textResult(AUDIT_FAILED_MESSAGE, true)
    track(() => activity.begin({ ...activityFields(base), cwd: null, state: 'running' }, { cancel: () => stop.abort() }))
    let finished = false
    // Audit fields known as the request goes on: both real paths, the size, whether the user said yes
    let trail = {}
    const finish = (fields, output) => {
      if (finished) return
      finished = true
      writeLog({ ...base, phase: 'end', ...trail, ...fields })
      const { outcome, contentSha256, ...details } = fields
      track(() => activity.update(base.requestId, { ...details, state: activityState(fields), output }))
    }
    const refuse = (message) => {
      const refused = textResult(`전송하지 못했습니다: ${message}`, true)
      finish({ outcome: 'failed', error: message }, refused.content[0].text)
      return refused
    }

    // The file to upload stays open from here until the transfer ends, so what is sent is what was looked at
    let source = null
    let isHandedOver = false
    let isCounted = false
    try {
      // 1. This PC: nothing outside the registered folders is looked at
      const localFile = await localPathOf(localRaw)
      if (!localFile.ok) return refuse(localFile.error)
      const full = jobs.canStart(session.id)
      if (full) return refuse(JOB_LIMIT_MESSAGES[full])
      if (waiting >= maxWaiting) return refuse(TOO_MANY_WAITING_MESSAGE(maxWaiting))
      waiting += 1
      isCounted = true

      // 2. Look at both ends (the server over SFTP, in turn with the session's commands)
      const inspectRemote = (inspect) => gateway.useSftp(session, { signal: requestSignal }, async (sftp, where) => {
        const resolved = resolveRemotePath(remoteRaw, where)
        if (!resolved.ok) throw new RemoteFileError(resolved.error)
        return inspect(sftp, resolved.path, where)
      })
      let remoteFile
      let localSeen = null
      let size
      let isNew
      if (isUpload) {
        source = await local.openLocalSource(localFile.path, { fsp, maxBytes })
        // A folder on the way may have been swapped for a junction between resolving the path and
        // opening it; the open file must be the one the path, resolved again, leads to
        const again = await localPathOf(localRaw)
        if (!again.ok || again.path !== localFile.path || !(await local.isSameLocalFile(source, localFile.path, { fsp }))) {
          return refuse(local.MESSAGES.sourceChanged)
        }
        remoteFile = await inspectRemote(async (sftp, target, where) => {
          const seen = await remote.inspectRemoteTarget(sftp, target, { refusePath: refuseRemotePath })
          const ownerDiffers = seen.exists ? await remote.remoteOwnerDiffers(sftp, where.home, seen.uid) : false
          return { ...seen, ownerDiffers }
        })
        if (remoteFile.exists && overwrite !== true) return refuse(REMOTE_EXISTS_MESSAGE)
        size = source.size
        isNew = !remoteFile.exists
      } else {
        remoteFile = await inspectRemote((sftp, target) => remote.inspectRemoteSource(sftp, target, { refusePath: refuseRemotePath, maxBytes }))
        localSeen = await local.inspectLocalTarget(localFile.path, { fsp })
        if (localSeen.exists && overwrite !== true) return refuse(LOCAL_EXISTS_MESSAGE)
        size = remoteFile.size
        isNew = !localSeen.exists
      }
      trail = { target: remoteFile.path, localTarget: localFile.path, bytes: size }

      // 3. Ask. A transfer always needs the user's yes, whatever the alert level is.
      const verdict = classifyTransfer({ direction, local: localFile, remote: remoteFile, isNew, ownerDiffers: remoteFile.ownerDiffers })
      const interrupted = () => {
        if (isUnlocked() && !requestSignal.aborted) return null
        const stopped = textResult(isUnlocked() ? DENIAL_MESSAGES.cancelled : LOCKED_MESSAGE, true)
        finish({ outcome: 'cancelled' }, stopped.content[0].text)
        return stopped
      }
      const before = interrupted()
      if (before) return before
      track(() => activity.update(base.requestId, { state: 'waiting', reasons: verdict.reasons }))
      const outcome = await approvals.request({
        kind: 'transfer',
        direction,
        sessionName: session.name,
        folder: folderPath(getFolders(), session.folderId),
        cwd: null,
        command,
        localPath: localFile.path,
        requestedLocalPath: localFile.requestedPath,
        remotePath: remoteFile.path,
        requestedRemotePath: remoteFile.requestedPath,
        size,
        isNew,
        level: verdict.level,
        reasons: verdict.reasons
      }, { signal: requestSignal })
      if (outcome !== 'approved') {
        const denied = textResult(DENIAL_MESSAGES[outcome] || DENIAL_MESSAGES.denied, true)
        finish({ outcome: DENIAL_MESSAGES[outcome] ? outcome : 'denied', reasons: verdict.reasons }, denied.content[0].text)
        return denied
      }
      trail = { ...trail, approved: true, reasons: verdict.reasons }
      track(() => activity.update(base.requestId, { state: 'running' }))

      // 4. The user said yes to what they saw: the app must still be unlocked, the request alive and
      //    the session allowed. Whether both files are still the same is checked as the transfer starts.
      const after = interrupted()
      if (after) return after
      const fresh = allowedSessions().find(candidate => candidate.id === session.id)
      if (!fresh) {
        const changed = textResult(SESSION_CHANGED_MESSAGE, true)
        finish({ outcome: 'cancelled' }, changed.content[0].text)
        return changed
      }
      const created = jobs.create({ sessionId: fresh.id, sessionName: exposedName(fresh), command, limitMs })
      if (created.error) return refuse(JOB_LIMIT_MESSAGES[created.error])

      // 5. Transfer. A short one answers here; a long one goes on as a job.
      const mode = remoteFile.exists ? remoteFile.mode : verdict.newFileMode
      const plan = { direction, localFile, remoteFile, localSeen, size, mode, isNew }
      const running = runTransfer({ jobId: created.id, plan, session: fresh, source, stop, finish, requestId: base.requestId })
      isHandedOver = true
      const ended = await Promise.race([running, delay(quickWaitMs).then(() => null)])
      if (ended) return textResult(ended.text, !ended.ok)
      const startedText = [
        ...describe({ direction, session: fresh, localFile, remoteFile, isNew, size }),
        `작업 ID: ${created.id}`,
        '전송 중입니다. job_output 으로 진행과 결과를 확인하고, 중지하려면 stop_job 을 쓰세요.'
      ].join('\n')
      track(() => activity.update(base.requestId, { jobId: created.id, output: startedText }))
      return textResult(startedText)
    } catch (err) {
      return refuse((err && err.userMessage) || UNKNOWN_ERROR_MESSAGE)
    } finally {
      if (isCounted) waiting -= 1
      if (source && !isHandedOver) await source.handle.close().catch(noop)
    }
  }

  function uploadFile(args, { signal } = {}) {
    const { session, local_path: localRaw, remote_path: remoteRaw, overwrite } = args || {}
    return transfer({ tool: 'upload_file', direction: 'upload', ref: session, localRaw, remoteRaw, overwrite, signal })
  }

  function downloadFile(args, { signal } = {}) {
    const { session, local_path: localRaw, remote_path: remoteRaw, overwrite } = args || {}
    return transfer({ tool: 'download_file', direction: 'download', ref: session, localRaw, remoteRaw, overwrite, signal })
  }

  return { uploadFile, downloadFile }
}

module.exports = { createTransferHandlers, MAX_TRANSFER_BYTES }
