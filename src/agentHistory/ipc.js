const { requireLocalDirectory } = require('../localShell.js')

const KEY = /^(claude|codex):[0-9a-f-]{36}$/

/**
 * Agent session history for the right panel. The main window only, and not while locked: the
 * summaries hold the start of conversations. Not offered to MCP, remote access or agent messages.
 */
function registerAgentHistoryIpc({ ipcMain, fromMainWindow, isLocked, history, openPath }) {
  const allowed = event => fromMainWindow(event) && !isLocked()
  const refused = { success: false, error: '잠금 해제 후 본창에서 이용할 수 있습니다.' }

  ipcMain.handle('agent-history-list', async (event) => {
    if (!allowed(event)) return refused
    try {
      const result = await history.list()
      // Locked while scanning: what was read is dropped by clear(), do not hand it over either
      return allowed(event) ? { success: true, ...result } : refused
    } catch {
      return { success: false, error: '에이전트 기록을 읽지 못했습니다.' }
    }
  })

  // Content search: only keys and one-line excerpts go back, never file paths
  ipcMain.handle('agent-history-search', async (event, query) => {
    if (!allowed(event)) return refused
    if (typeof query !== 'string' || query.length > 1000) return { success: false, error: '검색어가 너무 깁니다.' }
    try {
      const result = await history.search(query)
      // Stopped by a newer search or by the lock: nothing to show
      if (!result) return { success: false, cancelled: true, error: '' }
      return allowed(event) ? { success: true, ...result } : refused
    } catch {
      return { success: false, error: '대화 내용을 찾지 못했습니다.' }
    }
  })

  ipcMain.handle('agent-history-detail', async (event, key) => {
    if (!allowed(event)) return refused
    if (typeof key !== 'string' || !KEY.test(key)) return { success: false, error: '알 수 없는 세션입니다.' }
    try {
      const detail = await history.detail(key)
      if (!detail) return { success: false, error: '목록을 새로 고친 뒤 다시 열어 주세요.' }
      return allowed(event) ? { success: true, ...detail } : refused
    } catch {
      return { success: false, error: '세션 기록을 읽지 못했습니다.' }
    }
  })

  ipcMain.handle('agent-history-open-folder', async (event, key) => {
    if (!allowed(event)) return refused
    const target = typeof key === 'string' && KEY.test(key) ? history.target(key) : null
    if (!target) return { success: false, error: '목록을 새로 고친 뒤 다시 열어 주세요.' }
    try {
      const failure = await openPath(requireLocalDirectory(target.cwd))
      return failure ? { success: false, error: failure } : { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}

module.exports = { registerAgentHistoryIpc, AGENT_HISTORY_KEY: KEY }
