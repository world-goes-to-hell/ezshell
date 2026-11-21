// The fake agents of localAgentApp.js, with the agents' transcript folders inside the test profile (the
// chat view reads `$CLAUDE_CONFIG_DIR/projects`, never this PC's own ~/.claude) and chat lines recorded.
const { app, dialog, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const profile = app.commandLine.getSwitchValue('user-data-dir')
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
process.env.EZSHELL_TEST_AGENT_CHAT = '1'
require('./localAgentApp.js')
