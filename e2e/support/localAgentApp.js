// Launch the real Electron app with local fixtures for the clipboard and the two agent executables.
const { app, clipboard, ClipboardItem, ipcMain, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const pty = require('node-pty')
const { PROMPT, BUSY_PROMPT, REMIND_PROMPT } = require('../../src/ipc/agentInboxWake.js')

const profile = app.commandLine.getSwitchValue('user-data-dir')
const bin = path.join(profile, 'fake-agents')
fs.mkdirSync(bin)
const envKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
const system = process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32')
// node-pty 1.1 on Windows checks only PATH entries which end in a semicolon.
process.env[envKey] = [bin, ...(system ? [path.join(system, 'WindowsPowerShell', 'v1.0'), system] : ['/usr/bin', '/bin'])].join(path.delimiter)
process.env.EZSHELL_TEST_AGENT_PROFILE = profile
process.env.EZSHELL_TEST_AGENT_EXE = process.execPath
process.env.EZSHELL_TEST_AGENT_SCRIPT = path.join(__dirname, 'localAgentFixture.js')
// Simulate an existing user-level MCP registration so the app starts its bridge.
fs.writeFileSync(path.join(profile, 'agent-message-connection'), '')
for (const name of ['codex', 'claude']) {
  if (process.platform === 'win32') {
    const help = name === 'codex' ? 'if "%~1"=="--help" (echo   --no-daemon& exit /b 0)\r\n' : ''
    fs.writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\nsetlocal\r\n' + help + 'set ELECTRON_RUN_AS_NODE=1\r\n"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_TEST_AGENT_SCRIPT%" ' + name + ' %*\r\n')
  } else {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$EZSHELL_TEST_AGENT_EXE" "$EZSHELL_TEST_AGENT_SCRIPT" ' + name + ' "$@"\n', { mode: 0o700 })
  }
}
clipboard.readText = async () => {
  try { return fs.readFileSync(path.join(profile, 'clipboard-text'), 'utf8') } catch { return '' }
}
const screenshot = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG()
clipboard.read = async () => [new ClipboardItem({
  'image/png': new Blob([screenshot], { type: 'image/png' })
})]
const spawn = pty.spawn
pty.spawn = (file, args, options) => {
  const child = spawn(file, args, options)
  let id = options.env.EZSHELL_AGENT_ID
  // Give the fake agent a composer without relying on Electron's run-as-node console input modes.
  const write = child.write.bind(child)
  // The idle and reminder lines start a turn (-wakes); the busy notice goes into the running task (-busy-wakes)
  const counters = { [PROMPT]: 'wakes', [REMIND_PROMPT]: 'wakes', [BUSY_PROMPT]: 'busy-wakes' }
  const counts = {}
  let pending = null
  child.write = data => {
    if (!id && data === 'claude\r') id = 'manual-claude'
    if (!id && data === 'codex --yolo\r') id = 'manual-codex'
    const pasted = data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~') ? data.slice(6, -6) : null
    if (id && (data === '\x16' || data === '\x1bv')) {
      fs.appendFileSync(path.join(profile, id + '-image-paste'), data)
    } else if (id && pasted !== null && counters[pasted]) {
      pending = counters[pasted]
      fs.writeFileSync(path.join(profile, id + '-draft'), pasted)
    } else if (id && pasted !== null && process.env.EZSHELL_TEST_AGENT_CHAT) {
      // A line from the chat view (e2e/specs/local-agent-chat.js): the fake composer draws it, Enter counts
      pending = 'chat-sent'
      fs.writeFileSync(path.join(profile, id + '-chat-text'), pasted)
      fs.writeFileSync(path.join(profile, id + '-draft'), pasted)
    } else if (id && data === '\x1b' && process.env.EZSHELL_TEST_AGENT_CHAT) {
      fs.appendFileSync(path.join(profile, id + '-chat-interrupt'), 'esc')
    } else if (id && /^[1-9]$/.test(data) && process.env.EZSHELL_TEST_AGENT_CHAT) {
      // A choice of the fake prompt: answered at once, the composer comes back
      fs.appendFileSync(path.join(profile, id + '-approval-answer'), data)
      fs.writeFileSync(path.join(profile, id + '-approval'), '')
    } else if (pending && data === '\r') {
      counts[pending] = (counts[pending] ?? 0) + 1
      fs.writeFileSync(path.join(profile, id + '-' + pending), String(counts[pending]))
      pending = null
      fs.writeFileSync(path.join(profile, id + '-draft'), '')
    } else {
      write(data)
    }
  }
  return child
}
// Capture the bytes sent to the PTY independently of the fake Windows child console's input mode.
ipcMain.on('local-shell-write', (_event, { id, data }) => {
  fs.appendFileSync(path.join(profile, id.replace(':', '-') + '-input'), data)
})
require('../../out/main/index.js')
