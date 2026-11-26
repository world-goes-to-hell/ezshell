const path = require('node:path')
const { requireLocalDirectory } = require('../localShell.js')
const { isLocalFilePath } = require('../localKeyPath.js')
const { inspectLocalProject } = require('../ipc/localProjects.js')

const KEY = /^(?:claude:(?:[0-9a-f-]{36}:)?|codex:)[0-9a-f-]{36}$/
const isLocalDirectoryPath = folder => isLocalFilePath(folder) && path.isAbsolute(folder)

async function projectOf(folder) {
  if (!isLocalDirectoryPath(folder)) return null
  const directory = path.resolve(folder)
  if (directory === path.parse(directory).root) return null

  const { repo } = await inspectLocalProject(directory)
  const roots = repo ? [repo.root, ...repo.worktrees.map(tree => tree.path)] : [directory]
  return {
    name: path.basename(repo?.worktrees[0]?.path ?? repo?.root ?? directory),
    includes(cwd) {
      return isLocalDirectoryPath(cwd) && roots.some(root => {
        const relative = path.relative(root, cwd)
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      })
    }
  }
}

/**
 * Agent session history for the right panel. The main window only, and not while locked: the
 * summaries hold the start of conversations. Not offered to MCP, remote access or agent messages.
 */
function registerAgentHistoryIpc({ ipcMain, fromMainWindow, isLocked, history, folderForShell, openPath }) {
  const allowed = event => fromMainWindow(event) && !isLocked()
  const refused = { success: false, error: '잠금 해제 후 본창에서 이용할 수 있습니다.' }
  const noProject = { success: false, error: '프로젝트의 로컬 터미널을 선택해 주세요.' }
  const unknown = { success: false, error: '이 프로젝트에서 세션을 찾지 못했습니다.' }
  const cancelled = { success: false, cancelled: true, error: '' }
  const projectForShell = shellId => projectOf(typeof shellId === 'string' ? folderForShell(shellId) : null)
  let latestSearch = 0

  ipcMain.handle('agent-history-list', async (event, shellId) => {
    if (!allowed(event)) return refused
    try {
      const project = await projectForShell(shellId)
      if (!project) return noProject
      if (!allowed(event)) return refused
      const { sessions } = await history.list()
      // Locked while scanning: what was read is dropped by clear(), do not hand it over either
      return allowed(event) ? { success: true, project: project.name, sessions: sessions.filter(session => project.includes(session.cwd)) } : refused
    } catch {
      return { success: false, error: '에이전트 기록을 읽지 못했습니다.' }
    }
  })

  // Content search: only keys and one-line excerpts go back, never file paths
  ipcMain.handle('agent-history-search', async (event, shellId, query) => {
    if (!allowed(event)) return refused
    if (typeof query !== 'string' || query.length > 1000) return { success: false, error: '검색어가 너무 깁니다.' }
    const request = ++latestSearch
    try {
      const project = await projectForShell(shellId)
      if (!project) return noProject
      if (!allowed(event)) return refused
      if (request !== latestSearch) return cancelled
      const result = await history.search(query, project.includes)
      // Stopped by a newer search or by the lock: nothing to show
      if (!result || request !== latestSearch) return cancelled
      return allowed(event) ? { success: true, ...result } : refused
    } catch {
      return { success: false, error: '대화 내용을 찾지 못했습니다.' }
    }
  })

  ipcMain.handle('agent-history-detail', async (event, shellId, key) => {
    if (!allowed(event)) return refused
    if (typeof key !== 'string' || !KEY.test(key)) return unknown
    try {
      const project = await projectForShell(shellId)
      if (!allowed(event)) return refused
      if (!project?.includes(history.target(key)?.cwd)) return unknown
      const detail = await history.detail(key)
      if (!detail) return { success: false, error: '목록을 새로 고친 뒤 다시 열어 주세요.' }
      return allowed(event) ? { success: true, ...detail } : refused
    } catch {
      return { success: false, error: '세션 기록을 읽지 못했습니다.' }
    }
  })

  ipcMain.handle('agent-history-open-folder', async (event, shellId, key) => {
    if (!allowed(event)) return refused
    if (typeof key !== 'string' || !KEY.test(key)) return unknown
    try {
      const project = await projectForShell(shellId)
      if (!allowed(event)) return refused
      const target = history.target(key)
      if (!target || !project?.includes(target.cwd)) return unknown
      const failure = await openPath(requireLocalDirectory(target.cwd))
      return failure ? { success: false, error: failure } : { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}

module.exports = { registerAgentHistoryIpc, AGENT_HISTORY_KEY: KEY }
