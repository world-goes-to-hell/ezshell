// IPC of the DB client: discovery for the main window, and the DB windows' requests. A DB window is
// answered only about its own connection. Nothing works while the app is locked, and locking closes
// every DB window (results must not stay behind the lock screen).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const { DbError, dbMessage } = require('./messages.js')

const LOCKED_MESSAGE = '앱이 잠겨 있습니다.'
const NOT_MAIN_WINDOW = '이 창에서는 DB 에 접속할 수 없습니다.'

/**
 * `discover(sessionId)` lists the databases of a tab's server. `createWindow(dbId)` makes a DB window.
 * `isMainWindow(senderId)`: only the main window may discover and open (it holds the sessions; a DB
 * window or any other page must not make the SSH server dial hosts of its choosing).
 * Returns `closeAll()`, which main calls when the app locks.
 */
function registerDbIpc({ ipcMain, connections, discover, createWindow, isLocked = () => false, isMainWindow = () => true }) {
  const windows = new Map()

  const fromMainWindow = (senderId) => {
    if (!isMainWindow(senderId)) throw new DbError(NOT_MAIN_WINDOW)
  }

  const answer = (work) => async (event, request) => {
    try {
      if (isLocked()) throw new DbError(LOCKED_MESSAGE)
      return { success: true, ...(await work(event.sender.id, request || {})) }
    } catch (err) {
      return { success: false, error: dbMessage(err, request?.endpoint) }
    }
  }

  ipcMain.handle('db-discover', answer(async (senderId, { sessionId }) => {
    fromMainWindow(senderId)
    return { databases: await discover(sessionId) }
  }))

  /** A DB window for the connection; the connection is closed with it */
  function openWindowFor(dbId) {
    const win = createWindow(dbId)
    connections.attach(dbId, win.webContents.id)
    windows.set(dbId, win)
    win.on('closed', () => {
      windows.delete(dbId)
      connections.close(dbId)
    })
  }

  /**
   * Opens a connection as a tab of the main window (the default: the main window owns it and closes
   * it with db-close) or as its own window (`target: 'window'`).
   */
  ipcMain.handle('db-open', answer(async (senderId, { target, ...request }) => {
    fromMainWindow(senderId)
    const { dbId, info } = await connections.open(request)
    // The app may have locked while the login went on
    if (isLocked()) {
      connections.close(dbId)
      throw new DbError(LOCKED_MESSAGE)
    }
    if (target !== 'window') {
      connections.attach(dbId, senderId)
      return { dbId, info }
    }
    try {
      openWindowFor(dbId)
    } catch (err) {
      connections.close(dbId)
      throw err
    }
    return { info }
  }))

  /** The main window closed a DB tab */
  ipcMain.handle('db-close', answer((senderId, { dbId }) => {
    fromMainWindow(senderId)
    connections.closeOwned(senderId, dbId)
    return {}
  }))

  /** A DB tab moves to its own window; the connection (and what it was doing) stays */
  ipcMain.handle('db-detach', answer((senderId, { dbId }) => {
    fromMainWindow(senderId)
    connections.describe(senderId, dbId)
    openWindowFor(dbId)
    return {}
  }))

  ipcMain.handle('db-test', answer(async (senderId, request) => {
    fromMainWindow(senderId)
    return connections.test(request)
  }))

  ipcMain.handle('db-info', answer((senderId, { dbId }) => connections.describe(senderId, dbId)))
  ipcMain.handle('db-query', answer((senderId, { dbId, sql }) => connections.query(senderId, dbId, sql)))
  ipcMain.handle('db-cancel', answer((senderId, { dbId }) => connections.cancel(senderId, dbId)))
  ipcMain.handle('db-databases', answer((senderId, { dbId }) => connections.databases(senderId, dbId)))
  ipcMain.handle('db-switch-database', answer((senderId, { dbId, database }) => connections.switchDatabase(senderId, dbId, database)))
  ipcMain.handle('db-set-schema', answer((senderId, { dbId, schema }) => connections.setSchema(senderId, dbId, schema)))
  ipcMain.handle('db-schemas', answer((senderId, { dbId, database }) => connections.schemas(senderId, dbId, database)))
  ipcMain.handle('db-tables', answer((senderId, { dbId, database, schema }) => connections.tables(senderId, dbId, database, schema)))
  ipcMain.handle('db-ddl', answer((senderId, { dbId, database, schema, table }) => connections.ddl(senderId, dbId, database, schema, table)))
  ipcMain.handle('db-relations', answer((senderId, { dbId, sources }) => connections.relations(senderId, dbId, sources)))
  ipcMain.handle('db-columns', answer((senderId, { dbId, database, schema, table }) => connections.columns(senderId, dbId, database, schema, table)))

  /** The app locked: close every DB window and its connection. */
  function closeAll() {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.close()
    }
    connections.closeAll()
  }

  return { closeAll }
}

module.exports = { registerDbIpc, LOCKED_MESSAGE }
