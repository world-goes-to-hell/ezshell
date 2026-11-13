// Puts remote access together for main.js: the store, the shells, the server, and the IPC of the
// settings page. Only the main window may change anything here.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createAccessStore } = require('./accessStore.js')
const { findTailnetAddress } = require('./tailnet.js')
const totp = require('./totp.js')
const tailscaleCert = require('./tailscaleCert.js')
const webPush = require('./webPush.js')

const NOT_ALLOWED = { success: false, error: '본창에서만 바꿀 수 있습니다.' }
const APP_LOCKED = { success: false, error: '앱 잠금을 해제하세요.' }
const CANNOT_SEAL = { success: false, error: '이 PC 에서는 인증 키를 안전하게 저장할 수 없어 원격 접속을 켤 수 없습니다.' }
const LOCKED_MESSAGE = 'PC 의 ezShell 이 잠겼습니다. 잠금을 풀면 다시 접속할 수 있습니다.'
/** The log is cut back to its newer half when it passes this; looked at when starting and every so many lines */
const MAX_LOG_BYTES = 1024 * 1024
const LOG_TRIM_EVERY = 200
/**
 * How long an MCP question waits while it can be answered from a phone (the dialog alone: 60 s).
 * Under five minutes: Claude Code gives up on an HTTP MCP call that stays silent that long.
 */
const REMOTE_APPROVAL_WAIT_MS = 4 * 60 * 1000
/** A question not answered on the PC within this is announced on the phones (at once when nobody is at the PC) */
const NOTIFY_AFTER_MS = 15 * 1000
const HTTPS_OFF_NOTE = 'Tailscale 관리 화면에서 HTTPS 인증서를 켜면 휴대폰 알림을 쓸 수 있습니다.'
/** A colour as the sidebar stores it; anything else is not passed on (the phone puts it into a style) */
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i
const colorOf = (value) => (typeof value === 'string' && COLOR.test(value.trim()) ? value.trim() : null)

/**
 * The sidebar as the phone shows it: folders and sessions in the PC's order, with their names,
 * colours, which folders are open and how many tabs each session has open. Nothing else of a
 * session is copied: addresses, accounts and passwords stay on the PC.
 */
function sessionTree({ folders, sessions, expandedIds = [], openTabs = new Map() }) {
  const expanded = new Set(expandedIds)
  const tree = (Array.isArray(folders) ? folders : [])
    .filter((folder) => folder && typeof folder.id === 'string')
    .map((folder) => ({
      id: folder.id,
      name: String(folder.name ?? ''),
      parentId: typeof folder.parentId === 'string' ? folder.parentId : null,
      color: colorOf(folder.backgroundColor),
      expanded: expanded.has(folder.id)
    }))
  const names = new Map(tree.map((folder) => [folder.id, folder.name]))
  const list = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.id && !session.decryptionFailed && session.host)
    .map((session) => {
      const id = String(session.id)
      const folderId = names.has(session.folderId) ? session.folderId : null
      const tabs = openTabs.get(id)
      return {
        id,
        // Never the address in its place: a session without a name gets a label
        name: String(session.name || '').trim() || '이름 없는 세션',
        folderId,
        color: colorOf(session.backgroundColor),
        // The folder's name, for the first version of the phone page
        folder: folderId ? names.get(folderId) : '',
        openTabs: { connected: tabs?.connected ?? 0, disconnected: tabs?.disconnected ?? 0 }
      }
    })
  return { folders: tree, sessions: list }
}

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
 * @param {() => string[]} [deps.readExpandedFolders] ids of the folders open in the sidebar
 * @param {() => Map<string, { connected: number, disconnected: number }>} [deps.readOpenTabs] tabs open on the PC, by saved session
 * @param {object} [deps.mcp] the MCP side: currentApproval(), respondApproval(id, approved, device), listActivity(), cancelActivity(id)
 * @param {(request: object) => string} [deps.describeApproval] the one line a notification says about a question (its kind and risk, never its content)
 * @param {() => boolean} [deps.isUserAway] nobody has used the PC for a while (a question is announced at once)
 */
function registerRemoteAccess({ ipcMain, userDataPath, hostKeys, isLocked, readSessions, readFolders, fromMainWindow, notify, sealer = null, readExpandedFolders = () => [], readOpenTabs = () => new Map(), mcp = null, describeApproval = () => 'MCP 확인 요청', isUserAway = () => false, networkInterfaces = os.networkInterfaces, certificates = tailscaleCert, sendPush = webPush.send }) {
  const store = createAccessStore({ filePath: path.join(userDataPath, 'remote-access.json'), sealer })
  const logPath = path.join(userDataPath, 'remote-access.log')
  let server = null
  let lastError = null
  // Why notifications are not available (plain HTTP), for the settings page; null when they are
  let pushNote = null
  // The announcement waiting to be sent for the question being asked: { id, timer }
  let pendingNotice = null

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

  function listSessions() {
    if (isLocked()) return { folders: [], sessions: [] }
    return sessionTree({ folders: readFolders(), sessions: readSessions(), expandedIds: readExpandedFolders(), openTabs: readOpenTabs() })
  }

  /** MCP questions go to devices when the user wants that and a device is registered */
  const answersMcp = () => Boolean(mcp) && store.enabled && store.answerMcp && Boolean(server?.isRunning) && store.devices().length > 0
  /**
   * Whether a question would reach a phone now: a device is signed in, or one can be notified
   * (HTTPS and a subscription). Only then does a question wait longer: with a phone that cannot
   * hear of it, the longer wait would only keep the dialog open on an unattended PC.
   */
  const canReachDevice = () => answersMcp() && (server.connected().length > 0 || (server.address?.scheme === 'https' && store.pushTargets().length > 0))
  // The question a device answered last: tells "answered on the phone" from "answered on the PC"
  let answeredByDevice = null

  // The server and its libraries are loaded when remote access is first started
  function getServer() {
    if (!server) {
      const { createRemoteShells } = require('./shells.js')
      const { createAccessServer } = require('./server.js')
      const shells = createRemoteShells({
        findSession: (id) => (isLocked() ? null : readSessions().find((session) => session && session.id === id && !session.decryptionFailed) ?? null),
        hostKeys
      })
      server = createAccessServer({
        store,
        shells,
        listSessions,
        isLocked,
        log,
        onChange: () => notify('remote-access-changed'),
        approvals: mcp && {
          current: () => (answersMcp() ? mcp.currentApproval() : null),
          respond: (id, approved, device) => {
            if (!answersMcp()) return false
            // Set before answering: the question closes (approvalClosed) while respondApproval is still running
            answeredByDevice = id
            const ok = mcp.respondApproval(id, approved, device) === true
            if (!ok && answeredByDevice === id) answeredByDevice = null
            return ok
          }
        },
        // The activity log keeps the newest request first; devices get them oldest first (as the protocol says)
        activity: mcp && { list: () => [...mcp.listActivity()].reverse(), cancel: (id, device) => mcp.cancelActivity(id, device) }
      })
    }
    return server
  }

  function status() {
    const tailnet = findTailnetAddress(networkInterfaces())
    const address = server?.address ?? null
    return {
      success: true,
      enabled: store.enabled,
      answerMcp: store.answerMcp,
      isRunning: Boolean(server?.isRunning),
      hasTailscale: tailnet !== null,
      url: address ? `${address.scheme}://${address.name}:${address.port}` : null,
      push: { available: address?.scheme === 'https', note: address && address.scheme !== 'https' ? pushNote : null },
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
    // HTTPS under the tailnet name when Tailscale gives a certificate (notifications need it); HTTP otherwise
    let secure = null
    pushNote = null
    try {
      const { name, canCertify } = await certificates.tailnetName()
      if (name && canCertify) secure = { name, tls: await certificates.ensureCertificate({ dir: userDataPath, name }) }
      else pushNote = HTTPS_OFF_NOTE
    } catch (err) {
      pushNote = `HTTPS 인증서를 받지 못해 알림 없이 엽니다: ${String(err && err.message).slice(0, 200)}`
    }
    if (!store.enabled || isLocked()) return
    try {
      await getServer().start(host, store.port, secure || {})
    } catch (err) {
      lastError = err && err.code === 'EADDRINUSE' ? `${store.port}번 포트를 다른 프로그램이 쓰고 있습니다.` : `시작하지 못했습니다: ${err.message}`
    }
  }

  /** `wasLocked`: the app was locked (the devices are told so) rather than switched off */
  function stop({ wasLocked = false } = {}) {
    cancelNotice()
    if (wasLocked) server?.stop(LOCKED_MESSAGE)
    else server?.stop()
  }

  function cancelNotice() {
    if (pendingNotice) clearTimeout(pendingNotice.timer)
    pendingNotice = null
  }

  /** Tells every device that asked for notifications that a question waits. Only its kind and risk: no command, path, name or address. */
  async function announce(request) {
    if (!answersMcp() || server.address?.scheme !== 'https') return
    const targets = store.pushTargets()
    if (targets.length === 0) return
    const vapid = store.vapidKeys()
    const payload = { title: 'ezShell', body: describeApproval(request), tag: 'ezshell-mcp-approval' }
    for (const target of targets) {
      const result = await sendPush({ subscription: target.subscription, payload, vapid })
      log(result.ok ? 'push' : 'push-failed', { device: target.name, status: result.status })
      // The browser dropped the subscription (notifications switched off there, or the site's data cleared)
      if (result.gone) store.setPush(target.deviceId, null)
    }
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
    else {
      stop()
      certificates.removeCertificate?.(userDataPath)
    }
    return status()
  })

  ipcMain.handle('remote-access-set-answer-mcp', (event, isOn) => {
    if (!fromMainWindow(event)) return NOT_ALLOWED
    if (isLocked()) return APP_LOCKED
    store.setAnswerMcp(isOn === true)
    log(isOn === true ? 'answer-mcp-on' : 'answer-mcp-off')
    return status()
  })

  /** A one-time code for registering a device, as the address the phone opens */
  ipcMain.handle('remote-access-pairing', (event) => {
    if (!fromMainWindow(event)) return NOT_ALLOWED
    if (isLocked()) return APP_LOCKED
    const address = server?.address
    if (!server?.isRunning || !address) return { success: false, error: '원격 접속이 켜져 있지 않습니다.' }
    const { code, expiresAt } = store.startPairing()
    const url = `${address.scheme}://${address.name}:${address.port}/#pair=${code}`
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

  return {
    start,
    stop,
    status,
    /** An MCP question is being shown on the PC: signed-in devices get it too */
    showApproval: (request) => {
      if (!answersMcp()) return
      server.showApproval(request)
      // Not answered on the PC soon: the phones are told (at once when nobody is at the PC)
      cancelNotice()
      const timer = setTimeout(() => {
        pendingNotice = null
        announce(request).catch(() => {})
      }, isUserAway() ? 0 : NOTIFY_AFTER_MS)
      pendingNotice = { id: request.id, timer }
    },
    /** The question ended (answered on the PC or a device, timed out, cancelled) */
    approvalClosed: (id, outcome) => {
      if (pendingNotice && pendingNotice.id === id) cancelNotice()
      const wasAnswered = outcome === 'approved' || outcome === 'denied'
      const by = !wasAnswered ? null : answeredByDevice === id ? 'device' : 'pc'
      if (answeredByDevice === id) answeredByDevice = null
      server?.closeApproval(id, outcome, by)
    },
    /** The least time an MCP question waits: longer while a device could answer it */
    approvalWaitMs: () => (canReachDevice() ? REMOTE_APPROVAL_WAIT_MS : 0),
    activityItem: (item) => server?.activityItem(item),
    activityOutput: (payload) => server?.activityOutput(payload)
  }
}

module.exports = { registerRemoteAccess, sessionTree, REMOTE_APPROVAL_WAIT_MS, NOTIFY_AFTER_MS }
