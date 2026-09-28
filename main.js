const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');
const net = require('net');
const { autoUpdater } = require('electron-updater');
const cryptoUtil = require('./src/crypto.js');
const commandHistory = require('./src/commandHistory.js');

let mainWindow;

// 터미널 전용 창 저장소
const terminalWindows = new Map();

// 세션에 해당하는 윈도우 반환 (터미널 창 우선, 없으면 메인 창)
function getWindowForSession(sessionId) {
  // 터미널 전용 창이 있으면 해당 창으로 전송
  if (terminalWindows.has(sessionId)) {
    const terminalWindow = terminalWindows.get(sessionId);
    if (!terminalWindow.isDestroyed()) {
      return terminalWindow;
    }
  }
  // 없으면 메인 창으로 전송
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return null;
}

// Master password state
let masterPasswordVerification = null; // { hash, salt }
let currentMasterPassword = null; // In-memory only, cleared on lock
let isAppLocked = true;
const sshConnections = new Map();
const sshStreams = new Map(); // sessionId:streamId -> stream (for split terminals)
const splitStreamLastClosed = new Map(); // sessionId -> timestamp of last split stream close
let splitStreamSeq = 0;

// Diagnostics for "Channel open failure": how many channels this SSH connection holds open.
// Reads ssh2's internal channel manager, so it degrades to '?' if that ever changes.
function openChannelCount(conn) {
  const mgr = conn && conn._chanMgr;
  return mgr && typeof mgr._count === 'number' ? mgr._count : '?';
} // makes split streamIds unique even when shells open in the same millisecond
const portForwards = new Map(); // forwardId -> { type, server, sessionId, localHost, localPort, remoteHost, remotePort, connectionCount }

// Connection state management
const ConnectionState = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  RECONNECTING: 'reconnecting'
};

const connectionStates = new Map(); // sessionId -> { state, config, retryCount, autoReconnect }

function updateConnectionState(sessionId, state) {
  const connState = connectionStates.get(sessionId);
  if (connState) {
    connState.state = state;
    const targetWindow = getWindowForSession(sessionId);
    if (targetWindow) {
      targetWindow.webContents.send('ssh-state-changed', { sessionId, state });
    }
  }
}

// 세션 저장 경로
const userDataPath = app.getPath('userData');
const sessionsFilePath = path.join(userDataPath, 'sessions.json');
const foldersFilePath = path.join(userDataPath, 'folders.json');
const settingsFilePath = path.join(userDataPath, 'settings.json');

// 파일에서 데이터 로드
function loadFromFile(filePath, defaultValue = []) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`Failed to load ${filePath}:`, error);
  }
  return defaultValue;
}

// 파일에 데이터 저장
function saveToFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error(`Failed to save ${filePath}:`, error);
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  // Load from Vite dev server in development, built files in production
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // Disable Electron's built-in zoom, use IPC for terminal-only font size control
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && !input.alt && !input.meta) {
      if (input.key === '=' || input.key === '+') {
        event.preventDefault()
        mainWindow.webContents.send('terminal-zoom', 'in')
      } else if (input.key === '-' || input.key === '_') {
        event.preventDefault()
        mainWindow.webContents.send('terminal-zoom', 'out')
      } else if (input.key === '0') {
        event.preventDefault()
        mainWindow.webContents.send('terminal-zoom', 'reset')
      }
    }
  })

  // 렌더러 콘솔 로그를 메인 프로세스에 출력 (개발 모드만)
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Renderer] ${message}`);
    });
  }

  // 렌더러 오류 캡처
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc) => {
    console.error(`[Renderer Load Error] ${errorCode}: ${errorDesc}`);
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking');
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    });
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus('not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus('downloading', {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus('downloaded', {
      version: info.version
    });
  });

  autoUpdater.on('error', (err) => {
    sendUpdateStatus('error', { message: err.message });
  });

  // Check for updates after 3 seconds
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);
}

function sendUpdateStatus(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { status, ...data });
  }
}

app.whenReady().then(() => {
  createWindow();

  // Auto-updater setup (production only)
  if (!process.env.ELECTRON_RENDERER_URL && !process.argv.includes('--dev')) {
    setupAutoUpdater();
  }
});

// SFTP 별도 창 저장소
const sftpWindows = new Map();

function createSftpWindow(sessionId, localPath, remotePath) {
  const sftpWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    frame: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  // Pass session info via query params
  const params = new URLSearchParams({
    sftpMode: 'true',
    sessionId,
    localPath: encodeURIComponent(localPath),
    remotePath: encodeURIComponent(remotePath)
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    sftpWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${params.toString()}`)
  } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    sftpWindow.loadURL(`http://localhost:5173?${params.toString()}`)
  } else {
    sftpWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { sftpMode: 'true', sessionId, localPath, remotePath }
    })
  }

  sftpWindows.set(sessionId, sftpWindow);

  sftpWindow.on('closed', () => {
    sftpWindows.delete(sessionId);
  });

  return sftpWindow;
}

function createTerminalWindow(sessionId, title) {
  const terminalWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    frame: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  const params = new URLSearchParams({
    terminalMode: 'true',
    sessionId,
    title: encodeURIComponent(title || sessionId)
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    terminalWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${params.toString()}`)
  } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    terminalWindow.loadURL(`http://localhost:5173?${params.toString()}`)
  } else {
    terminalWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { terminalMode: 'true', sessionId, title }
    })
  }

  terminalWindows.set(sessionId, terminalWindow);

  terminalWindow.on('closed', () => {
    terminalWindows.delete(sessionId);
  });

  return terminalWindow;
}

// 터미널 창 열기 핸들러
ipcMain.handle('open-terminal-window', (event, { sessionId, title }) => {
  if (terminalWindows.has(sessionId)) {
    const existingWindow = terminalWindows.get(sessionId);
    if (!existingWindow.isDestroyed()) {
      existingWindow.focus();
      return { success: true, existing: true };
    }
  }

  createTerminalWindow(sessionId, title);
  return { success: true };
});

// 터미널 창을 메인 창으로 병합
ipcMain.handle('merge-terminal-to-main', (event, { sessionId, title, host, username }) => {
  // 메인 창에 터미널 추가 요청
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal-merge', { sessionId, title, host, username });
    mainWindow.focus();
  }

  // 터미널 창 닫기
  if (terminalWindows.has(sessionId)) {
    const terminalWindow = terminalWindows.get(sessionId);
    if (!terminalWindow.isDestroyed()) {
      terminalWindow.close();
    }
    terminalWindows.delete(sessionId);
  }

  return { success: true };
});

// SFTP 창 열기 핸들러
ipcMain.handle('open-sftp-window', (event, { sessionId, localPath, remotePath }) => {
  // Check if window already exists
  if (sftpWindows.has(sessionId)) {
    const existingWindow = sftpWindows.get(sessionId);
    if (!existingWindow.isDestroyed()) {
      existingWindow.focus();
      return { success: true, existing: true };
    }
  }

  createSftpWindow(sessionId, localPath, remotePath);
  return { success: true };
});

app.on('window-all-closed', () => {
  flushCommandHistory();
  // 모든 SSH 연결 종료
  sshConnections.forEach(({ conn }) => {
    try { conn.end(); } catch (e) {}
  });
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ==================== Master Password Handlers ====================

// Check if master password is set
ipcMain.handle('has-master-password', async () => {
  const verificationPath = path.join(app.getPath('userData'), 'master.json');
  return fs.existsSync(verificationPath);
});

// Setup master password (first time)
ipcMain.handle('setup-master-password', async (event, { password }) => {
  if (password.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters' };
  }

  const verification = cryptoUtil.hashPassword(password);
  const verificationPath = path.join(app.getPath('userData'), 'master.json');

  fs.writeFileSync(verificationPath, JSON.stringify(verification, null, 2));
  masterPasswordVerification = verification;
  currentMasterPassword = password;
  isAppLocked = false;

  return { success: true };
});

// Verify and unlock with master password
ipcMain.handle('unlock-app', async (event, { password }) => {
  const verificationPath = path.join(app.getPath('userData'), 'master.json');

  if (!fs.existsSync(verificationPath)) {
    return { success: false, error: 'No master password set' };
  }

  const verification = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));

  if (cryptoUtil.verifyPassword(password, verification.hash, verification.salt)) {
    currentMasterPassword = password;
    isAppLocked = false;
    return { success: true };
  }

  return { success: false, error: 'Incorrect password' };
});

// Lock the app
ipcMain.handle('lock-app', async () => {
  // Write pending history while the password is still known, then drop the decrypted copy
  flushCommandHistory();
  commandHistoryCache = null;
  currentMasterPassword = null;
  isAppLocked = true;
  return { success: true };
});

// Check if app is locked
ipcMain.handle('is-app-locked', async () => {
  return { locked: isAppLocked };
});

// Save password for auto-unlock (uses OS keychain via safeStorage)
ipcMain.handle('save-auto-unlock', async (event, { password }) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'OS 암호화를 사용할 수 없습니다.' };
    }
    const encrypted = safeStorage.encryptString(password);
    const tokenPath = path.join(app.getPath('userData'), 'auto-unlock.dat');
    fs.writeFileSync(tokenPath, encrypted);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Load saved password for auto-unlock
ipcMain.handle('load-auto-unlock', async () => {
  try {
    const tokenPath = path.join(app.getPath('userData'), 'auto-unlock.dat');
    if (!fs.existsSync(tokenPath)) {
      return { success: false, hasToken: false };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'OS 암호화를 사용할 수 없습니다.' };
    }
    const encrypted = fs.readFileSync(tokenPath);
    const password = safeStorage.decryptString(encrypted);
    return { success: true, hasToken: true, password };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Clear saved auto-unlock token
ipcMain.handle('clear-auto-unlock', async () => {
  try {
    const tokenPath = path.join(app.getPath('userData'), 'auto-unlock.dat');
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Check if auto-unlock token exists
ipcMain.handle('has-auto-unlock', async () => {
  const tokenPath = path.join(app.getPath('userData'), 'auto-unlock.dat');
  return fs.existsSync(tokenPath);
});

// Reset master password (clears all data)
ipcMain.handle('reset-master-password', async () => {
  const verificationPath = path.join(app.getPath('userData'), 'master.json');
  const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
  const foldersPath = path.join(app.getPath('userData'), 'folders.json');

  if (fs.existsSync(verificationPath)) fs.unlinkSync(verificationPath);
  if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath);
  if (fs.existsSync(foldersPath)) fs.unlinkSync(foldersPath);
  // Encrypted with the old password, so it can never be read again
  discardCommandHistory();

  currentMasterPassword = null;
  isAppLocked = true;
  masterPasswordVerification = null;

  return { success: true };
});

// ==================== Encrypted Session Storage ====================

// 세션 저장/로드 IPC (with encryption)
ipcMain.handle('load-sessions', async () => {
  if (isAppLocked || !currentMasterPassword) {
    return { success: false, error: 'App is locked', sessions: [] };
  }

  const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');

  if (!fs.existsSync(sessionsPath)) {
    return { success: true, sessions: [] };
  }

  try {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));

    const decryptedSessions = sessions.map(session => {
      // Handle legacy unencrypted sessions (migration)
      if (!session.encrypted && !session.encryptedVersion) {
        // This is a legacy session, mark for migration on next save
        return { ...session, needsMigration: true };
      }

      try {
        const decrypted = JSON.parse(
          cryptoUtil.decrypt(session.encrypted, currentMasterPassword)
        );

        const { encrypted, encryptedVersion, ...safeSession } = session;
        return {
          ...safeSession,
          ...decrypted
        };
      } catch (err) {
        console.error('Failed to decrypt session:', session.name);
        return { ...session, decryptionFailed: true };
      }
    });

    return { success: true, sessions: decryptedSessions };
  } catch (err) {
    console.error('Failed to load sessions:', err);
    return { success: false, error: err.message, sessions: [] };
  }
});

ipcMain.handle('save-sessions', async (event, sessions) => {
  if (isAppLocked || !currentMasterPassword) {
    return { success: false, error: 'App is locked' };
  }

  const encryptedSessions = sessions.map(session => {
    // Encrypt sensitive fields
    const sensitiveData = JSON.stringify({
      password: session.password || null,
      passphrase: session.passphrase || null,
      privateKeyPath: session.privateKeyPath || null
    });

    const encrypted = cryptoUtil.encrypt(sensitiveData, currentMasterPassword);

    // Return session without sensitive fields, with encrypted blob
    const { password, passphrase, privateKeyPath, needsMigration, decryptionFailed, ...safeSession } = session;
    return {
      ...safeSession,
      encrypted,
      encryptedVersion: 1
    };
  });

  const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
  fs.writeFileSync(sessionsPath, JSON.stringify(encryptedSessions, null, 2));

  return { success: true };
});

ipcMain.handle('load-folders', () => {
  return {
    folders: loadFromFile(foldersFilePath, []),
    expandedFolders: loadFromFile(path.join(userDataPath, 'folders-expanded.json'), [])
  };
});

ipcMain.handle('save-folders', (event, { folders, expandedFolders }) => {
  saveToFile(foldersFilePath, folders);
  // JSON.stringify(undefined) is undefined, which makes writeFileSync throw
  if (Array.isArray(expandedFolders)) {
    saveToFile(path.join(userDataPath, 'folders-expanded.json'), expandedFolders);
  }
  return true;
});

// ==================== SFTP Path Bookmarks ====================
// Stored per saved session: { [savedSessionId]: { local: string[], remote: string[] } }
// Kept in the main process so the main window and popped-out SFTP windows share one source.

const pathBookmarksFilePath = path.join(userDataPath, 'path-bookmarks.json');
const BOOKMARK_KEY_PATTERN = /^[\w-]{1,128}$/;
const BOOKMARK_SIDES = ['local', 'remote'];
const MAX_BOOKMARKS_PER_SIDE = 50;
const MAX_BOOKMARK_PATH_LENGTH = 4096;

function isValidBookmarkKey(key) {
  // "__proto__" matches the pattern, so prototype keys are rejected explicitly
  return typeof key === 'string' && BOOKMARK_KEY_PATTERN.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
}

function readPathBookmarks() {
  const data = loadFromFile(pathBookmarksFilePath, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function toBookmarkEntry(entry) {
  const pick = (list) => (Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []);
  return { local: pick(entry && entry.local), remote: pick(entry && entry.remote) };
}

ipcMain.handle('ssh-get-session-info', (event, { sessionId }) => {
  const connState = connectionStates.get(sessionId);
  if (!connState || !connState.config) return null;
  const { host, port, username, savedSessionId } = connState.config;
  return { host, port, username, savedSessionId: savedSessionId || null };
});

ipcMain.handle('path-bookmarks-get', (event, { key }) => {
  if (!isValidBookmarkKey(key)) return toBookmarkEntry(null);
  const all = readPathBookmarks();
  return toBookmarkEntry(Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null);
});

ipcMain.handle('path-bookmarks-set', (event, { key, side, paths }) => {
  if (!isValidBookmarkKey(key) || !BOOKMARK_SIDES.includes(side) || !Array.isArray(paths)) {
    return { success: false, error: '잘못된 즐겨찾기 요청입니다.' };
  }
  const cleaned = [...new Set(
    paths.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_BOOKMARK_PATH_LENGTH)
  )].slice(0, MAX_BOOKMARKS_PER_SIDE);

  const all = readPathBookmarks();
  const current = toBookmarkEntry(Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null);
  const next = { ...all, [key]: { ...current, [side]: cleaned } };
  if (!saveToFile(pathBookmarksFilePath, next)) {
    return { success: false, error: '즐겨찾기를 저장하지 못했습니다.' };
  }

  // Keep every window (main + popped-out SFTP windows) in sync
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('path-bookmarks-changed', { key, entry: next[key] });
  });
  return { success: true, entry: next[key] };
});

// ==================== Terminal Command History ====================
// Per connection: { [savedSessionId | "quick:user@host:port"]: [{ command, lastUsedAt }] }, newest first.
// Commands can contain secrets, so the whole map is encrypted with the master password like sessions.
// PBKDF2 makes every encrypt slow: routine saves are batched and encrypted off the main thread,
// while lock and quit flush synchronously so nothing is lost.

const commandHistoryFilePath = path.join(userDataPath, 'command-history.json');
const COMMAND_HISTORY_SAVE_DELAY_MS = 1500;
let commandHistoryCache = null; // decrypted map, only while unlocked
let commandHistorySaveTimer = null;
// Bumped by every write (and by discard) so a slow background save never overwrites newer data
let commandHistoryGeneration = 0;

function isCommandHistoryAvailable() {
  return !isAppLocked && Boolean(currentMasterPassword);
}

function loadCommandHistory() {
  if (commandHistoryCache) return commandHistoryCache;
  if (!fs.existsSync(commandHistoryFilePath)) {
    commandHistoryCache = {};
    return commandHistoryCache;
  }
  try {
    const file = JSON.parse(fs.readFileSync(commandHistoryFilePath, 'utf8'));
    const plain = cryptoUtil.decrypt(file.encrypted, currentMasterPassword);
    commandHistoryCache = commandHistory.sanitizeHistory(JSON.parse(plain));
  } catch (err) {
    // Keep the unreadable file aside instead of overwriting it with an empty history
    console.error('Failed to read command history, starting a new one:', err.message);
    try {
      fs.renameSync(commandHistoryFilePath, `${commandHistoryFilePath}.unreadable-${Date.now()}`);
    } catch (renameErr) {
      console.error('Failed to set aside unreadable command history:', renameErr.message);
    }
    commandHistoryCache = {};
  }
  return commandHistoryCache;
}

function writeCommandHistoryFile(encrypted) {
  fs.writeFileSync(commandHistoryFilePath, JSON.stringify({ version: 1, encrypted }), 'utf-8');
}

/** Synchronous save for lock and quit, where the process may not wait for a background one. */
function flushCommandHistory() {
  if (commandHistorySaveTimer) {
    clearTimeout(commandHistorySaveTimer);
    commandHistorySaveTimer = null;
  }
  if (!commandHistoryCache || !currentMasterPassword) return;
  commandHistoryGeneration++;
  try {
    writeCommandHistoryFile(cryptoUtil.encrypt(JSON.stringify(commandHistoryCache), currentMasterPassword));
  } catch (err) {
    console.error('Failed to save command history:', err.message);
  }
}

async function saveCommandHistoryInBackground() {
  commandHistorySaveTimer = null;
  if (!commandHistoryCache || !currentMasterPassword) return;
  const generation = ++commandHistoryGeneration;
  try {
    const encrypted = await cryptoUtil.encryptAsync(JSON.stringify(commandHistoryCache), currentMasterPassword);
    // A newer save, a lock-time flush or a reset happened while encrypting
    if (generation !== commandHistoryGeneration) return;
    writeCommandHistoryFile(encrypted);
  } catch (err) {
    console.error('Failed to save command history:', err.message);
  }
}

function scheduleCommandHistorySave() {
  if (commandHistorySaveTimer) return;
  commandHistorySaveTimer = setTimeout(saveCommandHistoryInBackground, COMMAND_HISTORY_SAVE_DELAY_MS);
}

function discardCommandHistory() {
  if (commandHistorySaveTimer) clearTimeout(commandHistorySaveTimer);
  commandHistorySaveTimer = null;
  commandHistoryGeneration++;
  commandHistoryCache = null;
  if (fs.existsSync(commandHistoryFilePath)) fs.unlinkSync(commandHistoryFilePath);
}

function historyEntriesFor(all, key) {
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : [];
}

function updateCommandHistory(key, update) {
  const all = loadCommandHistory();
  const entries = update(historyEntriesFor(all, key));
  commandHistoryCache = { ...all, [key]: entries };
  scheduleCommandHistorySave();
  // Every window (main + popped-out terminals) shows the same list
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('command-history-changed', { key, entries });
  });
  return { success: true, entries };
}

const COMMAND_HISTORY_LOCKED = { success: false, error: '앱이 잠겨 있어 명령어 기록을 사용할 수 없습니다.' };
const COMMAND_HISTORY_BAD_REQUEST = { success: false, error: '잘못된 명령어 기록 요청입니다.' };

ipcMain.handle('command-history-get', (event, { key }) => {
  if (!isCommandHistoryAvailable()) return { ...COMMAND_HISTORY_LOCKED, entries: [] };
  if (!commandHistory.isValidHistoryKey(key)) return { ...COMMAND_HISTORY_BAD_REQUEST, entries: [] };
  return { success: true, entries: historyEntriesFor(loadCommandHistory(), key) };
});

ipcMain.handle('command-history-add', (event, { key, command }) => {
  if (!isCommandHistoryAvailable()) return COMMAND_HISTORY_LOCKED;
  const normalized = commandHistory.normalizeCommand(command);
  if (!commandHistory.isValidHistoryKey(key) || normalized === null) return COMMAND_HISTORY_BAD_REQUEST;
  return updateCommandHistory(key, (entries) => commandHistory.addCommand(entries, normalized, Date.now()));
});

ipcMain.handle('command-history-remove', (event, { key, command }) => {
  if (!isCommandHistoryAvailable()) return COMMAND_HISTORY_LOCKED;
  if (!commandHistory.isValidHistoryKey(key) || typeof command !== 'string') return COMMAND_HISTORY_BAD_REQUEST;
  return updateCommandHistory(key, (entries) => commandHistory.removeCommand(entries, command));
});

ipcMain.handle('command-history-clear', (event, { key }) => {
  if (!isCommandHistoryAvailable()) return COMMAND_HISTORY_LOCKED;
  if (!commandHistory.isValidHistoryKey(key)) return COMMAND_HISTORY_BAD_REQUEST;
  return updateCommandHistory(key, () => []);
});

// ==================== App Settings ====================

ipcMain.handle('load-settings', () => {
  return loadFromFile(settingsFilePath, {});
});

ipcMain.handle('save-settings', (event, settings) => {
  return saveToFile(settingsFilePath, settings);
});

// ==================== Session Import/Export ====================

ipcMain.handle('export-sessions', async (event, exportData) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '세션 내보내기',
      defaultPath: `ssh-sessions-${new Date().toISOString().split('T')[0]}.json`,
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    // Write export data to file
    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8');

    return { success: true, filePath: result.filePath };
  } catch (error) {
    console.error('Export sessions error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('import-sessions', async (event, mode) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '세션 가져오기',
      properties: ['openFile'],
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    // Read and parse the import file
    const importData = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));

    if (!importData.sessions || !Array.isArray(importData.sessions)) {
      return { success: false, error: 'Invalid session file format' };
    }

    const importedSessions = importData.sessions;
    const importedFolders = importData.folders || [];

    // Load existing sessions
    const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
    let existingSessions = [];

    if (fs.existsSync(sessionsPath)) {
      existingSessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    }

    let finalSessions;
    if (mode === 'replace') {
      // Replace mode: use only imported sessions
      finalSessions = importedSessions;
    } else {
      // Merge mode: combine existing and imported, avoiding duplicates by ID
      const existingIds = new Set(existingSessions.map(s => s.id));
      const newSessions = importedSessions.filter(s => !existingIds.has(s.id));
      finalSessions = [...existingSessions, ...newSessions];
    }

    // Save merged/replaced sessions
    fs.writeFileSync(sessionsPath, JSON.stringify(finalSessions, null, 2));

    // Handle folders
    if (importedFolders.length > 0) {
      const existingFolders = loadFromFile(foldersFilePath, []);
      let finalFolders;

      if (mode === 'replace') {
        finalFolders = importedFolders;
      } else {
        const existingFolderIds = new Set(existingFolders.map(f => f.id));
        const newFolders = importedFolders.filter(f => !existingFolderIds.has(f.id));
        finalFolders = [...existingFolders, ...newFolders];
      }

      saveToFile(foldersFilePath, finalFolders);
    }

    return {
      success: true,
      count: mode === 'merge' ? importedSessions.length : finalSessions.length
    };
  } catch (error) {
    console.error('Import sessions error:', error);
    return { success: false, error: error.message };
  }
});

// 창 컨트롤 - 요청한 창에서 실행
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.handle('window-toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setFullScreen(!win.isFullScreen());
});

// Private Key 파일 선택 다이얼로그
ipcMain.handle('select-private-key', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Private Key 파일 선택',
    properties: ['openFile'],
    filters: [
      { name: 'Private Key Files', extensions: ['pem', 'ppk', 'key', ''] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false };
  }

  return { success: true, path: result.filePaths[0] };
});

// Auto-reconnect logic
async function attemptReconnect(sessionId) {
  const connState = connectionStates.get(sessionId);
  if (!connState || !connState.autoReconnect) {
    return;
  }

  if (connState.retryCount >= 5) {
    updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
    const targetWindow = getWindowForSession(sessionId);
    if (targetWindow) {
      targetWindow.webContents.send('ssh-reconnect-failed', {
        sessionId,
        message: 'Maximum reconnection attempts reached (5)'
      });
      // Send ssh-closed since reconnection permanently failed
      targetWindow.webContents.send('ssh-closed', { sessionId });
    }
    return;
  }

  connState.retryCount++;
  updateConnectionState(sessionId, ConnectionState.RECONNECTING);

  const delay = Math.min(1000 * Math.pow(2, connState.retryCount), 30000); // Max 30s

  const targetWindow = getWindowForSession(sessionId);
  if (targetWindow) {
    targetWindow.webContents.send('ssh-reconnecting', {
      sessionId,
      attempt: connState.retryCount,
      delay,
      maxAttempts: 5
    });
  }

  await new Promise(resolve => setTimeout(resolve, delay));

  // Check if still should reconnect (user might have cancelled)
  const currentState = connectionStates.get(sessionId);
  if (!currentState || currentState.state !== ConnectionState.RECONNECTING) {
    return;
  }

  try {
    await reconnectSession(sessionId);
  } catch (err) {
    console.error('Reconnect attempt failed:', err.message);
    attemptReconnect(sessionId); // Retry
  }
}

async function reconnectSession(sessionId) {
  const connState = connectionStates.get(sessionId);
  if (!connState || !connState.config) {
    throw new Error('No config available for reconnection');
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const config = connState.config;

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        // Clean up old connection if exists
        const oldConn = sshConnections.get(sessionId);
        if (oldConn) {
          try { oldConn.conn.end(); } catch (e) {}
        }

        sshConnections.set(sessionId, { conn, stream });
        setupRemoteForwardHandler(sessionId, conn);
        connState.retryCount = 0;
        updateConnectionState(sessionId, ConnectionState.CONNECTED);

        stream.on('data', (data) => {
          const targetWindow = getWindowForSession(sessionId);
          if (targetWindow) {
            targetWindow.webContents.send('ssh-data', { sessionId, data: data.toString() });
          }
        });

        stream.on('close', () => {
          updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
          attemptReconnect(sessionId);
        });

        const reconnectWindow = getWindowForSession(sessionId);
        if (reconnectWindow) {
          reconnectWindow.webContents.send('ssh-reconnected', { sessionId });
        }

        resolve();
      });
    });

    conn.on('error', (err) => {
      reject(err);
    });

    // Build connect config
    const connectOpts = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      keepaliveInterval: config.keepaliveInterval || 30000,
      keepaliveCountMax: 3,
      readyTimeout: config.connectTimeout || 20000
    };

    if (config.authType === 'privateKey') {
      try {
        connectOpts.privateKey = fs.readFileSync(config.privateKeyPath);
        if (config.passphrase) {
          connectOpts.passphrase = config.passphrase;
        }
      } catch (err) {
        return reject(new Error('Private Key 파일을 읽을 수 없습니다: ' + err.message));
      }
    } else if (config.password) {
      connectOpts.password = config.password;
    }

    conn.connect(connectOpts);
  });
}

// SSH 연결
ipcMain.handle('ssh-connect', async (event, config) => {
  return new Promise((resolve, reject) => {
    const sessionId = Date.now().toString();

    const connectFinalHost = (sock) => {
      const conn = new Client();

      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          sshConnections.set(sessionId, { conn, stream, jumpConn: sock ? sock._client : null });
          setupRemoteForwardHandler(sessionId, conn);

          // Store connection state for reconnection
          connectionStates.set(sessionId, {
            state: ConnectionState.CONNECTED,
            config: { ...config },
            retryCount: 0,
            autoReconnect: config.autoReconnect !== false
          });

          stream.on('data', (data) => {
            const targetWindow = getWindowForSession(sessionId);
            if (targetWindow) {
              targetWindow.webContents.send('ssh-data', {
                sessionId,
                data: data.toString('utf-8')
              });
            }
          });

          stream.on('close', () => {
            const connState = connectionStates.get(sessionId);

            // If auto-reconnect is enabled, don't send ssh-closed yet - let reconnection handle it
            if (connState && connState.autoReconnect) {
              updateConnectionState(sessionId, ConnectionState.RECONNECTING);
              attemptReconnect(sessionId);
            } else {
              // No auto-reconnect, send ssh-closed immediately
              const targetWindow = getWindowForSession(sessionId);
              if (targetWindow) {
                targetWindow.webContents.send('ssh-closed', { sessionId });
              }
              updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
            }
          });

          resolve({ success: true, sessionId });
        });
      });

      conn.on('error', (err) => {
        // Only reject if Promise hasn't resolved yet
        reject(err);
      });

      // Handle connection-level close (covers cases where connection drops without stream close)
      conn.on('close', () => {
        const connState = connectionStates.get(sessionId);
        // Only handle if this connection is still the active one
        const currentSession = sshConnections.get(sessionId);
        if (currentSession && currentSession.conn === conn) {
          if (connState && connState.autoReconnect && connState.state !== ConnectionState.RECONNECTING) {
            updateConnectionState(sessionId, ConnectionState.RECONNECTING);
            attemptReconnect(sessionId);
          }
        }
      });

      // 연결 설정 구성
      const connectConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        keepaliveInterval: config.keepaliveInterval || 30000,
        keepaliveCountMax: 3,
        readyTimeout: config.connectTimeout || 20000
      };

      // sock이 있으면 Jump Host 터널 사용
      if (sock) {
        connectConfig.sock = sock;
      }

      // 인증 방식에 따른 설정
      if (config.authType === 'privateKey' && config.privateKeyPath) {
        try {
          connectConfig.privateKey = fs.readFileSync(config.privateKeyPath);
          if (config.passphrase) {
            connectConfig.passphrase = config.passphrase;
          }
        } catch (err) {
          reject(new Error('Private Key 파일을 읽을 수 없습니다: ' + err.message));
          return;
        }
      } else {
        connectConfig.password = config.password;
      }

      conn.connect(connectConfig);
    };

    // Jump Host 사용 여부 확인
    if (config.useJumpHost && config.jumpHost) {
      const jumpConn = new Client();

      jumpConn.on('ready', () => {
        // Jump Host를 통해 최종 호스트로 TCP 터널 생성
        jumpConn.forwardOut('127.0.0.1', 0, config.host, config.port || 22, (err, stream) => {
          if (err) {
            jumpConn.end();
            reject(new Error('Jump Host 터널 생성 실패: ' + err.message));
            return;
          }
          // 터널 스트림에 _client 참조 저장 (나중에 정리용)
          stream._client = jumpConn;
          connectFinalHost(stream);
        });
      });

      jumpConn.on('error', (err) => {
        reject(new Error('Jump Host 연결 실패: ' + err.message));
      });

      // Jump Host 연결 설정
      const jumpConfig = {
        host: config.jumpHost,
        port: config.jumpPort || 22,
        username: config.jumpUsername || config.username,
        keepaliveInterval: 30000,
        keepaliveCountMax: 3,
        readyTimeout: config.connectTimeout || 20000
      };

      if (config.jumpAuthType === 'privateKey' && config.jumpPrivateKeyPath) {
        try {
          jumpConfig.privateKey = fs.readFileSync(config.jumpPrivateKeyPath);
          if (config.jumpPassphrase) {
            jumpConfig.passphrase = config.jumpPassphrase;
          }
        } catch (err) {
          reject(new Error('Jump Host Private Key 파일을 읽을 수 없습니다: ' + err.message));
          return;
        }
      } else {
        jumpConfig.password = config.jumpPassword;
      }

      jumpConn.connect(jumpConfig);
    } else {
      // Jump Host 없이 직접 연결
      connectFinalHost(null);
    }
  });
});

// SSH 데이터 전송
ipcMain.on('ssh-send', (event, { sessionId, data }) => {
  const session = sshConnections.get(sessionId);
  if (session && session.stream) {
    session.stream.write(data);
  }
});

// SSH 터미널 리사이즈
ipcMain.on('ssh-resize', (event, { sessionId, cols, rows }) => {
  const session = sshConnections.get(sessionId);
  if (session && session.stream) {
    session.stream.setWindow(rows, cols, 0, 0);
  }
});

// SSH 명령어 실행 (단일 명령어, 결과 반환)
ipcMain.handle('ssh-exec-command', async (event, { sessionId, command }) => {
  const session = sshConnections.get(sessionId);
  if (!session || !session.conn) {
    return { success: false, error: 'Session not connected' };
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Command timeout' });
    }, 10000);

    session.conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (data) => {
        stdout += data.toString('utf-8');
      });

      stream.stderr.on('data', (data) => {
        stderr += data.toString('utf-8');
      });

      stream.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ success: true, stdout, stderr, exitCode: code });
      });
    });
  });
});

// SSH 연결 종료
ipcMain.on('ssh-disconnect', (event, { sessionId }) => {
  const session = sshConnections.get(sessionId);
  if (session) {
    session.conn.end();
    // Jump Host 연결도 종료
    if (session.jumpConn) {
      try { session.jumpConn.end(); } catch (e) {}
    }
    sshConnections.delete(sessionId);
  }

  // Clean up any split terminal streams
  for (const [key, stream] of sshStreams.entries()) {
    if (key.startsWith(sessionId + ':')) {
      try { stream.end(); } catch (e) {}
      sshStreams.delete(key);
    }
  }

  // Clean up port forwards
  cleanupPortForwards(sessionId);

  // Cancel auto-reconnect
  const connState = connectionStates.get(sessionId);
  if (connState) {
    connState.autoReconnect = false;
    connState.state = ConnectionState.DISCONNECTED;
    connectionStates.delete(sessionId);
  }
});

// Create new shell for split terminal (uses same SSH connection)
ipcMain.handle('ssh-create-shell', async (event, { sessionId }) => {
  const session = sshConnections.get(sessionId);
  if (!session || !session.conn) {
    return { success: false, error: 'SSH 연결이 없습니다.' };
  }

  // Do not close existing split streams here: every stream in sshStreams is live
  // (renderer closes them on unmount, and 'close' removes them), and quad/tri
  // layouts create several split shells for the same session in parallel.

  // Wait if a split stream was closed recently - the server needs time to
  // fully process the channel closure before accepting a new channel
  const lastClosed = splitStreamLastClosed.get(sessionId);
  const timeSinceClose = lastClosed ? Date.now() - lastClosed : Infinity;
  if (timeSinceClose < 1000) {
    const waitTime = Math.max(500, 1000 - timeSinceClose);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  const createShell = () => {
    return new Promise((resolve) => {
      session.conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          const count = openChannelCount(session.conn);
          console.warn(`[split] open failed session=${sessionId} openChannels=${count}: ${err.message}`);
          return resolve({ success: false, error: `${err.message} (열린 채널 ${count}개)` });
        }

        // Several split shells can open in the same millisecond (quad layout),
        // and a shared id makes all panes write to and render the same stream
        const streamId = `${sessionId}:split-${Date.now()}-${++splitStreamSeq}`;
        sshStreams.set(streamId, stream);
        console.log(`[split] opened ${streamId} openChannels=${openChannelCount(session.conn)}`);

        stream.on('data', (data) => {
          const targetWindow = getWindowForSession(sessionId);
          if (targetWindow) {
            targetWindow.webContents.send('ssh-split-data', {
              streamId,
              sessionId,
              data: data.toString('utf-8')
            });
          }
        });

        stream.on('close', () => {
          sshStreams.delete(streamId);
          console.log(`[split] closed ${streamId} openChannels=${openChannelCount(session.conn)}`);
          const targetWindow = getWindowForSession(sessionId);
          if (targetWindow) {
            targetWindow.webContents.send('ssh-split-closed', { streamId, sessionId });
          }
        });

        resolve({ success: true, streamId });
      });
    });
  };

  let result = await createShell();

  // If channel open still failed, retry once (fallback safety)
  if (!result.success && result.error && result.error.includes('Channel open failure')) {
    await new Promise(resolve => setTimeout(resolve, 500));
    result = await createShell();
  }

  return result;
});

// Send data to split terminal stream
ipcMain.on('ssh-split-send', (event, { streamId, data }) => {
  const stream = sshStreams.get(streamId);
  if (stream) {
    stream.write(data);
  }
});

// Resize split terminal
ipcMain.on('ssh-split-resize', (event, { streamId, cols, rows }) => {
  const stream = sshStreams.get(streamId);
  if (stream) {
    stream.setWindow(rows, cols, 0, 0);
  }
});

// Close split terminal stream
ipcMain.on('ssh-split-close', (event, { streamId }) => {
  const stream = sshStreams.get(streamId);
  if (stream) {
    // Extract sessionId from streamId (format: "sessionId:split-timestamp-seq")
    const sessionId = streamId.split(':')[0];
    splitStreamLastClosed.set(sessionId, Date.now());
    // end() only sends EOF (ssh2 client channels are half-open by default) and a PTY shell
    // ignores EOF, so the server kept every closed split alive until MaxSessions refused
    // new channels. close() sends CHANNEL_CLOSE and the server ends the session.
    try { stream.close(); } catch (e) {}
    sshStreams.delete(streamId);
    const session = sshConnections.get(sessionId);
    console.log(`[split] close requested ${streamId} openChannels(before server ack)=${openChannelCount(session && session.conn)}`);
  } else {
    console.warn(`[split] close requested for unknown stream ${streamId}`);
  }
});

// Cancel reconnection
ipcMain.handle('ssh-cancel-reconnect', (event, { sessionId }) => {
  const connState = connectionStates.get(sessionId);
  if (connState) {
    connState.autoReconnect = false;
    connState.state = ConnectionState.DISCONNECTED;
  }
  return { success: true };
});

// ==================== 자동 업데이트 API ====================

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { success: true, version: result?.updateInfo?.version };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// ==================== 포트 포워딩 기능 ====================

// Local port forwarding (-L): localHost:localPort -> remoteHost:remotePort via SSH
ipcMain.handle('port-forward-local', async (event, { sessionId, localPort, remoteHost, remotePort, localHost }) => {
  const session = sshConnections.get(sessionId);
  if (!session || !session.conn) {
    return { success: false, error: 'SSH 연결이 없습니다.' };
  }

  const bindHost = localHost || '127.0.0.1';
  const forwardId = `local-${sessionId}-${localPort}`;

  // Check if already exists
  if (portForwards.has(forwardId)) {
    return { success: false, error: `포트 ${localPort}이(가) 이미 포워딩 중입니다.` };
  }

  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      session.conn.forwardOut(bindHost, localPort, remoteHost, remotePort, (err, stream) => {
        if (err) {
          socket.end();
          return;
        }
        const fwd = portForwards.get(forwardId);
        if (fwd) fwd.connectionCount = (fwd.connectionCount || 0) + 1;
        notifyPortForwardUpdate(sessionId);
        socket.pipe(stream).pipe(socket);
        stream.on('close', () => {
          if (fwd) fwd.connectionCount = Math.max(0, (fwd.connectionCount || 0) - 1);
          notifyPortForwardUpdate(sessionId);
        });
      });
    });

    server.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    server.listen(localPort, bindHost, () => {
      portForwards.set(forwardId, {
        type: 'local', server, sessionId,
        localHost: bindHost, localPort,
        remoteHost, remotePort,
        connectionCount: 0
      });
      notifyPortForwardUpdate(sessionId);
      resolve({ success: true, forwardId });
    });
  });
});

// Remote port forwarding (-R): remoteHost:remotePort -> localHost:localPort
ipcMain.handle('port-forward-remote', async (event, { sessionId, remotePort, localHost, localPort, remoteHost }) => {
  const session = sshConnections.get(sessionId);
  if (!session || !session.conn) {
    return { success: false, error: 'SSH 연결이 없습니다.' };
  }

  const bindHost = remoteHost || '0.0.0.0';
  const forwardId = `remote-${sessionId}-${remotePort}`;

  if (portForwards.has(forwardId)) {
    return { success: false, error: `원격 포트 ${remotePort}이(가) 이미 포워딩 중입니다.` };
  }

  return new Promise((resolve) => {
    session.conn.forwardIn(bindHost, remotePort, (err) => {
      if (err) return resolve({ success: false, error: err.message });

      portForwards.set(forwardId, {
        type: 'remote', sessionId,
        localHost: localHost || '127.0.0.1', localPort,
        remoteHost: bindHost, remotePort,
        connectionCount: 0
      });
      notifyPortForwardUpdate(sessionId);
      resolve({ success: true, forwardId });
    });
  });
});

// Handle incoming remote forward connections
// This needs to be set up per-connection. We'll add a listener when connection is established.
function setupRemoteForwardHandler(sessionId, conn) {
  conn.on('tcp connection', (info, accept, reject) => {
    // Find matching remote forward
    let matched = null;
    for (const [id, fwd] of portForwards.entries()) {
      if (fwd.sessionId === sessionId && fwd.type === 'remote' && fwd.remotePort === info.destPort) {
        matched = { id, fwd };
        break;
      }
    }

    if (!matched) {
      reject();
      return;
    }

    const stream = accept();
    const socket = net.connect(matched.fwd.localPort, matched.fwd.localHost || '127.0.0.1', () => {
      matched.fwd.connectionCount = (matched.fwd.connectionCount || 0) + 1;
      notifyPortForwardUpdate(sessionId);
      stream.pipe(socket).pipe(stream);
    });

    socket.on('error', () => { try { stream.end(); } catch(e) {} });
    stream.on('error', () => { try { socket.end(); } catch(e) {} });
    socket.on('close', () => {
      matched.fwd.connectionCount = Math.max(0, (matched.fwd.connectionCount || 0) - 1);
      notifyPortForwardUpdate(sessionId);
    });
  });
}

// Dynamic port forwarding (-D SOCKS5 proxy)
ipcMain.handle('port-forward-dynamic', async (event, { sessionId, localPort, localHost }) => {
  const session = sshConnections.get(sessionId);
  if (!session || !session.conn) {
    return { success: false, error: 'SSH 연결이 없습니다.' };
  }

  const bindHost = localHost || '127.0.0.1';
  const forwardId = `dynamic-${sessionId}-${localPort}`;

  if (portForwards.has(forwardId)) {
    return { success: false, error: `포트 ${localPort}이(가) 이미 사용 중입니다.` };
  }

  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      // SOCKS5 handshake
      socket.once('data', (data) => {
        if (data[0] !== 0x05) { socket.end(); return; }

        // No auth required
        socket.write(Buffer.from([0x05, 0x00]));

        socket.once('data', (reqData) => {
          if (reqData[1] !== 0x01) { // Only CONNECT supported
            socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0]));
            socket.end();
            return;
          }

          let dstHost, dstPort;
          const addrType = reqData[3];

          try {
            if (addrType === 0x01) { // IPv4
              dstHost = `${reqData[4]}.${reqData[5]}.${reqData[6]}.${reqData[7]}`;
              dstPort = reqData.readUInt16BE(8);
            } else if (addrType === 0x03) { // Domain name
              const domainLen = reqData[4];
              dstHost = reqData.slice(5, 5 + domainLen).toString();
              dstPort = reqData.readUInt16BE(5 + domainLen);
            } else if (addrType === 0x04) { // IPv6
              dstHost = '::1'; // Simplified
              dstPort = reqData.readUInt16BE(20);
            } else {
              socket.end();
              return;
            }
          } catch (e) {
            socket.end();
            return;
          }

          session.conn.forwardOut(bindHost, 0, dstHost, dstPort, (err, stream) => {
            if (err) {
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0,0,0,0, 0,0]));
              socket.end();
              return;
            }

            // Success reply
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
            const fwd = portForwards.get(forwardId);
            if (fwd) fwd.connectionCount = (fwd.connectionCount || 0) + 1;
            notifyPortForwardUpdate(sessionId);

            socket.pipe(stream).pipe(socket);
            stream.on('close', () => {
              if (fwd) fwd.connectionCount = Math.max(0, (fwd.connectionCount || 0) - 1);
              notifyPortForwardUpdate(sessionId);
            });
            stream.on('error', () => { try { socket.end(); } catch(e) {} });
          });
        });
      });

      socket.on('error', () => {});
    });

    server.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    server.listen(localPort, bindHost, () => {
      portForwards.set(forwardId, {
        type: 'dynamic', server, sessionId,
        localHost: bindHost, localPort,
        remoteHost: '*', remotePort: 0,
        connectionCount: 0
      });
      notifyPortForwardUpdate(sessionId);
      resolve({ success: true, forwardId });
    });
  });
});

// Stop a port forward
ipcMain.handle('port-forward-stop', async (event, { forwardId }) => {
  const forward = portForwards.get(forwardId);
  if (!forward) {
    return { success: false, error: '포트 포워딩을 찾을 수 없습니다.' };
  }

  try {
    if (forward.type === 'local' || forward.type === 'dynamic') {
      if (forward.server) forward.server.close();
    } else if (forward.type === 'remote') {
      const session = sshConnections.get(forward.sessionId);
      if (session && session.conn) {
        session.conn.unforwardIn(forward.remoteHost || '0.0.0.0', forward.remotePort);
      }
    }
  } catch (e) {}

  const sessionId = forward.sessionId;
  portForwards.delete(forwardId);
  notifyPortForwardUpdate(sessionId);
  return { success: true };
});

// List port forwards for a session
ipcMain.handle('port-forward-list', async (event, { sessionId }) => {
  const forwards = [];
  for (const [id, fwd] of portForwards.entries()) {
    if (fwd.sessionId === sessionId) {
      forwards.push({
        id,
        type: fwd.type,
        localHost: fwd.localHost,
        localPort: fwd.localPort,
        remoteHost: fwd.remoteHost,
        remotePort: fwd.remotePort,
        connectionCount: fwd.connectionCount || 0
      });
    }
  }
  return forwards;
});

// Notify renderer of port forward changes
function notifyPortForwardUpdate(sessionId) {
  const forwards = [];
  for (const [id, fwd] of portForwards.entries()) {
    if (fwd.sessionId === sessionId) {
      forwards.push({
        id,
        type: fwd.type,
        localHost: fwd.localHost,
        localPort: fwd.localPort,
        remoteHost: fwd.remoteHost,
        remotePort: fwd.remotePort,
        connectionCount: fwd.connectionCount || 0
      });
    }
  }
  const targetWindow = getWindowForSession(sessionId);
  if (targetWindow) {
    targetWindow.webContents.send('port-forward-update', { sessionId, forwards });
  }
}

// Clean up port forwards for a session (called on disconnect)
function cleanupPortForwards(sessionId) {
  for (const [id, fwd] of portForwards.entries()) {
    if (fwd.sessionId === sessionId) {
      try {
        if (fwd.type === 'local' || fwd.type === 'dynamic') {
          if (fwd.server) fwd.server.close();
        }
      } catch (e) {}
      portForwards.delete(id);
    }
  }
}

// ==================== SFTP 기능 ====================

// SFTP 세션 저장소
const sftpSessions = new Map();

// SFTP 세션 열기
ipcMain.handle('sftp-open', async (event, { sessionId }) => {
  // 이미 SFTP 세션이 열려있으면 그대로 사용
  if (sftpSessions.has(sessionId)) {
    return { success: true };
  }

  const session = sshConnections.get(sessionId);
  if (!session || !session.conn) {
    throw new Error('SSH 연결이 없습니다.');
  }

  return new Promise((resolve, reject) => {
    session.conn.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      sftpSessions.set(sessionId, sftp);
      resolve({ success: true });
    });
  });
});

// SFTP 세션 닫기
ipcMain.handle('sftp-close', async (event, { sessionId }) => {
  const sftp = sftpSessions.get(sessionId);
  if (sftp) {
    sftp.end();
    sftpSessions.delete(sessionId);
  }
  return { success: true };
});

// 디렉토리 목록 조회
// OpenSSH's sftp-server sends an `ls -l` style line per entry:
// "drwxr-xr-x    2 root     root         4096 Jan  1 00:00 name" -> owner/group names.
// Other servers may omit it, so callers fall back to the numeric uid/gid.
const LONGNAME_MODE_PATTERN = /^[-dlcbpsD][-rwxsStT]{9}/;
function parseLongnameOwner(longname) {
  if (typeof longname !== 'string') return null;
  const parts = longname.trim().split(/\s+/);
  if (parts.length < 4 || !LONGNAME_MODE_PATTERN.test(parts[0])) return null;
  return { owner: parts[2], group: parts[3] };
}

ipcMain.handle('sftp-list', async (event, { sessionId, remotePath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) {
    throw new Error('SFTP 세션이 없습니다.');
  }

  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        // Permission denied 에러를 더 명확하게 전달
        if (err.code === 2 || err.message.includes('Permission denied')) {
          reject(new Error('Permission denied: 이 폴더에 접근할 권한이 없습니다.'));
        } else {
          reject(new Error(err.message || '폴더를 읽을 수 없습니다.'));
        }
        return;
      }

      const files = list.map(item => {
        const names = parseLongnameOwner(item.longname);
        return {
        name: item.filename,
        size: item.attrs.size,
        isDirectory: item.attrs.isDirectory(),
        isFile: item.attrs.isFile(),
        mode: item.attrs.mode,
        mtime: item.attrs.mtime * 1000,
        permissions: (item.attrs.mode & 0o777).toString(8).padStart(3, '0'),
        owner: names ? names.owner : String(item.attrs.uid),
        group: names ? names.group : String(item.attrs.gid)
        };
      }).sort((a, b) => {
        // 디렉토리 먼저, 그 다음 이름순
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      resolve(files);
    });
  });
});

// 파일 다운로드
ipcMain.handle('sftp-download', async (event, { sessionId, remotePath, localPath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) {
    throw new Error('SFTP 세션이 없습니다.');
  }

  return new Promise((resolve, reject) => {
    // 파일 크기 확인
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        reject(err);
        return;
      }

      const totalSize = stats.size;
      let downloadedSize = 0;

      const readStream = sftp.createReadStream(remotePath);
      const writeStream = fs.createWriteStream(localPath);

      readStream.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const progress = Math.round((downloadedSize / totalSize) * 100);
        mainWindow.webContents.send('sftp-progress', {
          sessionId,
          type: 'download',
          fileName: path.basename(remotePath),
          progress,
          loaded: downloadedSize,
          total: totalSize
        });
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);

      writeStream.on('finish', () => {
        resolve({ success: true, localPath });
      });

      readStream.pipe(writeStream);
    });
  });
});

// 파일 업로드
ipcMain.handle('sftp-upload', async (event, { sessionId, localPath, remotePath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) {
    throw new Error('SFTP 세션이 없습니다.');
  }

  return new Promise((resolve, reject) => {
    const stats = fs.statSync(localPath);
    const totalSize = stats.size;
    let uploadedSize = 0;

    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);

    readStream.on('data', (chunk) => {
      uploadedSize += chunk.length;
      const progress = Math.round((uploadedSize / totalSize) * 100);
      mainWindow.webContents.send('sftp-progress', {
        sessionId,
        type: 'upload',
        fileName: path.basename(localPath),
        progress,
        loaded: uploadedSize,
        total: totalSize
      });
    });

    readStream.on('error', reject);
    writeStream.on('error', reject);

    writeStream.on('close', () => {
      resolve({ success: true, remotePath });
    });

    readStream.pipe(writeStream);
  });
});

// 파일/폴더 삭제
ipcMain.handle('sftp-delete', async (event, { sessionId, remotePath, isDirectory }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) {
    throw new Error('SFTP 세션이 없습니다.');
  }

  return new Promise((resolve, reject) => {
    if (isDirectory) {
      sftp.rmdir(remotePath, (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      });
    } else {
      sftp.unlink(remotePath, (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      });
    }
  });
});

// 이름 변경
ipcMain.handle('sftp-rename', async (event, { sessionId, oldPath, newPath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) {
    throw new Error('SFTP 세션이 없습니다.');
  }

  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
  });
});

// 폴더 생성
ipcMain.handle('sftp-mkdir', async (event, { sessionId, remotePath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) {
    throw new Error('SFTP 세션이 없습니다.');
  }

  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
  });
});

// 다운로드 경로 선택 다이얼로그
ipcMain.handle('select-download-path', async (event, { defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '다운로드 위치 선택',
    defaultPath: defaultName,
    properties: ['createDirectory']
  });

  if (result.canceled) {
    return { success: false };
  }
  return { success: true, path: result.filePath };
});

// 업로드 파일 선택 다이얼로그
ipcMain.handle('select-upload-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '업로드할 파일 선택',
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false };
  }
  return { success: true, paths: result.filePaths };
});

// ==================== 로컬 파일 시스템 ====================

// 로컬 디렉토리 목록 조회
ipcMain.handle('local-list', async (event, { dirPath }) => {
  try {
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });

    const statResults = await Promise.allSettled(
      dirents.map(async (dirent) => {
        const fullPath = path.join(dirPath, dirent.name);
        try {
          const stats = await fs.promises.stat(fullPath);
          return {
            name: dirent.name,
            size: stats.size,
            isDirectory: dirent.isDirectory(),
            isFile: dirent.isFile(),
            mtime: stats.mtime.getTime(),
            path: fullPath
          };
        } catch (e) {
          return null;
        }
      })
    );

    const fileList = statResults
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value)
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

    return { success: true, files: fileList };
  } catch (err) {
    throw err;
  }
});

// 로컬 폴더 선택 다이얼로그
ipcMain.handle('select-local-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '로컬 폴더 선택',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false };
  }
  return { success: true, path: result.filePaths[0] };
});

// ==================== Transfer Queue ====================

class TransferQueue {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.queue = []; // { id, type, localPath, remotePath, status, progress, size, speed, startTime }
    this.activeTransfers = new Map();
    this.maxConcurrent = 2;
    this.abortControllers = new Map();
  }

  add(transfer) {
    transfer.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    transfer.status = 'queued';
    transfer.progress = 0;
    transfer.speed = 0;
    transfer.startTime = null;
    this.queue.push(transfer);
    this.emitQueueUpdate();
    this.processQueue();
    return transfer.id;
  }

  pause(id) {
    const transfer = this.queue.find(t => t.id === id);
    if (transfer && transfer.status === 'active') {
      transfer.status = 'paused';
      const controller = this.abortControllers.get(id);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(id);
      }
      this.activeTransfers.delete(id);
      this.emitQueueUpdate();
    }
  }

  resume(id) {
    const transfer = this.queue.find(t => t.id === id);
    if (transfer && transfer.status === 'paused') {
      transfer.status = 'queued';
      this.emitQueueUpdate();
      this.processQueue();
    }
  }

  cancel(id) {
    const transfer = this.queue.find(t => t.id === id);
    if (transfer) {
      const controller = this.abortControllers.get(id);
      if (controller) {
        controller.abort();
        this.abortControllers.delete(id);
      }
      this.activeTransfers.delete(id);
      this.queue = this.queue.filter(t => t.id !== id);
      this.emitQueueUpdate();
      this.processQueue();
    }
  }

  clearCompleted() {
    this.queue = this.queue.filter(t => t.status !== 'completed' && t.status !== 'error');
    this.emitQueueUpdate();
  }

  processQueue() {
    const activeCount = this.activeTransfers.size;
    const availableSlots = this.maxConcurrent - activeCount;

    if (availableSlots <= 0) return;

    const queuedTransfers = this.queue.filter(t => t.status === 'queued');
    const toStart = queuedTransfers.slice(0, availableSlots);

    for (const transfer of toStart) {
      this.startTransfer(transfer);
    }
  }

  async startTransfer(transfer) {
    transfer.status = 'active';
    transfer.startTime = Date.now();
    this.activeTransfers.set(transfer.id, transfer);
    this.emitQueueUpdate();

    const abortController = { aborted: false, abort: function() { this.aborted = true; } };
    this.abortControllers.set(transfer.id, abortController);

    try {
      if (transfer.type === 'download') {
        await this.executeDownload(transfer, abortController);
      } else {
        await this.executeUpload(transfer, abortController);
      }

      if (!abortController.aborted) {
        transfer.status = 'completed';
        transfer.progress = 100;
      }
    } catch (err) {
      if (!abortController.aborted) {
        transfer.status = 'error';
        transfer.error = err.message;
      }
    }

    this.activeTransfers.delete(transfer.id);
    this.abortControllers.delete(transfer.id);
    this.emitQueueUpdate();
    this.processQueue();
  }

  async executeDownload(transfer, abortController) {
    const session = sshConnections.get(this.sessionId);
    if (!session || !session.conn) throw new Error('No SSH connection');

    const sftp = sftpSessions.get(this.sessionId);
    if (!sftp) throw new Error('No SFTP connection');

    const CHUNK_SIZE = 64 * 1024; // 64KB

    return new Promise((resolve, reject) => {
      sftp.stat(transfer.remotePath, (err, stats) => {
        if (err) return reject(err);

        transfer.size = stats.size;
        // localPath is already the full target file path (callers pass dir + name, and the
        // "rename" overwrite option passes a new name). Joining the remote basename again
        // produced "<file>\<file>" and every download failed with ENOENT.
        const writeStream = fs.createWriteStream(transfer.localPath);
        const readStream = sftp.createReadStream(transfer.remotePath, { highWaterMark: CHUNK_SIZE });

        let downloaded = 0;
        let lastTime = Date.now();
        let lastBytes = 0;

        readStream.on('data', (chunk) => {
          if (abortController.aborted) {
            readStream.destroy();
            writeStream.destroy();
            return;
          }

          downloaded += chunk.length;
          transfer.progress = Math.round((downloaded / transfer.size) * 100);

          // Calculate speed
          const now = Date.now();
          const elapsed = (now - lastTime) / 1000;
          if (elapsed >= 0.5) { // Update speed every 500ms
            transfer.speed = Math.round((downloaded - lastBytes) / elapsed);
            lastTime = now;
            lastBytes = downloaded;
            this.emitProgress(transfer);
          }
        });

        readStream.on('end', () => {
          writeStream.end();
          resolve();
        });

        readStream.on('error', (err) => {
          writeStream.destroy();
          reject(err);
        });
        writeStream.on('error', (err) => {
          readStream.destroy();
          reject(err);
        });

        readStream.pipe(writeStream);
      });
    });
  }

  async executeUpload(transfer, abortController) {
    const session = sshConnections.get(this.sessionId);
    if (!session || !session.conn) throw new Error('No SSH connection');

    const sftp = sftpSessions.get(this.sessionId);
    if (!sftp) throw new Error('No SFTP connection');

    const CHUNK_SIZE = 64 * 1024;

    return new Promise((resolve, reject) => {
      fs.stat(transfer.localPath, (err, stats) => {
        if (err) {
          return reject(err);
        }

        transfer.size = stats.size;
        // Use remotePath directly - it's already the full target path
        const remotePath = transfer.remotePath;

        const readStream = fs.createReadStream(transfer.localPath, { highWaterMark: CHUNK_SIZE });
        const writeStream = sftp.createWriteStream(remotePath);

        let uploaded = 0;
        let lastTime = Date.now();
        let lastBytes = 0;

        readStream.on('data', (chunk) => {
          if (abortController.aborted) {
            readStream.destroy();
            writeStream.destroy();
            return;
          }

          uploaded += chunk.length;
          transfer.progress = Math.round((uploaded / transfer.size) * 100);

          const now = Date.now();
          const elapsed = (now - lastTime) / 1000;
          if (elapsed >= 0.5) {
            transfer.speed = Math.round((uploaded - lastBytes) / elapsed);
            lastTime = now;
            lastBytes = uploaded;
            this.emitProgress(transfer);
          }

          // Manually write chunk with backpressure handling
          if (!writeStream.write(chunk)) {
            readStream.pause();
            writeStream.once('drain', () => readStream.resume());
          }
        });

        readStream.on('end', () => {
          writeStream.end();
        });

        writeStream.on('close', () => {
          resolve();
        });

        readStream.on('error', (err) => {
          writeStream.destroy();
          reject(err);
        });
        writeStream.on('error', (err) => {
          readStream.destroy();
          reject(err);
        });
      });
    });
  }

  emitQueueUpdate() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sftp-queue-update', {
        sessionId: this.sessionId,
        queue: this.queue.map(t => ({
          id: t.id,
          type: t.type,
          fileName: path.basename(t.type === 'download' ? t.remotePath : t.localPath),
          status: t.status,
          progress: t.progress,
          size: t.size,
          speed: t.speed,
          error: t.error
        }))
      });
    }
  }

  emitProgress(transfer) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sftp-transfer-progress', {
        sessionId: this.sessionId,
        transferId: transfer.id,
        progress: transfer.progress,
        speed: transfer.speed,
        size: transfer.size
      });
    }
  }
}

const transferQueues = new Map(); // sessionId -> TransferQueue

function getTransferQueue(sessionId) {
  if (!transferQueues.has(sessionId)) {
    transferQueues.set(sessionId, new TransferQueue(sessionId));
  }
  return transferQueues.get(sessionId);
}

// Transfer Queue IPC Handlers
ipcMain.handle('sftp-queue-download', (event, { sessionId, remotePath, localPath }) => {
  const queue = getTransferQueue(sessionId);
  const id = queue.add({ type: 'download', remotePath, localPath });
  return { success: true, transferId: id };
});

ipcMain.handle('sftp-queue-upload', (event, { sessionId, localPath, remotePath }) => {
  const queue = getTransferQueue(sessionId);
  const id = queue.add({ type: 'upload', localPath, remotePath });
  return { success: true, transferId: id };
});

// Recursive folder upload
ipcMain.handle('sftp-upload-directory', async (event, { sessionId, localDir, remoteDir }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) {
    throw new Error('SFTP 세션이 없습니다.');
  }

  const uploadedFiles = [];

  const mkdirRecursive = (dirPath) => {
    return new Promise((resolve, reject) => {
      sftp.stat(dirPath, (err) => {
        if (!err) return resolve(); // Already exists
        sftp.mkdir(dirPath, (mkErr) => {
          if (mkErr && mkErr.code !== 4) reject(mkErr); // code 4 = already exists
          else resolve();
        });
      });
    });
  };

  const uploadRecursive = async (localPath, remotePath) => {
    const stats = fs.statSync(localPath);
    if (stats.isDirectory()) {
      await mkdirRecursive(remotePath);
      const entries = fs.readdirSync(localPath);
      for (const entry of entries) {
        const localEntryPath = path.join(localPath, entry);
        const remoteEntryPath = remotePath + '/' + entry;
        await uploadRecursive(localEntryPath, remoteEntryPath);
      }
    } else {
      // Queue individual file upload
      const queue = getTransferQueue(sessionId);
      queue.add({ type: 'upload', localPath, remotePath });
      uploadedFiles.push(remotePath);
    }
  };

  await uploadRecursive(localDir, remoteDir);
  return { success: true, uploadedFiles };
});

ipcMain.handle('sftp-transfer-pause', (event, { sessionId, transferId }) => {
  const queue = getTransferQueue(sessionId);
  queue.pause(transferId);
  return { success: true };
});

ipcMain.handle('sftp-transfer-resume', (event, { sessionId, transferId }) => {
  const queue = getTransferQueue(sessionId);
  queue.resume(transferId);
  return { success: true };
});

ipcMain.handle('sftp-transfer-cancel', (event, { sessionId, transferId }) => {
  const queue = getTransferQueue(sessionId);
  queue.cancel(transferId);
  return { success: true };
});

ipcMain.handle('sftp-queue-clear-completed', (event, { sessionId }) => {
  const queue = getTransferQueue(sessionId);
  queue.clearCompleted();
  return { success: true };
});

ipcMain.handle('sftp-get-queue', (event, { sessionId }) => {
  const queue = getTransferQueue(sessionId);
  return { queue: queue.queue };
});
