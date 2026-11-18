// Launch the real Electron app with local fixtures for the clipboard and the two agent executables.
const { app, clipboard, ipcMain, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const pty = require('node-pty')
const { PROMPT } = require('../../src/ipc/agentInboxWake.js')

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
    fs.writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_TEST_AGENT_SCRIPT%" ' + name + ' %*\r\n')
  } else {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$EZSHELL_TEST_AGENT_EXE" "$EZSHELL_TEST_AGENT_SCRIPT" ' + name + ' "$@"\n', { mode: 0o700 })
  }
}
clipboard.readText = () => {
  try { return fs.readFileSync(path.join(profile, 'clipboard-text'), 'utf8') } catch { return '' }
}
clipboard.readImage = () => nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
const spawn = pty.spawn
pty.spawn = (file, args, options) => {
  const child = spawn(file, args, options)
  let id = options.env.EZSHELL_AGENT_ID
  // Give the fake agent a composer without relying on Electron's run-as-node console input modes.
  const write = child.write.bind(child)
  let pending = false
  let turns = 0
  child.write = data => {
    if (!id && data === 'claude\r') id = 'manual-claude'
    if (id && data === '\x1b[200~' + PROMPT + '\x1b[201~') {
      pending = true
      fs.writeFileSync(path.join(profile, id + '-draft'), PROMPT)
    } else if (pending && data === '\r') {
      pending = false
      fs.writeFileSync(path.join(profile, id + '-wakes'), String(++turns))
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
