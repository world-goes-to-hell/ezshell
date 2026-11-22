// The windows that come off the main window: SFTP, terminal, MCP activity, server file, DB.
// Each kind opens where its last window was left (src/detachedPlaces.js). Also the IPC that moves a
// terminal tab out to a window and back, with its screen. Moved out of main.js as it was.
//
// `__dirname` is main.js's folder, handed in: the preload script and the page are found from there.

const path = require('path');
const detachedPlaces = require('../detachedPlaces.js');

function registerDetachedWindows(ctx) {
  const { __dirname, ipcMain, app, BrowserWindow, WINDOW_ICON, DEV_RENDERER_URL, terminalWindows, glassWindows, glassWindowOptions, registerGlassWindow } = ctx;

  // SFTP 별도 창 저장소
  const sftpWindows = new Map();
  // The folders each SFTP window shows now (reported by the window), handed back when it closes
  const sftpWindowPaths = new Map();
  ipcMain.on('sftp-window-paths', (event, { sessionId, localPath, remotePath } = {}) => {
    const win = sftpWindows.get(sessionId);
    // Only the SFTP window of that session may report for it
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (typeof localPath !== 'string' || typeof remotePath !== 'string' || localPath.length > 4096 || remotePath.length > 4096) return;
    sftpWindowPaths.set(sessionId, { localPath, remotePath });
  });

  // Detached windows open where the last window of their kind was left (src/detachedPlaces.js).
  // `open(kind, fallback, min)` gives the place for a new window, `options(place)` its BrowserWindow
  // options; `track(win, kind, place, fill)` restores "maximized", remembers the window while it is
  // open (a second window of the kind steps aside from it) and saves its place as it moves and closes.
  const detachedWindows = new Map();
  const detachedPlacesFile = () => path.join(app.getPath('userData'), 'detached-window-state.json');
  const detachedWindowPlace = {
    open(kind, fallback, min) {
      const open = [...(detachedWindows.get(kind) || [])].filter(win => !win.isDestroyed());
      return detachedPlaces.placeFor({
        saved: detachedPlaces.readPlaces(detachedPlacesFile())[kind],
        workAreas: require('electron').screen.getAllDisplays().map(display => display.workArea),
        others: open.map(win => win.getBounds()),
        fallback,
        min
      });
    },
    options(place) {
      return { width: place.width, height: place.height, ...(place.x === undefined ? {} : { x: place.x, y: place.y }) };
    },
    track(win, kind, place, fill, normalBounds = fill?.normalBounds) {
      if (!detachedWindows.has(kind)) detachedWindows.set(kind, new Set());
      detachedWindows.get(kind).add(win);
      win.on('closed', () => detachedWindows.get(kind).delete(win));
      if (place.isMaximized) {
        // A window with acrylic must not be maximized natively: it fills its screen's work area instead
        if (fill) fill.fill(win.getBounds());
        else win.maximize();
      }
      detachedPlaces.trackWindow(win, detachedPlacesFile(), kind, normalBounds
        ? { normalBounds, isMaximized: fill?.isFilled ?? (() => win.isMaximized()) }
        : undefined);
    }
  };

  function createSftpWindow(sessionId, localPath, remotePath, title) {
    const place = detachedWindowPlace.open('sftp', { width: 900, height: 600 }, { width: 600, height: 400 });
    // Acrylic behind this window too when glass is chosen (see glassWindowOptions)
    const glassOptions = glassWindowOptions();
    const sftpWindow = new BrowserWindow({
      icon: WINDOW_ICON,
      ...detachedWindowPlace.options(place),
      minWidth: 600,
      minHeight: 400,
      frame: false,
      backgroundColor: '#1e1e2e',
      ...glassOptions,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, '../preload/index.js')
      }
    });
    registerGlassWindow(sftpWindow, glassOptions);
    detachedWindowPlace.track(sftpWindow, 'sftp', place, glassWindows.get(sftpWindow) || null);

    // Pass session info via query params
    const params = new URLSearchParams({
      sftpMode: 'true',
      sessionId,
      localPath: encodeURIComponent(localPath),
      remotePath: encodeURIComponent(remotePath),
      title: encodeURIComponent(title || '')
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      sftpWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${params.toString()}`)
    } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
      sftpWindow.loadURL(`${DEV_RENDERER_URL}?${params.toString()}`)
    } else {
      sftpWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
        // Same encoding as the dev URL above: the renderer decodes each value once more
        query: {
          sftpMode: 'true',
          sessionId,
          localPath: encodeURIComponent(localPath),
          remotePath: encodeURIComponent(remotePath),
          title: encodeURIComponent(title || '')
        }
      })
    }

    sftpWindows.set(sessionId, sftpWindow);

    sftpWindow.on('closed', () => {
      sftpWindows.delete(sessionId);
      // The docked panel was hidden while this window was open: tell the main window to show it again,
      // in the folders this window was last showing
      const last = sftpWindowPaths.get(sessionId) || {};
      sftpWindowPaths.delete(sessionId);
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('sftp-window-closed', { sessionId, localPath: last.localPath, remotePath: last.remotePath });
      }
    });

    return sftpWindow;
  }

  function createTerminalWindow(sessionId, title) {
    const place = detachedWindowPlace.open('terminal', { width: 800, height: 600 }, { width: 400, height: 300 });
    // Acrylic behind this window too when glass is chosen (see glassWindowOptions)
    const glassOptions = glassWindowOptions();
    const terminalWindow = new BrowserWindow({
      icon: WINDOW_ICON,
      ...detachedWindowPlace.options(place),
      minWidth: 400,
      minHeight: 300,
      frame: false,
      backgroundColor: '#1e1e2e',
      ...glassOptions,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, '../preload/index.js')
      }
    });
    registerGlassWindow(terminalWindow, glassOptions);
    detachedWindowPlace.track(terminalWindow, 'terminal', place, glassWindows.get(terminalWindow) || null);

    const params = new URLSearchParams({
      terminalMode: 'true',
      sessionId,
      title: encodeURIComponent(title || sessionId)
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      terminalWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${params.toString()}`)
    } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
      terminalWindow.loadURL(`${DEV_RENDERER_URL}?${params.toString()}`)
    } else {
      terminalWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
        // Same encoding as the dev URL above: the renderer decodes the title once more
        query: { terminalMode: 'true', sessionId, title: encodeURIComponent(title || sessionId) }
      })
    }

    terminalWindows.set(sessionId, terminalWindow);

    terminalWindow.on('closed', () => {
      terminalWindows.delete(sessionId);
      terminalSnapshots.delete(sessionId);
    });

    return terminalWindow;
  }

  // The MCP activity panel in its own window (one at a time). It shows command output, so it is closed
  // when the app locks and cannot be opened while locked.
  let mcpActivityWindow = null;

  function createMcpActivityWindow() {
    const place = detachedWindowPlace.open('mcpActivity', { width: 960, height: 680 }, { width: 480, height: 320 });
    mcpActivityWindow = new BrowserWindow({
      icon: WINDOW_ICON,
      ...detachedWindowPlace.options(place),
      minWidth: 480,
      minHeight: 320,
      frame: false,
      backgroundColor: '#1e1e2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, '../preload/index.js')
      }
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      mcpActivityWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?mcpActivityMode=true`)
    } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
      mcpActivityWindow.loadURL(`${DEV_RENDERER_URL}?mcpActivityMode=true`)
    } else {
      mcpActivityWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { mcpActivityMode: 'true' } })
    }

    mcpActivityWindow.on('closed', () => {
      mcpActivityWindow = null;
    });
    detachedWindowPlace.track(mcpActivityWindow, 'mcpActivity', place, null);
  }

  ipcMain.handle('open-mcp-activity-window', () => {
    if (ctx.isAppLocked) return { success: false, error: '앱 잠금을 해제하세요.' };
    if (mcpActivityWindow && !mcpActivityWindow.isDestroyed()) {
      if (mcpActivityWindow.isMinimized()) mcpActivityWindow.restore();
      mcpActivityWindow.focus();
      return { success: true, existing: true };
    }
    createMcpActivityWindow();
    return { success: true };
  });

  /** The MCP activity window, if it is open (activity updates are sent to it too) */
  const getMcpActivityWindow = () => mcpActivityWindow;

  function closeMcpActivityWindow() {
    if (mcpActivityWindow && !mcpActivityWindow.isDestroyed()) mcpActivityWindow.close();
  }

  function createRemoteFileWindow(atCursor = false) {
    const min = { width: 520, height: 360 };
    let place = detachedWindowPlace.open('remoteFile', { width: 1000, height: 720 }, min);
    if (atCursor) {
      const { screen } = require('electron');
      const pointer = screen.getCursorScreenPoint();
      const workArea = screen.getDisplayNearestPoint(pointer).workArea;
      const width = Math.max(min.width, Math.min(place.width, workArea.width));
      const height = Math.max(min.height, Math.min(place.height, workArea.height));
      place = {
        width, height, isMaximized: false,
        x: Math.max(workArea.x, Math.min(pointer.x - 40, workArea.x + workArea.width - width)),
        y: Math.max(workArea.y, Math.min(pointer.y - 16, workArea.y + workArea.height - height))
      };
    }
    const win = new BrowserWindow({
      icon: WINDOW_ICON,
      ...detachedWindowPlace.options(place),
      minWidth: 520,
      minHeight: 360,
      show: !atCursor,
      frame: false,
      backgroundColor: '#1e1e2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, '../preload/index.js')
      }
    });
    const query = { remoteFileMode: 'true' };
    detachedWindowPlace.track(win, 'remoteFile', place, null);
    if (process.env.ELECTRON_RENDERER_URL) {
      win.filePageReady = win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query).toString()}`);
    } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
      win.filePageReady = win.loadURL(`${DEV_RENDERER_URL}?${new URLSearchParams(query).toString()}`);
    } else {
      win.filePageReady = win.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
    }
    // The detach request awaits this promise before moving the document.
    win.filePageReady.catch(() => { if (!atCursor && !win.isDestroyed()) win.close(); });
    return win;
  }

  function createDbWindow(dbId) {
    const place = detachedWindowPlace.open('db', { width: 1180, height: 780 }, { width: 640, height: 420 });
    const win = new BrowserWindow({
      icon: WINDOW_ICON,
      ...detachedWindowPlace.options(place),
      minWidth: 640,
      minHeight: 420,
      frame: false,
      backgroundColor: '#1e1e2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, '../preload/index.js')
      }
    });
    const query = { dbMode: 'true', dbId };
    detachedWindowPlace.track(win, 'db', place, null);
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query).toString()}`);
    } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
      win.loadURL(`${DEV_RENDERER_URL}?${new URLSearchParams(query).toString()}`);
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
    }
    return win;
  }

  // An agent answer pinned out of the chat view (src/agentChat/pins.js). A child of the main window:
  // above ezShell, not above other programs, not on the taskbar. Frameless: its header drags it.
  function createPinnedReplyWindow(pinId) {
    const place = detachedWindowPlace.open('pinnedReply', { width: 420, height: 520 }, { width: 260, height: 120 });
    const parent = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : undefined;
    const win = new BrowserWindow({
      icon: WINDOW_ICON,
      ...detachedWindowPlace.options(place),
      minWidth: 260,
      minHeight: 120,
      frame: false,
      parent,
      skipTaskbar: true,
      minimizable: false,
      fullscreenable: false,
      backgroundColor: '#1e1e2e',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, '../preload/index.js')
      }
    });
    const query = { pinnedReplyMode: 'true', pinId };
    win.on('maximize', () => win.webContents.send('pinned-reply-maximized', true));
    win.on('unmaximize', () => win.webContents.send('pinned-reply-maximized', false));
    // A folded window (its header only, src/agentChat/pins.js) is remembered at its unfolded height.
    detachedWindowPlace.track(win, 'pinnedReply', place, null, () => {
      const bounds = win.getNormalBounds();
      return win.pinnedUnfoldedHeight ? { ...bounds, height: win.pinnedUnfoldedHeight } : bounds;
    });
    // The page never navigates away (links go through main)
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query).toString()}`);
    } else if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
      win.loadURL(`${DEV_RENDERER_URL}?${new URLSearchParams(query).toString()}`);
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
    }
    return win;
  }

  // Screen contents of a terminal tab being popped out, kept until its new window picks them up.
  // Memory only: terminal output can contain secrets.
  const terminalSnapshots = new Map();

  // 터미널 창 열기 핸들러
  ipcMain.handle('open-terminal-window', (event, { sessionId, title, snapshot }) => {
    if (typeof snapshot === 'string' && snapshot) terminalSnapshots.set(sessionId, snapshot);
    else terminalSnapshots.delete(sessionId);

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

  // A popped-out terminal window takes the screen contents it should start with (once)
  ipcMain.handle('take-terminal-snapshot', (event, { sessionId }) => {
    const snapshot = terminalSnapshots.get(sessionId) || null;
    terminalSnapshots.delete(sessionId);
    return snapshot;
  });

  // 터미널 창을 메인 창으로 병합
  ipcMain.handle('merge-terminal-to-main', (event, { sessionId, title, host, username, snapshot }) => {
    // 메인 창에 터미널 추가 요청 (화면 내용을 함께 넘겨 이어서 표시)
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      const screen = typeof snapshot === 'string' ? snapshot : undefined;
      ctx.mainWindow.webContents.send('terminal-merge', { sessionId, title, host, username, snapshot: screen });
      ctx.mainWindow.focus();
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
  ipcMain.handle('open-sftp-window', (event, { sessionId, localPath, remotePath, title }) => {
    // Check if window already exists
    if (sftpWindows.has(sessionId)) {
      const existingWindow = sftpWindows.get(sessionId);
      if (!existingWindow.isDestroyed()) {
        existingWindow.focus();
        return { success: true, existing: true };
      }
    }

    createSftpWindow(sessionId, localPath, remotePath, title);
    return { success: true };
  });

  return { sftpWindows, createRemoteFileWindow, createDbWindow, createPinnedReplyWindow, closeMcpActivityWindow, getMcpActivityWindow };
}

module.exports = { registerDetachedWindows };
