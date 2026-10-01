// IPC between the renderer's MCP screens and the controller in the main process.
const DEFAULT_AUDIT_LIMIT = 200
const MAX_AUDIT_LIMIT = 500
const NOT_READY_MESSAGE = 'MCP 기능이 아직 준비되지 않았습니다.'
const LOCKED_MESSAGE = '앱 잠금을 해제하세요.'

/** While the app is locked the token, the audit log and the activity list stay hidden and settings cannot change. */
function registerMcpIpc(ipcMain, getController, isUnlocked, { pickDirectory } = {}) {
  const unlocked = () => typeof isUnlocked === 'function' && isUnlocked() === true
  const withStatus = (task, { whileLocked } = {}) => async (event, payload) => {
    const controller = getController()
    if (!controller) return { success: false, error: NOT_READY_MESSAGE }
    if (!unlocked() && !whileLocked) return { success: false, error: LOCKED_MESSAGE }
    try {
      return { success: true, status: await task(controller, payload) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  ipcMain.handle('mcp-get-status', withStatus((controller) => {
    const status = controller.getStatus()
    if (unlocked()) return status
    return { ...status, config: { ...status.config, token: '' }, registerCommand: '' }
  }, { whileLocked: true }))
  ipcMain.handle('mcp-update-config', withStatus((controller, patch) => controller.updateConfig(patch)))
  ipcMain.handle('mcp-regenerate-token', withStatus((controller) => controller.regenerateToken()))

  ipcMain.handle('mcp-respond-approval', (event, payload) => {
    const controller = getController()
    const id = payload && typeof payload.id === 'string' ? payload.id : ''
    if (!controller || !id) return { success: false }
    return { success: controller.respondApproval(id, payload.approved === true) === true }
  })

  ipcMain.handle('mcp-list-activity', () => {
    const controller = getController()
    if (!controller) return { success: false, items: [] }
    if (!unlocked()) return { success: false, error: LOCKED_MESSAGE, items: [] }
    return { success: true, items: controller.listActivity() }
  })

  ipcMain.handle('mcp-cancel-activity', (event, payload) => {
    const controller = getController()
    const id = payload && typeof payload.id === 'string' ? payload.id : ''
    if (!controller || !id) return { success: false }
    return { success: controller.cancelActivity(id) === true }
  })

  // The project folder comes from a dialog in the main process, never from the renderer; the overwrite
  // answer that follows a conflict reuses the folder picked for it.
  let lastProjectDir = null
  ipcMain.handle('mcp-setup-client', async (event, payload) => {
    const controller = getController()
    if (!controller) return { success: false, error: NOT_READY_MESSAGE }
    if (!unlocked()) return { success: false, error: LOCKED_MESSAGE }
    const request = payload && typeof payload === 'object' ? payload : {}
    try {
      let projectDir
      if (request.scope === 'project') {
        if (request.reuseDir === true) {
          if (!lastProjectDir) return { success: false, error: '프로젝트 폴더를 다시 고르세요.' }
          projectDir = lastProjectDir
        } else {
          if (typeof pickDirectory !== 'function') return { success: false, error: NOT_READY_MESSAGE }
          projectDir = await pickDirectory()
          if (!projectDir) return { success: false, cancelled: true }
          // The app may have been locked while the dialog was open
          if (!unlocked()) return { success: false, error: LOCKED_MESSAGE }
          lastProjectDir = projectDir
        }
      }
      const outcome = await controller.setupClient({
        scope: request.scope,
        projectDir,
        overwrite: request.overwrite === true,
        setTokenEnv: request.setTokenEnv === true
      })
      return { success: true, outcome }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('mcp-read-audit', (event, payload) => {
    const controller = getController()
    const requested = Number(payload && payload.limit)
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_AUDIT_LIMIT) : DEFAULT_AUDIT_LIMIT
    if (!controller) return { success: false, error: NOT_READY_MESSAGE, entries: [] }
    if (!unlocked()) return { success: false, error: LOCKED_MESSAGE, entries: [] }
    try {
      return { success: true, entries: controller.readAudit(limit) }
    } catch (err) {
      return { success: false, error: err.message, entries: [] }
    }
  })
}

module.exports = { registerMcpIpc }
