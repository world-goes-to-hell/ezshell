// The fake agents of localAgentApp.js, with the agents' transcript folders inside the test profile (the
// chat view reads `$CLAUDE_CONFIG_DIR/projects`, never this PC's own ~/.claude) and chat lines recorded.
const { app, BrowserWindow, dialog, ipcMain, nativeImage, WebContentsView } = require('electron')
const fs = require('fs')
const path = require('path')
require('../../out/main/src/testWindows.js').createTestWindows(require('electron'))

const profile = app.commandLine.getSwitchValue('user-data-dir')
// A restored snapshot can include an older agent on the same shell ID.
const staleShellAgent = path.join(profile, 'stale-shell-agent')
const agentMessages = require('../../out/main/src/ipc/agentMessages.js')
const createAgentMessages = agentMessages.createAgentMessages
agentMessages.createAgentMessages = options => {
  const withStaleAgent = snapshot => {
    if (!fs.existsSync(staleShellAgent)) return snapshot
    const live = snapshot.agents.find(agent => agent.id === 'claude-1' && agent.active)
    if (!live) return snapshot
    const stale = { ...live, id: 'claude-0', status: 'idle', mcpConnected: false }
    return { ...snapshot, agents: [stale, ...snapshot.agents] }
  }
  const bridge = createAgentMessages({
    ...options,
    notify: (channel, payload) => options.notify(channel, channel === 'agent-messages-state' ? withStaleAgent(payload) : payload)
  })
  return { ...bridge, snapshot: () => withStaleAgent(bridge.snapshot()) }
}
process.env.CLAUDE_CONFIG_DIR = path.join(profile, 'claude-home')
process.env.CODEX_HOME = path.join(profile, 'codex-home')
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'test'), { recursive: true })
fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true })
const selectedImages = [2, 3].map(width => {
  const name = path.join(profile, 'attachment-' + width + '.png')
  fs.writeFileSync(name, nativeImage.createFromBitmap(Buffer.alloc(width * 4, 255), { width, height: 1 }).toPNG())
  return name
})
const showOpenDialog = dialog.showOpenDialog.bind(dialog)
dialog.showOpenDialog = (window, options) => options?.title === '채팅에 이미지 첨부'
  && options.properties.includes('multiSelections')
  ? Promise.resolve({ canceled: false, filePaths: selectedImages })
  : showOpenDialog(window, options)
const showSaveDialog = dialog.showSaveDialog.bind(dialog)
dialog.showSaveDialog = (window, options) => options?.title === '채팅 저장'
  ? Promise.resolve({ canceled: false, filePath: path.join(profile, 'saved-chat.txt') })
  : showSaveDialog(window, options)
// Read the real native view after the app has handled the bounds update.
ipcMain.on('browser-review-bounds', event => {
  const window = BrowserWindow.fromWebContents(event.sender)
  setImmediate(() => {
    if (!window || window.isDestroyed()) return
    const page = window.contentView.children.find(view => view instanceof WebContentsView && /^https?:/.test(view.webContents.getURL()))
    if (page) fs.writeFileSync(path.join(profile, 'chat-preview-browser-visible'), String(page.getVisible()))
  })
})
process.env.EZSHELL_TEST_AGENT_CHAT = '1'
require('./localAgentApp.js')
