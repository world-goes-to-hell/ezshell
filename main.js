const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Notification, Menu, clipboard, nativeImage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const userDataDir = require('./src/userDataDir.js');
const navigationGuard = require('./src/navigationGuard.js');

// The app was renamed from my-ssh-client to ezshell. Keep the old user data folder (sessions,
// master password, settings, theme) when it exists. Must run before anything reads userData.
// An explicit --user-data-dir (separate test instances) always wins.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', userDataDir.resolveUserDataDir({
    appDataDir: app.getPath('appData'),
    defaultDir: app.getPath('userData'),
    legacyNames: userDataDir.legacyDataDirNames(),
    exists: (dir) => fs.existsSync(dir)
  }));
}

// Windows groups taskbar buttons by AppUserModelID. The installer's shortcuts (pinned, Start menu)
// carry build.appId; the windows had no ID of their own, and a live-view window showed up as a second
// ezShell button (Electron can fall back to its own "electron.app.<name>" ID). Keep in sync with
// build.appId in package.json. Not in dev, so a dev run does not join the installed app's button.
const WINDOWS_APP_USER_MODEL_ID = 'com.sungkwan.ssh-client';
if (process.platform === 'win32' && app.isPackaged) {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

const { Client } = require('ssh2');
const cryptoUtil = require('./src/crypto.js');
const sessionSecrets = require('./src/sessionSecrets.js');
const sharedConn = require('./src/sharedConn.js');
const { macMenuTemplate } = require('./src/macMenu.js');
const { registerContainerIpc } = require('./src/containers/ipc.js');
const { createContainerLogs } = require('./src/containers/logs.js');
const { createRemoteDocuments } = require('./src/remoteFiles/documents.js');
const localRead = require('./src/localFiles/localRead.js');
const localGit = require('./src/localFiles/git.js');
const { createLocalRoots } = require('./src/localFiles/roots.js');
const { createBackupStore } = require('./src/remoteFiles/backups.js');
const { registerRemoteFileIpc } = require('./src/remoteFiles/ipc.js');
const { registerDbIpc } = require('./src/dbClient/ipc.js');
const { createDbConnections } = require('./src/dbClient/connections.js');
const { createDiscoveryCache } = require('./src/dbClient/discovery.js');
const { createLocalShells } = require('./src/localShell.js');
const windowState = require('./src/windowState.js');
const nativeBackdrop = require('./src/nativeBackdrop.js');

// Glass surface style (src/nativeBackdrop.js). A window gets acrylic only through its creation options,
// so each window that should have it spreads glassWindowOptions() into them and is then registered:
// the registry answers "does this window have the material" and holds its maximize replacement.
const glassWindows = new WeakMap();
function glassWindowOptions() {
  return nativeBackdrop.backdropOptions(nativeBackdrop.readAppearance(app.getPath('userData')), process.platform, require('os').release());
}
function registerGlassWindow(win, options) {
  if (!options.backgroundMaterial) return null;
  const fill = nativeBackdrop.createFillToggle(win, () => require('electron').screen.getDisplayMatching(win.getBounds()).workArea);
  glassWindows.set(win, fill);
  // The window is not maximizable (a maximized window loses the material), so double-clicking the title
  // bar does nothing by itself. Measured: the top-level window gets no WM_NCLBUTTONDBLCLK for a drag
  // region (the clicks go to Chromium's child window); what it does get is WM_PARENTNOTIFY for each
  // button press, with the point. Two presses close in time and place are passed to the page, which
  // knows whether that point is a drag region and, if so, asks for the same fill as the maximize button.
  if (process.platform === 'win32') {
    const WM_PARENTNOTIFY = 0x0210;
    const WM_LBUTTONDOWN = 0x0201;
    const DOUBLE_CLICK_MS = 500;
    const DOUBLE_CLICK_PX = 4;
    let last = null;
    win.hookWindowMessage(WM_PARENTNOTIFY, (wParam, lParam) => {
      if (win.isDestroyed() || wParam.readUInt16LE(0) !== WM_LBUTTONDOWN) return;
      const press = { x: lParam.readInt16LE(0), y: lParam.readInt16LE(2), at: Date.now() };
      const isSecond = last && press.at - last.at <= DOUBLE_CLICK_MS &&
        Math.abs(press.x - last.x) <= DOUBLE_CLICK_PX && Math.abs(press.y - last.y) <= DOUBLE_CLICK_PX;
      last = isSecond ? null : press;
      // Physical pixels inside the window; the page converts with its devicePixelRatio
      if (isSecond) win.webContents.send('window-caption-double-click', { x: press.x, y: press.y });
    });
  }
  return fill;
}
const sessionImport = require('./src/sessionImport/ipc.js');
const { createMcpController } = require('./src/mcp/controller.js');
const { registerMcpIpc } = require('./src/mcp/ipc.js');
const { approvalNoticeTitle } = require('./src/mcp/approvalNotice.js');
const { createSessionLogger } = require('./src/sessionLog/sessionLogger.js');
const { createHostKeyStore } = require('./src/hostKeys/hostKeyStore.js');
const { withHostKeyCheck, hostKeyMessage } = require('./src/hostKeys/hostKeyCheck.js');
const { createHostKeyPrompter } = require('./src/hostKeys/hostKeyPrompt.js');

let mainWindow;

// Window / taskbar icon, copied next to the bundle at build time (electron.vite.config.ts). Set on every window so
// the taskbar shows it even where the exe still carries Electron's icon (`npm run dev` runs electron.exe).
const WINDOW_ICON = path.join(__dirname, 'icon.ico');

// Renderer dev server when electron-vite did not pass ELECTRON_RENDERER_URL (`electron . --dev`).
// Same port as renderer.server.port in electron.vite.config.ts.
const DEV_RENDERER_URL = 'http://localhost:15173';

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
let mcpController = null; // Local MCP server for Claude Code (src/mcp), created once the window exists
// Decrypted sessions for MCP calls while unlocked; decrypting (sync PBKDF2 per session) on every call froze the window.
// Cleared on save-sessions, import-sessions, lock-app and reset-master-password.
let mcpSessionsCache = null;
const sshConnections = new Map();
const sshStreams = new Map(); // sessionId:streamId -> stream (for split terminals)
// streamId -> the listeners a split shell was opened with, so they can be taken off when the shell
// becomes a tab of its own (ssh-adopt-split)
const splitStreamHandlers = new Map();
// Port forwarding (-L, -R, -D): src/ipc/portForward.js
const { setupRemoteForwardHandler, cleanupPortForwards, portForwardCount } = require('./src/ipc/portForward.js').registerPortForwardIpc({
  ipcMain, sshConnections, getWindowForSession
});

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

// SSH host keys (src/hostKeys): every connection checks the server's key against the saved one.
// Terminal connections and the connection test ask in the main window; reconnects and MCP never ask.
const hostKeyStore = createHostKeyStore({ filePath: path.join(userDataPath, 'known-hosts.json') });
const hostKeyPrompter = createHostKeyPrompter({
  send: (request) => sendToMainWindow('host-key-prompt', request),
  onDismiss: (id) => sendToMainWindow('host-key-dismiss', { id })
});
const checkHostKeyAsking = (attempt) => withHostKeyCheck({ store: hostKeyStore, prompt: hostKeyPrompter.prompt }, attempt);
const hostKeyFailureText = (err) => {
  const { error, hint } = hostKeyMessage(err);
  return `${error} ${hint}`;
};

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

function createStartupSplash(placement, rendererUrl) {
  const splash = new BrowserWindow({
    ...placement,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { sandbox: true, contextIsolation: true, devTools: false }
  });
  const { prefersReducedMotion } = systemPreferences.getAnimationSettings();
  let revealTimer;
  let onReveal;
  const showApp = () => {
    const callback = onReveal;
    onReveal = undefined;
    callback?.();
  };
  const dismiss = () => { if (!splash.isDestroyed()) splash.destroy(); };
  const release = () => {
    clearTimeout(revealTimer);
    showApp();
    dismiss();
  };
  splash.setIgnoreMouseEvents(true);
  splash.once('closed', () => {
    clearTimeout(revealTimer);
    showApp();
  });
  splash.webContents.once('render-process-gone', dismiss);
  const shown = new Promise(resolve => {
    splash.once('ready-to-show', () => {
      splash.showInactive();
      resolve();
    });
  });
  const loading = rendererUrl
    ? splash.loadURL(new URL('startup.html?startupMode=true', rendererUrl).href)
    : splash.loadFile(path.join(__dirname, '../renderer/startup.html'), { query: { startupMode: 'true' } });
  void loading.catch(dismiss);
  return {
    dismiss,
    revealWhenReady(callback, getBackdropColor) {
      if (prefersReducedMotion || splash.isDestroyed()) {
        callback();
        dismiss();
        return;
      }
      if (onReveal) return;
      onReveal = callback;
      // The terminal motion types its command and prints its lines (about 3.5 seconds) before it covers;
      // the app can be ready before the typing ends, so this bound is generous
      revealTimer = setTimeout(release, 8000);
      void Promise.all([shown, loading, getBackdropColor().catch(() => '')])
        .then(([, , color]) => {
          if (splash.isDestroyed()) return;
          return splash.webContents.executeJavaScript(`
            new Promise(resolve => {
              window.addEventListener('ezshell-startup-covered', () => resolve(true), { once: true });
              window.addEventListener('ezshell-startup-finished', () => resolve(false), { once: true });
              window.dispatchEvent(new CustomEvent('ezshell-startup-reveal', { detail: ${JSON.stringify(color)} }));
            })
          `);
        })
        .then(covered => {
          if (!covered || splash.isDestroyed()) return;
          // Show the ready window under the opaque splash, then let the backdrop fade out.
          showApp();
          return splash.webContents.executeJavaScript(`
            new Promise(resolve => {
              window.addEventListener('ezshell-startup-finished', () => resolve(), { once: true });
              requestAnimationFrame(() => requestAnimationFrame(() => {
                window.dispatchEvent(new Event('ezshell-startup-app-shown'));
              }));
            })
          `);
        })
        .then(release, release);
    }
  };
}

function createWindow() {
  // Opens where it was closed (also after an update restarts the app), if that place is still on a screen
  const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');
  const lastPlace = windowState.usableState(
    windowState.readState(windowStatePath),
    require('electron').screen.getAllDisplays().map(display => display.workArea)
  );
  // Glass surface style: acrylic behind the window has to be asked for here, at creation
  // (src/nativeBackdrop.js). Empty unless settings chose glass and this Windows can draw it.
  const appearance = nativeBackdrop.readAppearance(app.getPath('userData'));
  const backdrop = nativeBackdrop.backdropOptions(appearance, process.platform, require('os').release());
  mainWindowHasBackdrop = Object.keys(backdrop).length > 0;
  // The material's tint follows the app's light/dark setting
  if (mainWindowHasBackdrop) require('electron').nativeTheme.themeSource = appearance.scheme;
  mainWindow = new BrowserWindow({
    icon: WINDOW_ICON,
    show: false,
    width: lastPlace ? lastPlace.width : 1200,
    height: lastPlace ? lastPlace.height : 800,
    ...(lastPlace ? { x: lastPlace.x, y: lastPlace.y } : {}),
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1e1e2e',
    ...backdrop,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  // With acrylic the window must never be maximized natively (the material is lost for good): it fills
  // the work area of its screen instead (nativeBackdrop.createFillToggle)
  mainWindowFill = registerGlassWindow(mainWindow, backdrop);
  if (lastPlace?.isMaximized && mainWindowFill) mainWindowFill.fill(mainWindow.getBounds());
  windowState.trackWindow(mainWindow, windowStatePath, mainWindowFill
    ? { normalBounds: mainWindowFill.normalBounds, isMaximized: mainWindowFill.isFilled }
    : undefined);
  restoreTabsIpc.trackClose(mainWindow);

  const rendererUrl = process.env.ELECTRON_RENDERER_URL ||
    ((process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) ? DEV_RENDERER_URL : null);
  const win = mainWindow;
  const bounds = win.getBounds();
  const { workArea } = require('electron').screen.getDisplayMatching(bounds);
  const startupSplash = createStartupSplash(lastPlace?.isMaximized ? workArea : bounds, rendererUrl);
  // The renderer signals after committing the lock screen or the loaded session list.
  // Bound the wait so a stuck renderer can never leave an overlay on the desktop indefinitely.
  let starting = true;
  const reveal = () => {
    if (!starting || win.isDestroyed()) return;
    starting = false;
    clearTimeout(startupTimeout);
    if (lastPlace?.isMaximized && !mainWindowFill) win.maximize();
    win.show();
    if (rendererUrl) win.webContents.openDevTools();
  };
  const startupTimeout = setTimeout(() => {
    reveal();
    startupSplash.dismiss();
  }, 20000);
  win.once('closed', () => {
    starting = false;
    clearTimeout(startupTimeout);
    startupSplash.dismiss();
    browserReview.close();
  });
  win.webContents.ipc.on('app-startup-ready', (event) => {
    if (!starting || event.senderFrame !== win.webContents.mainFrame) return;
    startupSplash.revealWhenReady(reveal, () => win.webContents.executeJavaScript(
      "getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()"
    ));
  });
  const failStartup = (error) => {
    if (!starting || win.isDestroyed()) return;
    starting = false;
    clearTimeout(startupTimeout);
    console.error('[Startup] The main window could not load:', error);
    startupSplash.dismiss();
    dialog.showErrorBox('ezShell 시작 오류', '앱 화면을 열지 못했습니다. ezShell을 다시 실행해 주세요.');
    win.destroy();
  };
  win.webContents.once('render-process-gone', (_event, details) => failStartup(details.reason));
  win.webContents.on('render-process-gone', () => browserReview.close());
  win.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) browserReview.close();
  });
  const loading = rendererUrl ? win.loadURL(rendererUrl) : win.loadFile(path.join(__dirname, '../renderer/index.html'));
  void loading.catch(failStartup);

  // Disable Electron's built-in zoom, use IPC for terminal-only font size control
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Ctrl +/-/0 changes the terminal font size instead of Chromium's zoom (Command on macOS)
    const isZoomKey = process.platform === 'darwin' ? (input.meta && !input.control) : (input.control && !input.meta);
    if (isZoomKey && !input.alt) {
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
    // The message is a property of the event (the separate arguments are deprecated since Electron 35)
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[Renderer] ${event.message}`);
    });
  }

  // 렌더러 오류 캡처
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc) => {
    console.error(`[Renderer Load Error] ${errorCode}: ${errorDesc}`);
  });
}

// Updates and the "업데이트 내용" state: src/ipc/updates.js
const { setupAutoUpdater } = require('./src/ipc/updates.js').registerUpdateIpc({
  ipcMain, app, shell, sessionsFilePath,
  // Declared further down the file: looked up when a request arrives, not now
  fromMainWindow: (event) => fromMainWindow(event),
  get mainWindow() { return mainWindow; }
});

// App windows show only the app's own page. The browser view has a separate session and policy.
app.on('web-contents-created', (event, contents) => {
  if (browserReview.ownsPage(contents)) return;
  const devUrls = [
    process.env.ELECTRON_RENDERER_URL,
    process.argv.includes('--dev') ? DEV_RENDERER_URL : null
  ].filter(Boolean);
  navigationGuard.guardWebContents(contents, {
    rendererFile: path.join(__dirname, '../renderer/index.html'),
    devUrls
  });
});

app.whenReady().then(() => {
  // macOS always shows an application menu and its shortcuts work app-wide. Electron's default one
  // has Reload (Cmd+R drops every open tab) and Close Window (Cmd+W would quit): src/macMenu.js
  // replaces it with quit / edit / window only. Other platforms have no menu (frameless windows).
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate(app.name)));
  createWindow();
  startMcp();
  if (fs.existsSync(agentBridgeFile)) {
    void agentMessages.enableExternalBridge().catch(error => console.error('Failed to start the agent message bridge:', error.code || error.name));
  }

  // Auto-updater setup (production only)
  if (!process.env.ELECTRON_RENDERER_URL && !process.argv.includes('--dev')) {
    setupAutoUpdater();
  }
});

// Detached windows (SFTP, terminal, MCP activity, server file, DB): src/ipc/detachedWindows.js
const { sftpWindows, createRemoteFileWindow, createDbWindow, closeMcpActivityWindow, getMcpActivityWindow } = require('./src/ipc/detachedWindows.js').registerDetachedWindows({
  __dirname, ipcMain, app, BrowserWindow, WINDOW_ICON, DEV_RENDERER_URL, terminalWindows, glassWindows,
  glassWindowOptions, registerGlassWindow,
  get mainWindow() { return mainWindow; },
  get isAppLocked() { return isAppLocked; }
});

// ==================== 서버 파일 편집 / 미리보기 창 ====================
// One window per server file. Each window gets its own SFTP channel on the tab's connection and a
// document id; main answers a window only about its own document (src/remoteFiles).
const REMOTE_FILE_BACKUP_FOLDER = 'ezShell Backups';

const remoteBackupRoot = () => path.join(app.getPath('documents'), REMOTE_FILE_BACKUP_FOLDER);

// Folders the workspace panel may read files from: the open local shells' start folders and their
// repositories (src/localFiles/roots.js). localShells is set later; this is only called on a request.
const localRoots = createLocalRoots({
  knownFolders: async () => {
    const live = localShells ? localShells.list().filter(shellEntry => !shellEntry.exited) : [];
    const current = await Promise.all(live.map(shellEntry => localShells.currentDirectory(shellEntry.id).catch(() => null)));
    return [...live.map(shellEntry => shellEntry.cwd), ...current.filter(Boolean)];
  },
  repoFolders: localGit.repoFolders
});

const remoteDocuments = createRemoteDocuments({
  // Files on this PC (the workspace panel) open in the same windows
  localFiles: { read: localRead, headOf: (root, file) => localGit.fileAt(root, file) },
  // A container's log is shown in the same window as a followed file (src/containers/logs.js)
  containerLogs: createContainerLogs({ connectionOf: (sessionId) => sshConnections.get(sessionId)?.conn || null }),
  openSftp: (sessionId) => new Promise((resolve, reject) => {
    const session = sshConnections.get(sessionId);
    if (!session || !session.conn) return reject(Object.assign(new Error('no connection'), { code: 'NO_CONNECTION' }));
    session.conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  }),
  serverOf: (sessionId) => {
    const config = connectionStates.get(sessionId)?.config;
    return config ? { username: config.username, host: config.host } : null;
  },
  backups: {
    get root() { return remoteBackupRoot(); },
    store: {
      // Created on first use: app.getPath('documents') needs the app to be ready
      save: (target, content) => remoteBackupStore().save(target, content),
      list: (target) => remoteBackupStore().list(target),
      read: (target, name) => remoteBackupStore().read(target, name),
      remove: (target, name) => remoteBackupStore().remove(target, name),
      prune: (target, justMade) => remoteBackupStore().prune(target, justMade)
    }
  }
});
let backupStore = null;
function remoteBackupStore() {
  if (!backupStore) backupStore = createBackupStore({ root: remoteBackupRoot() });
  return backupStore;
}

const remoteFileIpc = registerRemoteFileIpc({
  ipcMain,
  docs: remoteDocuments,
  createWindow: createRemoteFileWindow,
  // Followed logs stop while the app is locked
  isLocked: () => isAppLocked,
  // The container log window opens from the main window's panel, for a container it listed
  fromMainWindow: (event) => fromMainWindow(event),
  isKnownContainer: (sessionId, name) => containers.isKnown(sessionId, name),
  resolveLocal: (root, relative) => localRoots.resolveInside(root, relative),
  openFolder: async (dir) => {
    await fs.promises.mkdir(dir, { recursive: true });
    const failure = await shell.openPath(dir);
    if (failure) throw new Error(failure);
  }
});

// ==================== DB 클라이언트 창 ====================
// One window per database connection, reached through a channel of the tab's SSH connection
// (no port is opened on this PC). Read-only; see src/dbClient.

const dbDiscovery = createDiscoveryCache();
// Oracle's client libraries for servers older than 12.1: installed by the user from the account
// dialog (downloaded from Oracle, checked, kept in the app's data folder). See src/dbClient/oracleClient.js.
const oracleClient = require('./src/dbClient/oracleClient.js').createOracleClientManager({ baseDir: path.join(userDataPath, 'oracle-client') });
const dbConnections = createDbConnections({
  oracleClient: () => oracleClient.location(),
  openStream: (sessionId, host, port) => new Promise((resolve, reject) => {
    const session = sshConnections.get(sessionId);
    if (!session || !session.conn) return reject(Object.assign(new Error('no connection'), { code: 'NO_CONNECTION' }));
    session.conn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)));
  })
});
const dbIpc = registerDbIpc({
  ipcMain,
  connections: dbConnections,
  // Once per connection (a reconnected tab is looked at again); a tab without a connection has none
  discover: async (sessionId) => {
    const session = sshConnections.get(sessionId);
    return session && session.conn ? dbDiscovery.discover(session.conn) : [];
  },
  createWindow: createDbWindow,
  isLocked: () => isAppLocked,
  // Discovery and opening come only from the main window, which holds the sessions
  isMainWindow: (senderId) => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId)
});

// ==================== Local terminal tabs ====================
// Shells of this PC (src/localShell.js). Only the main window opens and drives them.
const fromMainWindow = (event) => Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
const sendToLocalWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
let localShells = null;
const agentBridgeFile = path.join(userDataPath, 'agent-message-connection');
const agentMessages = require('./src/ipc/agentMessages.js').createAgentMessages({
  notify: (channel, payload) => {
    sendToLocalWindow(channel, payload);
    if (channel === 'agent-messages-state') browserReview?.updateAgents();
  },
  isLocked: () => isAppLocked,
  onInboxChanged: id => localShells?.wakeInbox(id),
  bindLocalAgent: request => localShells?.bindAgentProcess(request),
  bridgeFile: agentBridgeFile
});
const browserReview = require('./src/ipc/browserReview.js').registerBrowserReview({
  fromMainWindow: event => !isAppLocked && fromMainWindow(event),
  fromTerminalWindow: event => !isAppLocked && Array.from(terminalWindows.values()).some(win => !win.isDestroyed() && win.webContents === event.sender),
  getWindow: () => mainWindow,
  listAgents: () => agentMessages.snapshot().agents
    .filter(agent => agent.active && agent.mcpConnected && localShells?.isRunning(agent.shellId))
    .map(({ id, kind, cwd, status }) => ({ id, kind, cwd, status })),
  sendMessage: agentMessages.sendAsUser,
  openExternal: url => shell.openExternal(url)
});
const { installAgentMessageMcp } = require('./src/ipc/agentMessageSetup.js');
const agentSetupInProgress = new Set();
ipcMain.handle('agent-message-mcp-setup', async (event, kind) => {
  if (!fromMainWindow(event) || isAppLocked) return { success: false, error: '먼저 잠금을 해제해 주세요.' };
  if (!['codex', 'claude'].includes(kind)) return { success: false, error: '지원하지 않는 실행 도구입니다.' };
  if (agentSetupInProgress.has(kind)) return { success: false, error: '이미 등록 중입니다.' };
  agentSetupInProgress.add(kind);
  try {
    const result = await installAgentMessageMcp(kind, { bridgeFile: agentBridgeFile, enableBridge: agentMessages.enableExternalBridge });
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    agentSetupInProgress.delete(kind);
  }
});
function getLocalShells() {
  if (!localShells) {
    // Loaded on first use: a native module, and most runs of the app never open a local terminal
    const pty = require('node-pty');
    localShells = createLocalShells({
      spawn: pty.spawn,
      send: sendToLocalWindow,
      agents: agentMessages
    });
  }
  return localShells;
}
ipcMain.handle('local-shell-open', async (event, size) => {
  if (!fromMainWindow(event)) return { success: false, error: '본창에서만 열 수 있습니다.' };
  if (isAppLocked) return { success: false, error: '먼저 잠금을 해제해 주세요.' };
  try {
    // Resuming takes a key from the agent history list: the folder, agent and session id are the
    // ones main read from the transcript, never what the window sends
    const { resume, ...options } = size || {};
    if (resume !== undefined) {
      let target = typeof resume === 'string' ? agentHistory.target(resume) : null;
      // Tabs opened again right after a restart: nothing has listed the transcripts yet
      if (!target && typeof resume === 'string') {
        await agentHistory.list().catch(() => {});
        if (!fromMainWindow(event) || isAppLocked) return { success: false, error: '먼저 잠금을 해제해 주세요.' };
        target = agentHistory.target(resume);
      }
      if (!target) return { success: false, error: '에이전트 기록을 새로 고친 뒤 다시 시도해 주세요.' };
      Object.assign(options, { cwd: target.cwd, agent: target.agent, resume: target.id });
    }
    if (options.agent === 'codex' || options.agent === 'claude') {
      await agentMessages.ready();
      if (!fromMainWindow(event) || isAppLocked) return { success: false, error: '먼저 잠금을 해제해 주세요.' };
    } else {
      // A plain shell gets a shell token for the usage of a Claude typed into it; without the pipe it
      // opens all the same
      await agentMessages.ready().catch(() => {});
      if (!fromMainWindow(event) || isAppLocked) return { success: false, error: '먼저 잠금을 해제해 주세요.' };
    }
    return { success: true, ...getLocalShells().open(options) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('local-shell-attach', (event, id) => (fromMainWindow(event) && localShells ? localShells.attach(id) : null));
// A reloaded window has no tabs but the shells kept running: it takes them back (lib/localShellAdopt.ts)
ipcMain.handle('local-shell-list', (event) => (fromMainWindow(event) && !isAppLocked && localShells ? localShells.list() : []));
ipcMain.handle('local-shell-current-directory', (event, id) =>
  fromMainWindow(event) && !isAppLocked ? localShells?.currentDirectory(id) ?? null : null
);
ipcMain.handle('local-shell-working-agent', (event, ids) =>
  Boolean(fromMainWindow(event) && !isAppLocked && Array.isArray(ids) && ids.length <= 20 && localShells?.hasWorkingAgent(ids))
);
ipcMain.on('local-shell-write', (event, { id, data }) => { if (fromMainWindow(event)) localShells?.write(id, data); });
ipcMain.on('local-shell-composing', (event, { id, value }) => {
  if (fromMainWindow(event) && typeof value === 'boolean') localShells?.setComposing(id, value);
});
ipcMain.on('local-shell-resize', (event, { id, cols, rows }) => { if (fromMainWindow(event)) localShells?.resize(id, cols, rows); });
ipcMain.on('local-shell-close', (event, id) => { if (fromMainWindow(event)) localShells?.close(id); });
const localTerminalClipboard = require('./src/ipc/localTerminalClipboard.js').createLocalTerminalClipboard(clipboard, nativeImage);
ipcMain.handle('local-shell-clipboard', async (event, id) => {
  const canPaste = () => fromMainWindow(event) && !isAppLocked && localShells?.isRunning(id);
  const empty = { success: true, text: '' };
  if (!canPaste()) return empty;
  try {
    const { text, image } = await localTerminalClipboard.read();
    if (!canPaste()) return empty;
    if (!image) return { success: true, text };
    if (localShells.pasteClipboardImage(id)) return empty;
    const decoded = await localTerminalClipboard.decodeImage(image);
    return canPaste() ? { success: true, text: localTerminalClipboard.saveImage(decoded) } : empty;
  } catch (error) {
    return { success: false, error: error.code ? '클립보드 이미지를 저장하지 못했습니다.' : error.message };
  }
});
app.on('will-quit', () => localTerminalClipboard.dispose());
app.on('will-quit', () => {
  localShells?.closeAll();
  agentMessages.stop();
});
ipcMain.handle('agent-messages-state', event =>
  fromMainWindow(event) && !isAppLocked ? agentMessages.snapshot() : null
);
// Usage of the agents ezShell launched (status bar): Claude reports it from its status line over the
// agent pipe, Codex's comes from its session file. Numbers and the model name only.
const codexUsageWatcher = require('./src/ipc/codexUsageWatcher.js').createCodexUsageWatcher({
  agents: () => agentMessages.snapshot().agents,
  setUsage: (agentId, usage) => agentMessages.setUsage(agentId, usage)
});
codexUsageWatcher.start();
ipcMain.handle('agent-usage-state', event => (fromMainWindow(event) && !isAppLocked ? agentMessages.usageSnapshot() : []));
require('./src/ipc/localProjects.js').registerLocalProjectIpc({ ipcMain, fromMainWindow, isLocked: () => isAppLocked, roots: localRoots, git: localGit });
// Past Claude Code and Codex sessions of this PC, for the right panel (src/agentHistory)
const agentHistory = require('./src/agentHistory/history.js').createAgentHistory();
require('./src/agentHistory/ipc.js').registerAgentHistoryIpc({
  ipcMain, fromMainWindow, isLocked: () => isAppLocked, history: agentHistory,
  folderForShell: id => localShells?.list().find(entry => entry.id === id)?.cwd,
  openPath: folder => shell.openPath(folder)
});
// A local shell's Claude Code / Codex drawn as a chat over its pane (src/agentChat). The transcript is
// the agent's own file: main finds it from the agent's session id (usage report) or Codex's watcher.
const agentChats = require('./src/agentChat/chats.js').createAgentChats({
  send: sendToLocalWindow,
  claudeRoot: require('./src/agentHistory/history.js').agentRoots(process.env, require('os').homedir()).claude,
  isGone: shellId => !localShells?.list().some(entry => entry.id === shellId),
  resolve: async (shellId) => {
    const running = localShells?.agentOf(shellId);
    if (!running) return null;
    const approval = localShells.approvalOf(shellId);
    const agent = agentMessages.snapshot().agents.filter(item => item.active && item.shellId === shellId && item.kind === running.kind).at(-1);
    if (!agent) return { kind: running.kind, approval };
    const usage = agentMessages.usageSnapshot().find(item => item.agentId === agent.id)?.usage;
    return {
      kind: running.kind,
      approval,
      cwd: agent.cwd ?? null,
      sessionId: usage?.sessionId ?? agent.resumeId ?? null,
      file: running.kind === 'codex' ? codexUsageWatcher.fileOf(agent.id) : null
    };
  }
});
const agentChatIpc = require('./src/agentChat/ipc.js').registerAgentChatIpc({
  ipcMain, fromMainWindow, isLocked: () => isAppLocked, chats: agentChats, shells: () => localShells,
  clipboard: localTerminalClipboard,
  // Links in answers: the file manager shows a file (never runs it), the file window reads it
  links: {
    openExternal: url => shell.openExternal(url),
    openBrowserTab: browserReview.openLink,
    showItemInFolder: target => shell.showItemInFolder(target),
    openLocalFile: (target, line) => remoteFileIpc.openLocalFile(target, '에이전트 대화', line)
  }
});

// A query result the user chose to export ("추출" in a DB tab or DB window), saved where they pick.
// The only way a result reaches the disk; text or the bytes of a spreadsheet file.
const EXPORT_MAX_BYTES = 128 * 1024 * 1024;
const EXPORT_FILTERS = {
  xlsx: 'Excel 파일', csv: 'CSV', tsv: 'TSV', sql: 'SQL', json: 'JSON', md: 'Markdown'
};
// The save dialog's title: the window names a kind, never the words themselves
const EXPORT_TITLES = { result: '결과 추출', 'ui-settings': '화면 설정 내보내기' };
ipcMain.handle('save-export-file', async (event, { defaultName, extension, data, kind }) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || isAppLocked) return { success: false, error: '저장할 수 없습니다.' };
  const isText = typeof data === 'string';
  if (!isText && !(data instanceof Uint8Array)) return { success: false, error: '저장할 수 없는 내용입니다.' };
  if (!Object.prototype.hasOwnProperty.call(EXPORT_FILTERS, extension)) return { success: false, error: '지원하지 않는 형식입니다.' };
  if ((isText ? Buffer.byteLength(data, 'utf-8') : data.byteLength) > EXPORT_MAX_BYTES) return { success: false, error: '내용이 너무 큽니다.' };
  try {
    const result = await dialog.showSaveDialog(owner, {
      title: Object.prototype.hasOwnProperty.call(EXPORT_TITLES, kind) ? EXPORT_TITLES[kind] : EXPORT_TITLES.result,
      defaultPath: path.basename(String(defaultName || `query.${extension}`)),
      filters: [{ name: EXPORT_FILTERS[extension], extensions: [extension] }, { name: '모든 파일', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    await fs.promises.writeFile(result.filePath, isText ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength), isText ? 'utf-8' : undefined);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ==================== Oracle client libraries (old Oracle servers) ====================
/** What the account dialog shows: installed or not, and whether this run already connected without them */
function oracleClientStatus() {
  // The driver is loaded only once an Oracle connection was made; asking must not load it
  let isInUse = false;
  try {
    const loaded = require.cache[require.resolve('./src/dbClient/drivers/oracle.js')];
    isInUse = Boolean(loaded) && loaded.exports.isThickLoaded();
  } catch (err) {
    isInUse = false;
  }
  // In use: the files are held by this run and cannot be removed until the app restarts
  return { success: true, ...oracleClient.status(), needsRestart: false, isInUse };
}
ipcMain.handle('oracle-client-status', (event) => (fromMainWindow(event) ? oracleClientStatus() : { success: false, error: '본창에서만 볼 수 있습니다.' }));
ipcMain.handle('oracle-client-install', async (event) => {
  if (!fromMainWindow(event)) return { success: false, error: '본창에서만 설치할 수 있습니다.' };
  try {
    await oracleClient.install((progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('oracle-client-progress', progress);
    });
    return oracleClientStatus();
  } catch (err) {
    console.error('Oracle client install failed:', err && err.message);
    return { success: false, error: String((err && err.message) || '설치하지 못했습니다.').slice(0, 300) };
  }
});
ipcMain.handle('oracle-client-remove', (event) => {
  if (!fromMainWindow(event)) return { success: false, error: '본창에서만 제거할 수 있습니다.' };
  try {
    oracleClient.remove();
    return oracleClientStatus();
  } catch (err) {
    return { success: false, error: '사용 중이라 지울 수 없습니다. ezShell 을 다시 시작한 뒤 제거하세요.' };
  }
});
// The licence page is opened by the app itself: the address is fixed here, not taken from the window
ipcMain.handle('oracle-client-license', (event) => {
  if (fromMainWindow(event)) void shell.openExternal(oracleClient.status().licenseUrl);
  return { success: true };
});

// ==================== Remote access (a phone's browser, over Tailscale) ====================
// Off unless switched on in the settings. Listens only on this PC's Tailscale address, only while
// the app is unlocked. Design: docs/plan/2026-11-13-remote-access-over-tailscale.md
const remoteAccess = require('./src/remoteAccess/controller.js').registerRemoteAccess({
  ipcMain,
  userDataPath,
  hostKeys: hostKeyStore,
  isLocked: () => isAppLocked,
  readSessions: () => readDecryptedSessions(),
  readFolders: () => loadFromFile(foldersFilePath, []),
  readExpandedFolders: () => loadFromFile(path.join(userDataPath, 'folders-expanded.json'), []),
  // Tabs open on the PC, by the saved session they were opened from (the dots in the phone's list)
  readOpenTabs: () => {
    const tabs = new Map();
    for (const connState of connectionStates.values()) {
      const savedId = connState && connState.config && connState.config.savedSessionId;
      if (!savedId) continue;
      const count = tabs.get(savedId) || { connected: 0, disconnected: 0 };
      if (connState.state === ConnectionState.CONNECTED) count.connected += 1;
      else count.disconnected += 1;
      tabs.set(savedId, count);
    }
    return tabs;
  },
  // What a phone notification says about a question: its kind and risk only (see approvalNotice.js)
  describeApproval: (request) => `${approvalNoticeTitle(request)} · 위험도 ${MCP_LEVEL_LABELS[request.level] || request.level}`,
  // Nobody at the PC for a minute: a question is announced on the phones without waiting
  isUserAway: () => {
    try {
      return require('electron').powerMonitor.getSystemIdleTime() >= 60;
    } catch {
      return false;
    }
  },
  // MCP questions and activity, for a signed-in device (the controller exists once MCP was started)
  mcp: {
    currentApproval: () => (mcpController ? mcpController.currentApproval() : null),
    respondApproval: (id, approved, device) => Boolean(mcpController) && mcpController.respondApprovalFrom(id, approved, device),
    listActivity: () => (mcpController && !isAppLocked ? mcpController.listActivity() : []),
    cancelActivity: (id, device) => Boolean(mcpController) && mcpController.cancelActivityFrom(id, device) === true
  },
  fromMainWindow,
  notify: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  },
  // The authenticator secret is sealed with the OS account (DPAPI on Windows), like the auto-unlock password
  sealer: {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    seal: (text) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : null),
    unseal: (sealed) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(sealed, 'base64')) : null)
  }
});
app.on('will-quit', () => remoteAccess.stop());

// Terminal output chosen in the right-click menu, saved where the user picks
ipcMain.handle('save-terminal-output', async (event, { defaultName, text }) => {
  if (!fromMainWindow(event) || typeof text !== 'string') return { success: false, error: '저장할 수 없습니다.' };
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '터미널 출력 저장',
      defaultPath: path.basename(String(defaultName || 'terminal.txt')),
      filters: [{ name: '텍스트', extensions: ['txt', 'log'] }, { name: '모든 파일', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    await fs.promises.writeFile(result.filePath, text, 'utf-8');
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Set once the MCP side has shut down, so the quit that follows goes through
let isMcpShutDownForQuit = false;

app.on('before-quit', (event) => {
  sessionLogger?.closeAllNow();
  if (!mcpController || isMcpShutDownForQuit) return;
  // A background job is stopped by a command sent to its server; quitting at once would lose that
  // command and leave the job running there. The wait is bounded (a few seconds at most).
  const mustWait = mcpController.hasJobs();
  const shutdown = mcpController.shutdown().catch(() => {});
  if (!mustWait) return;
  event.preventDefault();
  shutdown.finally(() => {
    isMcpShutDownForQuit = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  mcpController?.shutdown().catch(() => {});
  sessionLogger?.closeAllNow();
  flushCommandHistory();
  // 모든 SSH 연결 종료
  sshConnections.forEach(({ conn }) => {
    try { conn.end(); } catch (e) {}
  });
  // 이 핸들러는 이미 MCP 종료·SSH 정리까지 하므로, 창을 모두 닫으면 플랫폼과 무관하게 종료한다.
  // macOS 기본값(창을 닫아도 유지)으로 두면, 정리가 끝난 반쯤 죽은 상태로 앱만 Dock 에 남는다
  // (단일 창 앱이고 창을 되살릴 경로도 없다). 그래서 Windows 와 같이 바로 종료한다.
  app.quit();
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
  localShells?.wakeInboxes();
  void remoteAccess.start();

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
    localShells?.wakeInboxes();
    resealSessionsFile();
    void remoteAccess.start();
    return { success: true };
  }

  return { success: false, error: 'Incorrect password' };
});

// Lock the app
ipcMain.handle('lock-app', async (event, restoreRecord) => {
  if (fromMainWindow(event)) restoreTabsIpc.rememberBeforeLock(restoreRecord);
  // Write pending history while the password is still known, then drop the decrypted copy
  flushCommandHistory();
  forgetCommandHistory();
  currentMasterPassword = null;
  isAppLocked = true;
  browserReview.close();
  mcpSessionsCache = null;
  mcpController?.onLocked();
  agentHistory.clear();
  agentChats.closeAll();
  agentChatIpc.clearClipboard();
  hostKeyPrompter.dismissAll();
  closeMcpActivityWindow();
  // File previews and followed logs must not stay on screen behind the lock (edit windows keep unsaved text)
  remoteFileIpc.closeViewWindows();
  // Query results must not stay on screen behind the lock
  dbIpc.closeAll();
  // Remote devices are dropped and the port is closed until the app is unlocked again
  remoteAccess.stop({ wasLocked: true });
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
  browserReview.close();
  mcpSessionsCache = null;
  mcpController?.onLocked();
  agentHistory.clear();
  agentChats.closeAll();
  agentChatIpc.clearClipboard();
  remoteFileIpc.closeViewWindows();
  // Query results must not stay on screen behind the lock
  dbIpc.closeAll();
  // Remote devices are dropped and the port is closed until the app is unlocked again
  remoteAccess.stop({ wasLocked: true });
  masterPasswordVerification = null;

  return { success: true };
});

// ==================== Encrypted Session Storage ====================

/** Decrypt sessions.json with the current master password. Callers check the lock state first. */
function readDecryptedSessions() {
  const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
  if (!fs.existsSync(sessionsPath)) return [];

  const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  // Secret fields are in the encrypted blob (src/sessionSecrets.js); older files still open
  return sessions.map(session => {
    const opened = sessionSecrets.openSession(session, currentMasterPassword);
    if (opened.decryptionFailed) console.error('Failed to decrypt session:', session.name);
    return opened;
  });
}

/** Writes sessions.json through a temporary file, so a failed write cannot leave half a file */
function writeSessionsFile(sessions) {
  const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
  const temporary = `${sessionsPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(sessions, null, 2));
  fs.renameSync(temporary, sessionsPath);
}

/**
 * Right after unlocking: secrets that older versions wrote in plain text (root switch and jump host
 * passwords, saved database accounts) move into the encrypted blob. Sessions that do not open with
 * this password are left as they are. Failing here must not stop the unlock.
 */
function resealSessionsFile() {
  try {
    const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
    if (!fs.existsSync(sessionsPath) || !currentMasterPassword) return;
    const resealed = sessionSecrets.resealAll(JSON.parse(fs.readFileSync(sessionsPath, 'utf8')), currentMasterPassword);
    if (!resealed) return;
    writeSessionsFile(resealed);
    mcpSessionsCache = null;
    console.log('[sessions] secrets written in plain text by an older version are now encrypted');
  } catch (error) {
    console.error('[sessions] could not encrypt the remaining secrets:', error.message);
  }
}

// 세션 저장/로드 IPC (with encryption)
ipcMain.handle('load-sessions', async () => {
  if (isAppLocked || !currentMasterPassword) {
    return { success: false, error: 'App is locked', sessions: [] };
  }

  try {
    // Whatever way the window got unlocked: no secret stays in plain text once sessions are read
    resealSessionsFile();
    return { success: true, sessions: readDecryptedSessions() };
  } catch (err) {
    console.error('Failed to load sessions:', err);
    return { success: false, error: err.message, sessions: [] };
  }
});

ipcMain.handle('save-sessions', async (event, sessions) => {
  if (isAppLocked || !currentMasterPassword) {
    return { success: false, error: 'App is locked' };
  }

  if (!Array.isArray(sessions)) return { success: false, error: 'Invalid sessions' };
  // Every secret field (passwords, key paths, saved database accounts) goes into the encrypted blob
  writeSessionsFile(sessions.map(session => sessionSecrets.sealSession(session, currentMasterPassword)));
  mcpSessionsCache = null;
  mcpController?.onSessionsSaved();

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

// SFTP path bookmarks: src/ipc/pathBookmarks.js
require('./src/ipc/pathBookmarks.js').registerPathBookmarksIpc({
  ipcMain, BrowserWindow, userDataPath, loadFromFile, saveToFile, connectionStates
});

// Terminal command history: src/ipc/commandHistory.js
const { flushCommandHistory, discardCommandHistory, forgetCommandHistory } = require('./src/ipc/commandHistory.js').registerCommandHistoryIpc({
  ipcMain, BrowserWindow, userDataPath,
  get currentMasterPassword() { return currentMasterPassword; },
  get isAppLocked() { return isAppLocked; }
});

// ==================== MCP Server (Claude Code) ====================

function sendToMainWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
  mainWindow.webContents.send(channel, payload);
  return true;
}

/** Activity updates go to every window showing the activity: the main window and the MCP activity window */
function sendToActivityViews(channel, payload) {
  sendToMainWindow(channel, payload);
  const activityWindow = getMcpActivityWindow();
  if (!activityWindow || activityWindow.isDestroyed() || activityWindow.webContents.isLoading()) return;
  activityWindow.webContents.send(channel, payload);
}

// Session logs: terminal output of a tab written to a text file, started per tab by the user (src/sessionLog)
const SESSION_LOG_FOLDER = 'ezShell Logs';
const MAX_SESSION_LOG_NAME = 200;
let sessionLogger = null;
const sessionLogDir = () => path.join(app.getPath('documents'), SESSION_LOG_FOLDER);

function notifySessionLog(sessionId, payload) {
  sendToMainWindow('session-log-changed', { sessionId, ...payload });
}

function getSessionLogger() {
  if (!sessionLogger) {
    sessionLogger = createSessionLogger({
      dir: sessionLogDir(),
      onStopped: ({ sessionId, filePath, error }) => notifySessionLog(sessionId, { isLogging: false, filePath, error })
    });
  }
  return sessionLogger;
}

/** The tab was closed or its connection ended for good: finish its log, if it has one. */
function endSessionLog(sessionId) {
  if (!sessionLogger) return;
  sessionLogger.forget(sessionId);
  if (!sessionLogger.isLogging(sessionId)) return;
  sessionLogger.stop(sessionId)
    .then((result) => notifySessionLog(sessionId, { isLogging: false, filePath: result.filePath, error: result.success ? undefined : result.error }))
    .catch((err) => console.error('Failed to end session log:', err));
}

const MCP_LEVEL_LABELS = { low: '낮음', medium: '중간', danger: '위험' };
let mcpFlashHandlerAttached = false;
let mcpNotice = null; // keep a reference so the notification is not garbage-collected before its click fires

/** Bring the main window back (notification click); it may already be closed while a pop-out stays open */
function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Flash the taskbar and show an OS notification. Never includes the command (toasts persist in the Action Center). */
function alertMcpApproval(request) {
  if (!mcpFlashHandlerAttached) {
    mainWindow.on('focus', () => mainWindow.flashFrame(false));
    mcpFlashHandlerAttached = true;
  }
  mainWindow.flashFrame(true);
  if (Notification.isSupported()) {
    mcpNotice = new Notification({
      title: approvalNoticeTitle(request),
      body: `${request.sessionName} · 위험도 ${MCP_LEVEL_LABELS[request.level] || request.level}`
    });
    mcpNotice.on('click', revealMainWindow);
    mcpNotice.show();
  }
}

/**
 * Keep the main window above other windows while a question is shown, restoring it if minimized.
 * It does not take keyboard focus: an Enter or Esc typed into another program would answer the dialog.
 */
function keepMainWindowOnTop(onTop) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setAlwaysOnTop(onTop);
    if (!onTop) return;
    // Always, not only when minimized: a window that was covered by others stays "hidden" to Chromium
    // (native occlusion) after setAlwaysOnTop/moveTop alone, so it keeps showing its old frame without
    // the dialog until clicked. showInactive makes it visible again and keeps a maximized window maximized.
    mainWindow.showInactive();
    mainWindow.moveTop();
  } catch (err) {
    console.error('Failed to raise the window for MCP approval:', err);
  }
}

/** Ask in the app, with the window on top; when it is in the background, also flash it and show a notification */
function showMcpApproval(request) {
  const delivered = sendToMainWindow('mcp-approval-request', request);
  if (delivered) keepMainWindowOnTop(true);
  // Also to the phones that are signed in (remote access), when the user wants answers from there
  if (delivered) {
    try {
      remoteAccess.showApproval(request);
    } catch (err) {
      console.error('Failed to send the MCP approval to remote devices:', err);
    }
  }
  if (delivered && !mainWindow.isFocused()) {
    try {
      alertMcpApproval(request);
    } catch (err) {
      console.error('Failed to alert MCP approval:', err);
    }
  }
  return delivered;
}

/** Sessions for the MCP tools: decrypted once per unlock (and after each save), not on every call */
function loadMcpSessions() {
  if (isAppLocked || !currentMasterPassword) return [];
  if (!mcpSessionsCache) mcpSessionsCache = readDecryptedSessions();
  return mcpSessionsCache;
}

function startMcp() {
  mcpController = createMcpController({
    userDataPath,
    version: app.getVersion(),
    isUnlocked: () => !isAppLocked && Boolean(currentMasterPassword),
    loadSessions: loadMcpSessions,
    loadFolders: () => loadFromFile(foldersFilePath, []),
    showApproval: showMcpApproval,
    dismissApproval: (id) => sendToMainWindow('mcp-approval-dismiss', { id }),
    approvalClosed: (id, outcome) => {
      keepMainWindowOnTop(false);
      remoteAccess.approvalClosed(id, outcome);
    },
    approvalMinTimeoutMs: () => remoteAccess.approvalWaitMs(),
    emitActivity: (item) => {
      sendToActivityViews('mcp-activity', item);
      remoteAccess.activityItem(item);
    },
    emitActivityOutput: (payload) => {
      sendToActivityViews('mcp-activity-output', payload);
      remoteAccess.activityOutput(payload);
    },
    hostKeys: hostKeyStore
  });
  mcpController.start().catch(err => console.error('Failed to start MCP server:', err));
}

/** Folder for the "MCP 자동 설정" project option; null when the dialog is cancelled */
async function pickMcpProjectDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Claude Code 프로젝트 폴더 선택',
    properties: ['openDirectory']
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}

/** Folder the MCP transfer tools may read and write; null when the dialog is cancelled */
async function pickMcpTransferDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'MCP 파일 전송 허용 폴더 선택',
    properties: ['openDirectory']
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}

registerMcpIpc(ipcMain, () => mcpController, () => !isAppLocked && Boolean(currentMasterPassword), {
  pickDirectory: pickMcpProjectDir,
  pickTransferDirectory: pickMcpTransferDir
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

    // An imported backup must never opt sessions into MCP access on its own
    const importedSessions = importData.sessions.map(session => (
      session && typeof session === 'object' ? { ...session, mcpEnabled: false } : session
    ));
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

    // Save merged/replaced sessions. A backup holds its passwords in plain text: they are encrypted now
    writeSessionsFile(finalSessions);
    resealSessionsFile();
    mcpSessionsCache = null;
    mcpController?.onSessionsSaved();

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
// Glass surface style. The renderer tells what settings chose (kept for the next start, when the main
// window can be created with acrylic) and asks whether its window has the material now.
// Main window only; the stored value is two fixed words, whatever is sent.
let mainWindowHasBackdrop = false;
let mainWindowFill = null;
ipcMain.on('appearance-set', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  try {
    const saved = nativeBackdrop.writeAppearance(app.getPath('userData'), value);
    if (mainWindowHasBackdrop) require('electron').nativeTheme.themeSource = saved.scheme;
  } catch (error) {
    console.error('appearance.json could not be written:', error.message);
  }
});
ipcMain.handle('appearance-backdrop', (event) => ({
  // Drawn behind this window right now
  active: glassWindows.has(BrowserWindow.fromWebContents(event.sender)),
  // Could be drawn after a restart with glass chosen
  supported: nativeBackdrop.supportsAcrylic(process.platform, require('os').release())
}));

// See-through window: the sender's own window only, and never fainter than half (a window that cannot
// be seen cannot be found again). The renderer keeps the setting and sends it on start.
ipcMain.on('window-set-opacity', (event, opacity) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const value = typeof opacity === 'number' && Number.isFinite(opacity) ? Math.min(1, Math.max(0.5, opacity)) : 1;
  win.setOpacity(value);
});

ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const fill = glassWindows.get(win);
    if (fill) {
      // A window with acrylic must not be maximized (the material is lost): it fills the work area
      fill.toggle();
    } else if (win.isMaximized()) {
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

// Docker containers of a tab's server (src/containers): listed only while the user has the panel open
const containers = registerContainerIpc({
  ipcMain,
  connectionOf: (sessionId) => sshConnections.get(sessionId)?.conn || null,
  fromMainWindow: (event) => fromMainWindow(event),
  isLocked: () => isAppLocked
});

// The tabs open at exit or before an update: src/ipc/restoreTabs.js
const restoreTabsIpc = require('./src/ipc/restoreTabs.js').registerRestoreTabsIpc({
  ipcMain, app, fromMainWindow,
  // Declared further down the file: looked up when a request arrives, not now
  activeTransferCount: () => activeTransferCount(),
  unsavedEditCount: () => remoteFileIpc.unsavedEditCount(),
  get isAppLocked() { return isAppLocked; },
  get currentMasterPassword() { return currentMasterPassword; }
});

// SFTP panel, this PC's files and the transfer queue: src/ipc/sftp.js
const { closeSftpSession, activeTransferCount } = require('./src/ipc/sftp.js').registerSftpIpc({
  ipcMain, dialog, app, shell, sshConnections, sftpWindows,
  get mainWindow() { return mainWindow; }
});

// A tab's SSH connection, reconnecting and the session log IPC: src/ipc/sshSessions.js
const { attemptReconnect, endedByItself, reportShellExit } = require('./src/ipc/sshSessions.js').registerSshSessionIpc({
  ipcMain, shell, sshConnections, sshStreams, splitStreamHandlers, connectionStates, ConnectionState, updateConnectionState,
  getWindowForSession, hostKeyStore, hostKeyPrompter, checkHostKeyAsking, hostKeyFailureText, setupRemoteForwardHandler, cleanupPortForwards, containers,
  getSessionLogger, notifySessionLog, endSessionLog, sessionLogDir, MAX_SESSION_LOG_NAME, closeSftpSession,
  get mainWindow() { return mainWindow; },
  get isAppLocked() { return isAppLocked; },
  get sessionLogger() { return sessionLogger; }
});
// Split shells and moving one out to a tab: src/ipc/splitShells.js
require('./src/ipc/splitShells.js').registerSplitShellIpc({
  ipcMain, sshConnections, sshStreams, splitStreamHandlers, connectionStates, ConnectionState, updateConnectionState, getWindowForSession,
  fromMainWindow, attemptReconnect, endedByItself, reportShellExit, endSessionLog, portForwardCount, containers, closeSftpSession,
  get isAppLocked() { return isAppLocked; },
  get sessionLogger() { return sessionLogger; }
});

// Other programs' sessions (Xshell, PuTTY, MobaXterm, Tabby, OpenSSH config): structure only, no
// passwords (src/sessionImport). Main window only; the window never sends a path.
sessionImport.registerSessionImportIpc({
  ipcMain,
  dialog,
  fromMainWindow,
  getMainWindow: () => mainWindow,
  importer: sessionImport.createSessionImport({
    platform: process.platform,
    getPath: (name) => app.getPath(name),
    env: process.env,
    home: require('os').homedir(),
    execFile: require('child_process').execFile
  })
});
