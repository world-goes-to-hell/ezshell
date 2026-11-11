// IPC of the server file windows (edit / preview). Every request names its document and is answered
// only for the window that document was opened in (documents.js checks the sender's id).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const { userMessage, DocumentError } = require('./documents.js')

const LOCKED_MESSAGE = '앱이 잠겨 있습니다.'

/**
 * `createWindow(docId)` makes the BrowserWindow for a document. `openFolder(dir)` shows a folder
 * on this PC (made first when missing). `isLocked()` is true while the app is locked: logs are not
 * followed then. Returns `closeViewWindows()`, which main calls when the app locks.
 */
function registerRemoteFileIpc({ ipcMain, docs, createWindow, openFolder, isLocked = () => false }) {
  const windows = new Map()
  // Documents whose window has unsaved changes, and those the user chose to close anyway
  const dirty = new Set()
  const closing = new Set()

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

  ipcMain.handle('remote-file-open', answer((senderId, { sessionId, sessionName, remotePath, mode }) => {
    refuseWhileLocked()
    const { docId, existing } = docs.register({ sessionId, sessionName, remotePath, mode })
    const open = windows.get(docId)
    if (existing && open && !open.isDestroyed()) {
      showWindow(open)
      return { existing: true }
    }
    const win = createWindow(docId)
    docs.attach(docId, win.webContents.id)
    windows.set(docId, win)
    win.on('close', (event) => {
      if (!dirty.has(docId) || closing.has(docId)) return
      // The window asks the user first, then closes through remote-file-close
      event.preventDefault()
      win.webContents.send('remote-file-close-requested')
    })
    // Flashing for a new error (remote-file-attention) stops once the user looks at the window
    win.on('focus', () => win.flashFrame(false))
    win.on('closed', () => {
      windows.delete(docId)
      dirty.delete(docId)
      closing.delete(docId)
      docs.close(docId)
    })
    return { existing: false }
  }))

  ipcMain.handle('remote-file-load', answer((senderId, { docId }) => {
    refuseWhileLocked()
    return docs.load(senderId, docId)
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
    if (!doc || doc.ownerId !== event.sender.id) return
    if (isDirty) dirty.add(docId)
    else dirty.delete(docId)
  })

  /** A followed log printed an error while its window is in the background: flash it in the taskbar (nothing goes to the notification centre). */
  ipcMain.on('remote-file-attention', (event, { docId } = {}) => {
    const doc = docs.find(docId)
    const win = windows.get(docId)
    if (!doc || doc.ownerId !== event.sender.id || !win || win.isDestroyed() || win.isFocused()) return
    win.flashFrame(true)
  })

  /** The user chose to close the window without saving. */
  ipcMain.handle('remote-file-close', answer((senderId, { docId }) => {
    const doc = docs.find(docId)
    const win = windows.get(docId)
    if (!doc || doc.ownerId !== senderId || !win || win.isDestroyed()) return {}
    closing.add(docId)
    win.close()
    return {}
  }))

  /**
   * The app locked: close the windows that only look at a file (preview, followed log), so nothing
   * keeps showing or updating behind the lock screen. Edit windows stay: they may hold unsaved text.
   */
  function closeViewWindows() {
    for (const [docId, win] of windows) {
      const doc = docs.find(docId)
      if (doc && doc.mode !== 'edit' && !win.isDestroyed()) win.close()
    }
  }

  return { closeViewWindows }
}

module.exports = { registerRemoteFileIpc }
