// IPC of the server file windows (edit / preview). Every request names its document and is answered
// only for the window that document was opened in (documents.js checks the sender's id).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const { stat } = require('node:fs/promises')
const { userMessage, DocumentError } = require('./documents.js')

const LOCKED_MESSAGE = '앱이 잠겨 있습니다.'

/**
 * `createWindow(atCursor?)` makes a file BrowserWindow. `openFolder(dir)` shows a folder
 * on this PC (made first when missing). `isLocked()` is true while the app is locked: logs are not
 * followed then. Returns `closeViewWindows()`, which main calls when the app locks.
 */
function registerRemoteFileIpc({ ipcMain, docs, createWindow, openFolder, isLocked = () => false, fromMainWindow = () => false, isKnownContainer = () => false, resolveLocal = null, revealLocal = null }) {
  const fileWindows = new Map()
  const dirty = new Set()
  const moving = new Set()
  let workspace = null
  let hintSequence = 0

  const answer = (work) => async (event, request) => {
    try {
      return { success: true, ...(await work(event.sender.id, request || {})) }
    } catch (err) {
      return { success: false, error: userMessage(err) }
    }
  }

  function showWindow(win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  /** Nothing about a server file is read or shown while the app is locked. */
  const refuseWhileLocked = () => {
    if (isLocked()) throw new DocumentError(LOCKED_MESSAGE)
  }

  function snapshot(state) {
    return {
      revision: state.revision,
      tabbed: state.tabbed,
      activeId: state.activeId,
      tabs: state.ids.map(docId => {
        const doc = docs.find(docId)
        return { docId, path: doc.requestedPath, local: Boolean(doc.local), dirty: dirty.has(docId), hint: state.hints.get(docId) }
      })
    }
  }

  function publish(state) {
    state.revision++
    if (!state.win.isDestroyed()) state.win.webContents.send('remote-file-window-changed', snapshot(state))
  }

  function createFileWindow(tabbed, atCursor) {
    const win = createWindow(atCursor)
    const ownerId = win.webContents.id
    const state = { win, ownerId, ids: [], activeId: null, tabbed, revision: 0, hints: new Map(), draft: null, discard: new Set() }
    fileWindows.set(ownerId, state)
    win.on('close', (event) => {
      const unsaved = state.ids.filter(docId => dirty.has(docId) && !state.discard.has(docId))
      state.discard.clear()
      if (!unsaved.length && !state.ids.some(docId => moving.has(docId))) return
      event.preventDefault()
      if (unsaved.length) win.webContents.send('remote-file-close-requested', unsaved)
    })
    // Flashing for a new error (remote-file-attention) stops once the user looks at the window
    win.on('focus', () => win.flashFrame(false))
    win.on('closed', () => {
      if (workspace === state) workspace = null
      fileWindows.delete(ownerId)
      for (const docId of state.ids) {
        dirty.delete(docId)
        docs.close(docId)
      }
    })
    return state
  }

  function attachTo(state, docId) {
    state.ids.push(docId)
    state.activeId = docId
    docs.attach(docId, state.ownerId)
  }

  function removeFrom(state, docId) {
    const index = state.ids.indexOf(docId)
    state.ids.splice(index, 1)
    state.hints.delete(docId)
    if (state.activeId === docId) state.activeId = state.ids[Math.min(index, state.ids.length - 1)] ?? null
    if (state.ids.length) publish(state)
    else state.win.close()
  }

  function ownedWindow(ownerId, docId) {
    const state = fileWindows.get(ownerId)
    if (!state || !state.ids.includes(docId) || docs.find(docId)?.ownerId !== ownerId) {
      throw new DocumentError('이 창에서 열린 파일이 아닙니다.')
    }
    return state
  }

  const windowOf = docId => fileWindows.get(docs.find(docId)?.ownerId)

  function openWindowFor({ docId }, hint) {
    const existing = windowOf(docId)
    if (existing && !existing.win.isDestroyed()) {
      existing.activeId = docId
      if (hint) existing.hints.set(docId, { ...hint, sequence: ++hintSequence })
      publish(existing)
      showWindow(existing.win)
      return { existing: true }
    }
    const tabbed = docs.find(docId).mode === 'edit'
    let state
    try {
      state = tabbed ? (workspace ??= createFileWindow(true)) : createFileWindow(false)
    } catch (err) {
      docs.close(docId)
      throw err
    }
    const wasOpen = state.ids.length > 0
    attachTo(state, docId)
    if (hint) state.hints.set(docId, { ...hint, sequence: ++hintSequence })
    publish(state)
    if (wasOpen) showWindow(state.win)
    return { existing: false }
  }

  ipcMain.handle('remote-file-window-state', answer(senderId => {
    const state = fileWindows.get(senderId)
    return state ? snapshot(state) : { revision: 0, tabbed: false, activeId: null, tabs: [] }
  }))

  ipcMain.handle('remote-file-activate', answer((senderId, { docId }) => {
    const state = ownedWindow(senderId, docId)
    state.activeId = docId
    publish(state)
  }))

  ipcMain.handle('remote-file-detach', answer(async (senderId, { docId, draft }) => {
    refuseWhileLocked()
    const source = ownedWindow(senderId, docId)
    if (!source.tabbed || moving.has(docId) || !docs.canMoveEdit(senderId, docId)) {
      throw new DocumentError('파일이 준비된 뒤 다시 시도해 주세요.')
    }
    if (!validDraft(draft)) {
      throw new DocumentError('현재 편집 상태를 새 창으로 옮길 수 없습니다.')
    }
    moving.add(docId)
    let destination
    try {
      destination = createFileWindow(false, true)
      await destination.win.filePageReady
      refuseWhileLocked()
      ownedWindow(senderId, docId)
      if (destination.win.isDestroyed() || !docs.canMoveEdit(senderId, docId)) throw new DocumentError('파일을 새 창으로 옮기지 못했습니다.')
      destination.draft = { editor: draft.editor, top: draft.top, left: draft.left, ending: draft.ending }
      attachTo(destination, docId)
    } catch (err) {
      if (destination && !destination.win.isDestroyed()) destination.win.close()
      throw err
    } finally {
      moving.delete(docId)
    }
    removeFrom(source, docId)
    publish(destination)
    destination.win.show?.()
  }))

  ipcMain.handle('remote-file-open', answer((senderId, { sessionId, sessionName, remotePath, mode }) => {
    refuseWhileLocked()
    return openWindowFor(docs.register({ sessionId, sessionName, remotePath, mode }))
  }))

  // A container's log in the same kind of window (the container panel's 로그). Only the main window
  // may ask, and only for a container that was in the list it was just shown: the name becomes
  // part of a command line on the server.
  ipcMain.handle('container-log-open', async (event, request) => {
    try {
      const { sessionId, sessionName, name } = request || {}
      if (!fromMainWindow(event)) throw new DocumentError('본창에서만 열 수 있습니다.')
      refuseWhileLocked()
      if (typeof sessionId !== 'string' || typeof name !== 'string' || !isKnownContainer(sessionId, name)) {
        throw new DocumentError('목록을 새로고침한 뒤 다시 열어 주세요.')
      }
      openWindowFor(docs.registerContainerLog({ sessionId, sessionName, container: name }))
      return { success: true }
    } catch (err) {
      return { success: false, error: userMessage(err) }
    }
  })

  // A file on this PC from the workspace panel. Only the main window may ask; main checks the folder
  // (an open local shell's folder or its repository) and that the path stays inside it (localFiles/roots.js).
  async function resolveWorkspaceFile(event, root, relative) {
    if (!fromMainWindow(event) || !resolveLocal) throw new DocumentError('본창에서만 열 수 있습니다.')
    refuseWhileLocked()
    const found = await resolveLocal(root, relative)
    refuseWhileLocked()
    return found
  }

  ipcMain.handle('local-file-open', async (event, request) => {
    try {
      const { root, path: relative, mode, label, compareHead, line } = request || {}
      const found = await resolveWorkspaceFile(event, root, relative)
      // 프로젝트 검색's content results open at their line (docs/plan/2026-11-26-project-search.md)
      const revealLine = Number.isSafeInteger(line) && line > 0 && compareHead !== true ? line : null
      const registered = docs.registerLocal({ root: found.root, path: found.path, label, mode, compareHead: compareHead === true, ...(revealLine ? { revealLine } : {}) })
      openWindowFor(registered, compareHead === true ? { compareHead: true } : revealLine ? { line: revealLine } : undefined)
      return { success: true }
    } catch (err) {
      return { success: false, error: userMessage(err) }
    }
  })

  ipcMain.handle('local-file-reveal', async (event, request) => {
    try {
      const { root, path: relative } = request || {}
      const found = await resolveWorkspaceFile(event, root, relative)
      // A file, or a folder below the root (the root itself is the panel's own folder)
      const info = await stat(found.path)
      const revealable = info.isFile() || (info.isDirectory() && found.relative !== '')
      if (!revealLocal || !revealable) throw new DocumentError('파일이나 폴더를 찾을 수 없습니다.')
      refuseWhileLocked()
      revealLocal(found.path)
      return { success: true }
    } catch (err) {
      return { success: false, error: userMessage(err) }
    }
  })

  ipcMain.handle('remote-file-load', answer((senderId, { docId }) => {
    refuseWhileLocked()
    const state = fileWindows.get(senderId)
    if (state?.draft && state.ids.includes(docId)) return { ...docs.resumeEdit(senderId, docId), draft: state.draft }
    return docs.load(senderId, docId)
  }))
  ipcMain.on('remote-file-draft-restored', (event, { docId } = {}) => {
    const state = fileWindows.get(event.sender.id)
    if (state?.ids.includes(docId)) state.draft = null
  })
  // A placeholder's definitions (`${NAME}`): the window sends the name, then opens a result by its key
  ipcMain.handle('remote-file-find-definitions', answer((senderId, { docId, name }) => {
    refuseWhileLocked()
    return docs.findDefinitions(senderId, docId, name)
  }))
  ipcMain.handle('remote-file-open-definition', answer((senderId, { docId, key }) => {
    refuseWhileLocked()
    const { registered, line } = docs.openDefinition(senderId, docId, key)
    openWindowFor(registered, { line })
    return {}
  }))
  ipcMain.handle('remote-file-tail', answer((senderId, { docId, generation, cursor }) => {
    refuseWhileLocked()
    return docs.tail(senderId, docId, { generation, cursor })
  }))
  ipcMain.handle('remote-file-review', answer((senderId, { docId, content }) => docs.review(senderId, docId, content)))
  ipcMain.handle('remote-file-save', answer((senderId, { docId, content, token }) => docs.save(senderId, docId, content, token)))
  ipcMain.handle('remote-file-backups', answer((senderId, { docId }) => docs.listBackups(senderId, docId)))
  ipcMain.handle('remote-file-read-backup', answer((senderId, { docId, name }) => docs.readBackup(senderId, docId, name)))
  ipcMain.handle('remote-file-server-backups', answer((senderId, { docId }) => docs.listServerBackups(senderId, docId)))
  ipcMain.handle('remote-file-read-server-backup', answer((senderId, { docId, name }) => docs.readServerBackup(senderId, docId, name)))
  ipcMain.handle('remote-file-open-backup-folder', answer(async (senderId, { docId }) => {
    await openFolder(docs.backupFolder(senderId, docId))
    return {}
  }))

  ipcMain.on('remote-file-dirty', (event, { docId, isDirty } = {}) => {
    const doc = docs.find(docId)
    const state = fileWindows.get(event.sender.id)
    if (doc?.mode !== 'edit' || doc.ownerId !== event.sender.id || !state || dirty.has(docId) === Boolean(isDirty)) return
    if (isDirty) dirty.add(docId)
    else dirty.delete(docId)
    publish(state)
  })

  /** A followed log printed an error while its window is in the background: flash it in the taskbar (nothing goes to the notification centre). */
  ipcMain.on('remote-file-attention', (event, { docId } = {}) => {
    const doc = docs.find(docId)
    const win = windowOf(docId)?.win
    if (!doc || doc.ownerId !== event.sender.id || !win || win.isDestroyed() || win.isFocused()) return
    win.flashFrame(true)
  })

  ipcMain.handle('remote-file-close', answer((senderId, { docId, discard }) => {
    const state = ownedWindow(senderId, docId)
    if (moving.has(docId)) throw new DocumentError('파일을 새 창으로 옮기는 중입니다.')
    if (dirty.has(docId) && discard !== true) return { needsConfirmation: true }
    dirty.delete(docId)
    docs.close(docId)
    removeFrom(state, docId)
    return { needsConfirmation: false }
  }))

  ipcMain.handle('remote-file-close-window', answer((senderId, { discardIds }) => {
    const state = fileWindows.get(senderId)
    if (!state || !Array.isArray(discardIds)) return
    state.discard = new Set(state.ids.filter(docId => discardIds.includes(docId)))
    state.win.close()
  }))

  /**
   * The app locked: close the windows that only look at a file (preview, followed log), so nothing
   * keeps showing or updating behind the lock screen. Edit windows stay: they may hold unsaved text.
   */
  function closeViewWindows() {
    for (const { ids, win } of fileWindows.values()) {
      if (!win.isDestroyed() && ids.some(docId => docs.find(docId)?.mode !== 'edit')) win.close()
    }
  }

  /** Unsaved edits hold an update's restart until the user decides. */
  const unsavedEditCount = () => dirty.size

  /**
   * A file of this PC the user picked from a link in an agent's answer (src/agentChat/ipc.js checks it
   * was in the conversation and resolves it). Text opens in the editor, images and PDFs in the preview.
   */
  /** `line`: open at that line (a new window reads it; an open one is told, as for a definition) */
  function openLocalFile(realPath, label, line = null) {
    try {
      refuseWhileLocked()
      const revealLine = Number.isInteger(line) && line > 0 ? line : null
      const registered = docs.registerLocal({ root: require('path').dirname(realPath), path: realPath, label, mode: 'preview', revealLine })
      openWindowFor(registered, revealLine ? { line: revealLine } : undefined)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: userMessage(err) }
    }
  }

  return { closeViewWindows, unsavedEditCount, openLocalFile }
}

function validDraft(draft) {
  return Boolean(draft && typeof draft.editor === 'string' && draft.editor.length <= 32 * 1024 * 1024
    && Number.isFinite(draft.top) && Number.isFinite(draft.left)
    && ['lf', 'crlf', 'mixed', 'none'].includes(draft.ending))
}

module.exports = { registerRemoteFileIpc }
