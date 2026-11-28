// Launch the real Electron app with local fixtures for the clipboard and the two agent executables.
const { app, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, Notification } = require('electron')
const fs = require('fs')
const path = require('path')
const pty = require('node-pty')
// pty.spawn is replaced below: shells must open in this process, not in the session host
process.env.EZSHELL_TEST_NO_SESSION_HOST = '1'
const { PROMPT, BUSY_PROMPT, REMIND_PROMPT } = require('../../src/ipc/agentInboxWake.js')
const { createFakeAskDialog } = require('./fakeAskDialog.js')
require('../../out/main/src/testWindows.js').createTestWindows(require('electron'))

const profile = app.commandLine.getSwitchValue('user-data-dir')
const inboxWake = require('../../out/main/src/ipc/agentInboxWake.js')
const createAgentInboxWake = inboxWake.createAgentInboxWake
inboxWake.createAgentInboxWake = options => createAgentInboxWake({
  ...options,
  ...(options.kind === 'codex' && fs.existsSync(path.join(profile, 'test-inbox-draft-notice')) && { draftNoticeMs: 900 })
})
process.env.CODEX_HOME = path.join(profile, 'codex-home')
const notificationLog = path.join(profile, 'test-notifications')
const notificationSupported = Notification.isSupported.bind(Notification)
const showNotification = Notification.prototype.show
Notification.isSupported = () => fs.existsSync(notificationLog) || notificationSupported()
Notification.prototype.show = function (...args) {
  if (!fs.existsSync(notificationLog)) return showNotification.apply(this, args)
  fs.appendFileSync(notificationLog, JSON.stringify({ title: this.title, body: this.body }) + '\n')
}
const writeClipboard = clipboard.writeText.bind(clipboard)
clipboard.writeText = (text, ...args) => {
  if (path.basename(text) === 'passwords.csv' && path.basename(path.dirname(text)).startsWith('ezshell-password-import-')) {
    fs.writeFileSync(path.join(profile, 'browser-export-destination'), text)
    return
  }
  return writeClipboard(text, ...args)
}
const browserImportSources = require('../../out/main/src/ipc/browserImportSources.js')
const createBrowserImportSources = browserImportSources.createBrowserImportSources
browserImportSources.createBrowserImportSources = () => {
  const local = path.join(profile, 'browser-import-local')
  const chrome = path.join(local, 'Google', 'Chrome')
  const userData = path.join(chrome, 'User Data')
  for (const dir of [path.join(chrome, 'Application'), path.join(userData, 'Default'), path.join(userData, 'Profile 1')]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(chrome, 'Application', 'chrome.exe'), '')
  fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: '개인' }, 'Profile 1': { name: '업무' } } },
  }))
  return createBrowserImportSources({
    platform: 'win32', home: profile, env: { LOCALAPPDATA: local },
    launch: (_executable, args) => fs.writeFileSync(path.join(profile, 'browser-source-launch.json'), JSON.stringify(args)),
  })
}
const openFileDialog = dialog.showOpenDialog.bind(dialog)
dialog.showOpenDialog = (window, options) => {
  if (options?.title === '새 세션의 작업 폴더 선택') {
    fs.writeFileSync(path.join(profile, 'test-agent-request-dialog'), JSON.stringify(options))
    const selection = path.join(profile, 'test-agent-request-folder')
    const folder = fs.existsSync(selection) ? fs.readFileSync(selection, 'utf8') : ''
    return Promise.resolve({ canceled: !folder, filePaths: folder ? [folder] : [] })
  }
  if (options?.title === '수정 요청에 이미지 첨부') {
    const filePaths = [36, 52].map(width => {
      const file = path.join(profile, `review-${width}.png`)
      const image = nativeImage.createFromBitmap(Buffer.alloc(width * 24 * 4, 255), { width, height: 24 })
      fs.writeFileSync(file, image.toPNG())
      return file
    })
    return Promise.resolve({ canceled: false, filePaths })
  }
  const loginCsv = path.join(profile, 'browser-login-import.csv')
  return options?.title === '브라우저 비밀번호 CSV 가져오기' && fs.existsSync(loginCsv)
    ? Promise.resolve({ canceled: false, filePaths: [loginCsv] }) : openFileDialog(window, options)
}
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
if (!process.env.EZSHELL_TEST_MANUAL_CLAUDE_CHAT) fs.writeFileSync(path.join(profile, 'agent-message-connection'), '')
for (const name of ['codex', 'claude']) {
  if (process.platform === 'win32') {
    const help = name === 'codex' ? 'if "%~1"=="--help" (echo   --no-daemon& exit /b 0)\r\n' : ''
    fs.writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\nsetlocal\r\n' + help + 'set ELECTRON_RUN_AS_NODE=1\r\n"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_TEST_AGENT_SCRIPT%" ' + name + ' %*\r\n')
  } else {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$EZSHELL_TEST_AGENT_EXE" "$EZSHELL_TEST_AGENT_SCRIPT" ' + name + ' "$@"\n', { mode: 0o700 })
  }
}
const readClipboardFixture = name => {
  try { return fs.readFileSync(path.join(profile, name), 'utf8') } catch { return '' }
}
clipboard.readText = async () => readClipboardFixture('clipboard-text') || readClipboardFixture('clipboard-comment')
const screenshot = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG()
clipboard.read = async () => {
  const text = readClipboardFixture('clipboard-text')
  if (text) return [new ClipboardItem({ 'text/plain': text })]
  const comment = readClipboardFixture('clipboard-comment')
  return [new ClipboardItem({
    'image/png': new Blob([screenshot], { type: 'image/png' }),
    ...(comment && { 'text/plain': comment })
  })]
}
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
  let speed = 'default'
  let screenOpen = false
  let loginOpen = false
  const codexImages = []
  // Claude's AskUserQuestion dialog (local-agent-chat): `<id>-ask-dialog` holds its questions; the keys go
  // to the fake dialog, its screen is drawn as the fixture's prompt and the answers land in `<id>-ask-submitted`
  let askDialog = null
  const showAskDialog = () => {
    fs.writeFileSync(path.join(profile, id + '-approval'), askDialog.lines().join('\r\n'))
    if (askDialog.state.submitted) {
      fs.writeFileSync(path.join(profile, id + '-ask-submitted'), JSON.stringify(askDialog.state.submitted))
      askDialog = null
    }
  }
  const askTimer = setInterval(() => {
    const file = id && path.join(profile, id + '-ask-dialog')
    if (!file || !fs.existsSync(file)) return
    askDialog = createFakeAskDialog(JSON.parse(fs.readFileSync(file, 'utf8')))
    fs.unlinkSync(file)
    showAskDialog()
  }, 50)
  askTimer.unref?.()
  child.onExit?.(() => clearInterval(askTimer))
  child.write = data => {
    if (id && askDialog) {
      fs.appendFileSync(path.join(profile, id + '-ask-keys'), JSON.stringify(data) + '\n')
      askDialog.write(data)
      showAskDialog()
      return
    }
    // Everything typed or pasted into the agent (local-agent-chat-images: files dropped on the terminal)
    fs.appendFileSync(path.join(profile, (id || 'shell') + '-input'), data)
    if (!id && /^claude(?: [^\r]*)?\r$/.test(data)) id = 'manual-claude'
    if (!id && data === 'codex --yolo\r') id = 'manual-codex'
    const pasted = data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~') ? data.slice(6, -6) : null
    if (id && (data === '\x16' || data === '\x1bv')) {
      fs.appendFileSync(path.join(profile, id + '-image-paste'), data)
    } else if (id && pasted !== null && counters[pasted]) {
      pending = counters[pasted]
      fs.writeFileSync(path.join(profile, id + '-draft'), pasted)
    } else if (id && (pasted === '/exit' || pasted === '/quit')) {
      // Closing the CLI (agentIdle.js puts an idle agent to sleep): Enter ends the fake agent
      pending = 'exit-command'
      fs.writeFileSync(path.join(profile, id + '-draft'), pasted)
    } else if (id?.startsWith('codex-') && ['/fast', '/ultrafas', '/ultrafast'].includes(pasted) && process.env.EZSHELL_TEST_AGENT_CHAT) {
      pending = pasted === '/ultrafas' ? 'speed-probe' : pasted.slice(1) + '-toggles'
      fs.writeFileSync(path.join(profile, id + '-draft'), pasted)
    } else if (id?.startsWith('claude-') && process.env.EZSHELL_TEST_AGENT_CHAT && pasted === '/login') {
      pending = 'login'
      fs.writeFileSync(path.join(profile, id + '-draft'), pasted)
    } else if (pending === 'login' && data === '\r') {
      pending = null
      loginOpen = true
      fs.writeFileSync(path.join(profile, id + '-draft'), '')
      fs.writeFileSync(path.join(profile, id + '-screen'), [
        '────────────', '❯ ', '────────────', '? for shortcuts', 'Login', '  Paste code here if prompted'
      ].join('\r\n'))
    } else if (loginOpen && (data === '\r' || data === '\x1b')) {
      loginOpen = false
      fs.writeFileSync(path.join(profile, id + '-login-closed'), data === '\r' ? 'confirmed' : 'cancelled')
      fs.writeFileSync(path.join(profile, id + '-screen'), '')
    } else if (id && process.env.EZSHELL_TEST_AGENT_CHAT && (pasted === '/config' || (id.startsWith('codex-') && pasted === '/model'))) {
      // A slash command that opens a screen of the CLI's own: Enter opens it, Esc closes it
      pending = pasted === '/model' ? 'model-screen' : 'screen-command'
      fs.writeFileSync(path.join(profile, id + '-draft'), pasted)
    } else if (['screen-command', 'model-screen'].includes(pending) && data === '\r') {
      const screen = pending === 'model-screen' ? [
        '🔌  MCP Tools',
        '  • codex_apps: connected (108 tools)',
        '',
        '  Select Model and Effort',
        '› 1. GPT-6.2-Sol (current)  Fast model.',
        '  2. GPT-6.2-Astra          For complex work.',
        '  ↓',
        '  enter select · esc back'
      ].join('\r\n') : 'Settings\r\n  Theme      dark\r\n  Esc to close'
      pending = null
      screenOpen = true
      fs.writeFileSync(path.join(profile, id + '-draft'), '')
      fs.writeFileSync(path.join(profile, id + '-screen'), screen)
    } else if (screenOpen && data === '\x1b') {
      screenOpen = false
      fs.appendFileSync(path.join(profile, id + '-screen-closed'), 'x')
      fs.writeFileSync(path.join(profile, id + '-screen'), '')
    } else if (id && pasted !== null && process.env.EZSHELL_TEST_AGENT_CHAT) {
      // A line from the chat view (e2e/specs/local-agent-chat.js): the fake composer draws it, Enter counts
      pending = 'chat-sent'
      const image = /^(?:codex-\d+|manual-codex)$/.test(id) && path.isAbsolute(pasted) && pasted.endsWith('.png') && fs.existsSync(pasted)
      if (image) codexImages.push(pasted)
      const body = image ? '' : pasted
      const chipFile = path.join(profile, id + '-paste-chip')
      const chip = fs.existsSync(chipFile) ? fs.readFileSync(chipFile, 'utf8') : null
      if (chip !== null) fs.unlinkSync(chipFile)
      const draft = chip ?? [...codexImages.map((_, index) => `[Image #${index + 1}]`), body].filter(Boolean).join(' ')
      fs.writeFileSync(path.join(profile, id + '-chat-text'), body)
      fs.writeFileSync(path.join(profile, id + '-draft'), draft)
    } else if (id && data === '\x1b' && process.env.EZSHELL_TEST_AGENT_CHAT) {
      fs.appendFileSync(path.join(profile, id + '-chat-interrupt'), 'esc')
      // As Claude does when its turn is stopped: a queued chat line comes back into the composer
      const restore = path.join(profile, id + '-restore-on-esc')
      if (fs.existsSync(restore)) {
        fs.writeFileSync(path.join(profile, id + '-draft'), fs.readFileSync(restore, 'utf8'))
        fs.unlinkSync(restore)
      }
    } else if (id && /^[1-9]$/.test(data) && process.env.EZSHELL_TEST_AGENT_CHAT) {
      // A choice of the fake prompt: answered at once, the composer comes back
      fs.appendFileSync(path.join(profile, id + '-approval-answer'), data)
      fs.writeFileSync(path.join(profile, id + '-approval'), '')
    } else if (pending === 'speed-probe' && data === '\x7f'.repeat('/ultrafas'.length)) {
      fs.writeFileSync(path.join(profile, id + '-speed-checked'), 'yes')
      pending = null
      fs.writeFileSync(path.join(profile, id + '-draft'), '')
    } else if (id && /^\x15+\x0b+$/.test(data) && process.env.EZSHELL_TEST_AGENT_CHAT) {
      fs.appendFileSync(path.join(profile, id + '-forced-clear'), 'x')
      // In the paste-chip case Claude redraws only after the next paste, skipping the empty frame.
      if (!fs.existsSync(path.join(profile, id + '-paste-chip'))) fs.writeFileSync(path.join(profile, id + '-draft'), '')
    } else if (id && pending !== 'speed-probe' && /^\x7f+$/.test(data) && process.env.EZSHELL_TEST_AGENT_CHAT) {
      // The chat taking that line back (agentInboxWake.takeBack): the composer empties
      fs.appendFileSync(path.join(profile, id + '-taken-back'), 'x')
      fs.writeFileSync(path.join(profile, id + '-draft'), '')
    } else if (pending === 'exit-command' && data === '\r') {
      pending = null
      fs.appendFileSync(path.join(profile, id + '-exits'), 'x')
      fs.writeFileSync(path.join(profile, id + '-exit-code'), '0')
    } else if (pending && data === '\r') {
      if (pending === 'chat-sent' && codexImages.length) {
        fs.writeFileSync(path.join(profile, id + '-chat-images'), JSON.stringify(codexImages))
        codexImages.length = 0
      }
      if (pending === 'chat-sent' && id?.startsWith('codex-') && process.env.EZSHELL_TEST_AGENT_CHAT) {
        const command = fs.readFileSync(path.join(profile, id + '-chat-text'), 'utf8')
        const output = {
          '/mcp': [
            '🔌  MCP Tools',
            '  • codex_apps: connected (108 tools)',
            '  • ezshell-cli-mcp: failed (7 tools)',
            '  • msw-mcp: authentication required (0 tools)',
            '  Use /mcp verbose for tools and resources.',
            '  Unknown MCP diagnostic.'
          ],
          '/mcp verbose': ['🔌  MCP Tools', '  • Tools: test_tool'],
          '/mcp login msw-mcp': ['Login requested for msw-mcp.']
        }
        if (Object.hasOwn(output, command)) {
          const withoutEcho = command === '/mcp' && fs.existsSync(path.join(profile, id + '-mcp-without-echo'))
          const history = withoutEcho ? [] : [
            'local bridge after the MCP transport closed.',
            'Worked for 8m 0s • 11:51 PM',
            '• Context compacted · 36s',
            'Worked for 36s',
            '',
            '› ' + command,
            ''
          ]
          const rows = [...history, ...output[command], '', '']
          fs.writeFileSync(path.join(profile, id + '-command-history'), rows.join('\r\n'))
        }
      }
      if (pending === 'fast-toggles' || pending === 'ultrafast-toggles') {
        const target = pending === 'fast-toggles' ? 'priority' : 'ultrafast'
        speed = speed === target ? 'default' : target
        fs.writeFileSync(path.join(profile, id + '-speed'), speed)
      }
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
