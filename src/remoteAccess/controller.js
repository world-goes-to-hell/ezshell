// Puts remote access together for main.js: the store, the shells, the server, and the IPC of the
// settings page. Only the main window may change anything here.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createAccessStore } = require('./accessStore.js')
const { findTailnetAddress } = require('./tailnet.js')
const totp = require('./totp.js')

const NOT_ALLOWED = { success: false, error: '본창에서만 바꿀 수 있습니다.' }
const APP_LOCKED = { success: false, error: '앱 잠금을 해제하세요.' }
const CANNOT_SEAL = { success: false, error: '이 PC 에서는 인증 키를 안전하게 저장할 수 없어 원격 접속을 켤 수 없습니다.' }
const LOCKED_MESSAGE = 'PC 의 ezShell 이 잠겼습니다. 잠금을 풀면 다시 접속할 수 있습니다.'
/** The log is cut back to its newer half when it passes this; looked at when starting and every so many lines */
const MAX_LOG_BYTES = 1024 * 1024
const LOG_TRIM_EVERY = 200

/**
 * @param {object} deps
 * @param {object} deps.ipcMain
 * @param {string} deps.userDataPath
 * @param {object} deps.hostKeys the app's host key store
 * @param {() => boolean} deps.isLocked
 * @param {() => Array<object>} deps.readSessions decrypted saved sessions (only while unlocked)
 * @param {() => Array<{ id: string, name: string }>} deps.readFolders
 * @param {(event: object) => boolean} deps.fromMainWindow
 * @param {(channel: string, payload?: object) => void} deps.notify to the main window
 * @param {object} [deps.sealer] seals the authenticator secret in the file (Electron safeStorage)
 */
function registerRemoteAccess({ ipcMain, userDataPath, hostKeys, isLocked, readSessions, readFolders, fromMainWindow, notify, sealer = null, networkInterfaces = os.networkInterfaces }) {
  const store = createAccessStore({ filePath: path.join(userDataPath, 'remote-access.json'), sealer })
  const logPath = path.join(userDataPath, 'remote-access.log')
  let server = null
  let lastError = null

  /** Who connected and what they opened; never what was typed or shown */
  function trimLog() {
    try {
      if (fs.statSync(logPath).size <= MAX_LOG_BYTES) return
      const lines = fs.readFileSync(logPath, 'utf-8').split('\n')
      fs.writeFileSync(logPath, lines.slice(Math.floor(lines.length / 2)).join('\n'), { mode: 0o600 })
    } catch {
      // No log yet
    }
  }
  trimLog()

  let linesSinceTrim = 0
  function log(event, detail = {}) {
    const line = `${new Date().toISOString()}\t${event}\t${JSON.stringify(detail)}\n`
    fs.appendFile(logPath, line, { mode: 0o600 }, () => {})
    // Failed attempts are logged too, so the size is looked at while running, not only at startup
    linesSinceTrim += 1
    if (linesSinceTrim >= LOG_TRIM_EVERY) {
      linesSinceTrim = 0
      trimLog()
    }
  }

  /** Names and folders only: addresses and accounts stay on the PC */
  function listSessions() {
    if (isLocked()) return []
    const folders = new Map(readFolders().map((folder) => [folder.id, String(folder.name ?? '')]))
    return readSessions()
      .filter((session) => session && session.id && !session.decryptionFailed && session.host)
      .map((session) => ({ id: String(session.id), name: String(session.name || session.host), folder: folders.get(session.folderId) ?? '' }))
      .sort((a, b) => a.folder.localeCompare(b.folder, 'ko') || a.name.localeCompare(b.name, 'ko'))
  }

  // The server and its libraries are loaded when remote access is first started
  function getServer() {
    if (!server) {
      const { createRemoteShells } = require('./shells.js')
      const { createAccessServer } = require('./server.js')
      const shells = createRemoteShells({
        findSession: (id) => (isLocked() ? null : readSessions().find((session) => session && session.id === id && !session.decryptionFailed) ?? null),
        hostKeys
      })
      server = createAccessServer({ store, shells, listSessions, isLocked, log, onChange: () => notify('remote-access-changed') })
    }
    return server
  }

  function status() {
    const tailnet = findTailnetAddress(networkInterfaces())
    const address = server?.address ?? null
    return {
      success: true,
      enabled: store.enabled,
      isRunning: Boolean(server?.isRunning),
      hasTailscale: tailnet !== null,
      url: address ? `http://${address.host}:${address.port}` : null,
      devices: store.devices(),
      connected: server ? server.connected() : [],
      error: lastError
    }
  }

  /** Listens when switched on, unlocked and Tailscale has an address; otherwise stays off */
  async function start() {
    lastError = null
    if (!store.enabled || isLocked()) return
    const host = findTailnetAddress(networkInterfaces())
    if (!host) {
      lastError = 'Tailscale 주소를 찾지 못했습니다. Tailscale 을 켠 뒤 다시 시도하세요.'
      return
    }
    try {
      await getServer().start(host, store.port)
    } catch (err) {
      lastError = err && err.code === 'EADDRINUSE' ? `${store.port}번 포트를 다른 프로그램이 쓰고 있습니다.` : `시작하지 못했습니다: ${err.message}`
    }
  }

  /** `wasLocked`: the app was locked (the devices are told so) rather than switched off */
  function stop({ wasLocked = false } = {}) {
    if (wasLocked) server?.stop(LOCKED_MESSAGE)
    else server?.stop()
  }

  function qrOf(text) {
    const qr = require('qrcode').create(text, { errorCorrectionLevel: 'M' })
    return { size: qr.modules.size, cells: Array.from(qr.modules.data) }
  }

  ipcMain.handle('remote-access-status', async (event) => {
    if (!fromMainWindow(event)) return NOT_ALLOWED
    // Tailscale may have come up after the app did
    if (store.enabled && !server?.isRunning) await start()
    return status()
  })

  ipcMain.handle('remote-access-set-enabled', async (event, isEnabled) => {
    if (!fromMainWindow(event)) return NOT_ALLOWED
    if (isLocked()) return APP_LOCKED
    // The authenticator secret is never kept in plain: without the OS store there is no remote access
    if (isEnabled === true && sealer && !sealer.isAvailable()) return CANNOT_SEAL
    store.setEnabled(isEnabled === true)
    log(isEnabled === true ? 'enabled' : 'disabled')
    if (store.enabled) await start()
    else stop()
    return status()
  })

  /** A one-time code for registering a device, as the address the phone opens */
  ipcMain.handle('remote-access-pairing', (event) => {
    if (!fromMainWindow(event)) return NOT_ALLOWED
    if (isLocked()) return APP_LOCKED
    const address = server?.address
    if (!server?.isRunning || !address) return { success: false, error: '원격 접속이 켜져 있지 않습니다.' }
    const { code, expiresAt } = store.startPairing()
    const url = `http://${address.host}:${address.port}/#pair=${code}`
    return { success: true, url, expiresAt, qr: qrOf(url) }
  })

  /** The authenticator secret, shown when the user asks to set up (or re-scan) the authenticator app */
  ipcMain.handle('remote-access-authenticator', (event) => {
    if (!fromMainWindow(event)) return NOT_ALLOWED
    if (isLocked()) return APP_LOCKED
    if (!store.totpSecret) return { success: false, error: '원격 접속을 먼저 켜세요.' }
    return { success: true, secret: store.totpSecret, qr: qrOf(totp.otpauthUrl(store.totpSecret, { account: os.hostname() })) }
  })

  ipcMain.handle('remote-access-revoke', (event, deviceId) => {
    if (!fromMainWindow(event)) return NOT_ALLOWED
    if (isLocked()) return APP_LOCKED
    const device = store.devices().find((d) => d.id === String(deviceId))
    store.revoke(String(deviceId))
    server?.disconnectDevice(String(deviceId))
    if (device) log('revoke', { device: device.name })
    return status()
  })

  return { start, stop, status }
}

module.exports = { registerRemoteAccess }
