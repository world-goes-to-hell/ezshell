// IPC of the container panel. Asked by the user only (a panel or log window they opened); the app
// never starts these on its own. The window sends a tab's session id and flags, never command text.

const { listCommand, readList } = require('./parse.js')
const { runCommand } = require('./exec.js')

/**
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {(sessionId: string) => object | null} deps.connectionOf  the tab's ssh2 client, if connected
 * @param {(event: object) => boolean} deps.fromMainWindow
 * @param {() => boolean} deps.isLocked
 */
function registerContainerIpc({ ipcMain, connectionOf, fromMainWindow, isLocked }) {
  // sessionId -> names in the last list shown for that tab (a log may be asked for these only)
  const knownNames = new Map()
  // One list request per tab at a time
  const listing = new Set()

  ipcMain.handle('container-list', async (event, payload) => {
    if (!fromMainWindow(event)) return { kind: 'error', message: '본창에서만 볼 수 있습니다.' }
    if (isLocked()) return { kind: 'error', message: '앱 잠금을 해제하세요.' }
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const conn = sessionId ? connectionOf(sessionId) : null
    if (!conn) return { kind: 'error', message: '연결된 탭에서만 볼 수 있습니다.' }
    if (listing.has(sessionId)) return { kind: 'busy' }
    listing.add(sessionId)
    try {
      const ran = await runCommand(conn, listCommand({ all: payload.all === true }), { maxBytes: 512 * 1024, timeoutMs: 8000 })
      if (!ran.ok) return { kind: 'error', message: ran.error }
      const result = readList(ran)
      if (result.kind === 'list') knownNames.set(sessionId, new Set(result.containers.map(container => container.name)))
      return result
    } finally {
      listing.delete(sessionId)
    }
  })

  return {
    /** Whether the name was in the last list shown for the tab */
    isKnown: (sessionId, name) => knownNames.get(sessionId)?.has(name) === true,
    /** The tab closed */
    forget: (sessionId) => { knownNames.delete(sessionId) }
  }
}

module.exports = { registerContainerIpc }
