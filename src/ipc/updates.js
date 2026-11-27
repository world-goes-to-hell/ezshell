// Updates: electron-updater on Windows, a look at the latest GitHub release on macOS (the build is
// unsigned there, so the app only sends the user to the download page), and the "업데이트 내용" state.
// Moved out of main.js as it was. main.js calls setupAutoUpdater once the main window exists.

const fs = require('fs');
const path = require('path');
const { createUpdateChecker } = require('../updateChecker.js');
const manualUpdate = require('../manualUpdate.js');
const lastVersion = require('../lastVersion.js');

function registerUpdateIpc(ctx, autoUpdater = require('electron-updater').autoUpdater) {
  const { ipcMain, app, dialog, shell, fromMainWindow, sessionsFilePath } = ctx;

  const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
  // Coming back to the window checks again, but not more often than this
  const UPDATE_FOCUS_RECHECK_MS = 10 * 60 * 1000;
  const UPDATE_FIRST_CHECK_DELAY_MS = 3000;

  // macOS: the build is unsigned, and Squirrel.Mac only applies an update whose signature matches the
  // running app. So the app does not update itself there: it looks for a newer release and sends the
  // user to its page (src/manualUpdate.js). The page address is kept here, the window never sends one.
  const USES_MANUAL_UPDATE = process.platform === 'darwin';
  let manualUpdateUrl = null;
  let updateReady = false;
  let restartRequested = false;
  let installingOnQuit = false;
  let installerError = null;
  // If a window vetoed an explicit restart, closing the last window later is an ordinary quit.
  app.on('window-all-closed', () => {
    if (!installingOnQuit) restartRequested = false;
  });

  async function checkManualUpdate() {
    const result = await manualUpdate.checkLatest({ currentVersion: app.getVersion() });
    manualUpdateUrl = result.status === 'available' ? result.url : null;
    if (result.status === 'available') sendUpdateStatus('available', { version: result.version, manual: true });
    return result;
  }

  function setupManualUpdater() {
    const updateChecker = createUpdateChecker({ check: checkManualUpdate, focusGapMs: UPDATE_FOCUS_RECHECK_MS });
    setTimeout(() => { void updateChecker.run(); }, UPDATE_FIRST_CHECK_DELAY_MS);
    setInterval(() => { void updateChecker.run(); }, UPDATE_CHECK_INTERVAL_MS);
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.on('focus', () => { void updateChecker.onFocus(); });
    }
  }

  function setupAutoUpdater() {
    if (USES_MANUAL_UPDATE) {
      setupManualUpdater();
      return;
    }
    autoUpdater.autoDownload = false;
    // Own the quit sequence so the install starts only after the application's shutdown work.
    autoUpdater.autoInstallOnAppQuit = false;

    // A running app used to check only at start, so a release made while it ran went unnoticed
    const updateChecker = createUpdateChecker({
      check: () => autoUpdater.checkForUpdates(),
      focusGapMs: UPDATE_FOCUS_RECHECK_MS
    });

    // Background checks show nothing unless an update is found; a manual check (footer) still shows all
    autoUpdater.on('checking-for-update', () => {
      if (!updateChecker.isQuiet()) sendUpdateStatus('checking');
    });

    autoUpdater.on('update-available', (info) => {
      updateChecker.setStage('available');
      sendUpdateStatus('available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      });
    });

    autoUpdater.on('update-not-available', () => {
      if (!updateChecker.isQuiet()) sendUpdateStatus('not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      updateChecker.setStage('downloading');
      sendUpdateStatus('downloading', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      updateReady = true;
      updateChecker.setStage('downloaded');
      sendUpdateStatus('downloaded', {
        version: info.version
      });
    });

    autoUpdater.on('error', (err) => {
      if (installingOnQuit) {
        installerError = err;
        return;
      }
      // A failed download lets the checks start again
      updateChecker.setStage('idle');
      if (!updateChecker.isQuiet()) sendUpdateStatus('error', { message: err.message });
    });

    setTimeout(() => { void updateChecker.run(); }, UPDATE_FIRST_CHECK_DELAY_MS);
    setInterval(() => { void updateChecker.run(); }, UPDATE_CHECK_INTERVAL_MS);
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.on('focus', () => { void updateChecker.onFocus(); });
    }
  }

  function sendUpdateStatus(status, data = {}) {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('update-status', { status, ...data });
    }
  }

  async function installAfterShutdown() {
    let keepShells = false;
    if (restartRequested) {
      try { keepShells = await ctx.keepSessionsForUpdate() === true; } catch { /* The normal cleanup ends the shells. */ }
    }
    let started = false;
    try {
      ctx.finishSessionQuit({ updating: true, keepShells });
      // install() uses the downloaded update and the same silent/elevation path as quitAndInstall().
      // In a screen test the same shutdown runs without executing an installer.
      installerError = null;
      started = ctx.testUpdateRestart || autoUpdater.install(true, restartRequested);
    } catch (error) {
      installerError = error;
    } finally {
      // Let the updater's spawn-error handler try elevation before exiting. The windows and all
      // will-quit handlers have already run, so exit does not repeat their cleanup or the handoff.
      setImmediate(() => {
        const succeeded = started && !installerError;
        if (!succeeded) {
          if (installerError) console.error('[Update] Could not launch the installer:', installerError.message);
          dialog.showErrorBox('ezShell 업데이트', '설치 프로그램을 시작하지 못했습니다. ezShell을 다시 열고 업데이트를 다시 시도해 주세요.');
        }
        app.exit(succeeded ? 0 : 1);
      });
    }
  }

  function finishQuit(event) {
    if (!updateReady) {
      ctx.finishSessionQuit({ updating: false, keepShells: false });
      return;
    }
    event.preventDefault();
    if (installingOnQuit) return;
    installingOnQuit = true;
    // Other synchronous will-quit listeners also get to finish before the installer starts.
    setImmediate(() => { void installAfterShutdown(); });
  }


  // ==================== 자동 업데이트 API ====================

  // Returns the outcome itself, not only through 'update-status' events: electron-updater sends no
  // event at all when it skips the check (unpackaged dev app), so the renderer would wait forever.
  ipcMain.handle('check-for-updates', async () => {
    // Screen tests only (never a packaged app): an update that is "downloaded" at once, so a spec presses the
    // notice's 재시작 like a user and goes through lib/updateInstall.ts (tabs written down, layout kept)
    if (ctx.testUpdateRestart) {
      updateReady = true;
      sendUpdateStatus('downloaded', { version: '99.0.0' });
      return { success: true, status: 'available', version: '99.0.0' };
    }
    try {
      if (USES_MANUAL_UPDATE) {
        if (!app.isPackaged) return { success: true, status: 'unsupported' };
        const latest = await checkManualUpdate();
        return { success: true, status: latest.status, version: latest.version };
      }
      const result = await autoUpdater.checkForUpdates();
      if (!result) return { success: true, status: 'unsupported' };
      return {
        success: true,
        status: result.isUpdateAvailable ? 'available' : 'not-available',
        version: result.updateInfo?.version
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('download-update', async () => {
    if (USES_MANUAL_UPDATE) return { success: false, error: '이 빌드는 자동으로 업데이트할 수 없습니다' };
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('install-update', (event) => {
    if (USES_MANUAL_UPDATE) return;
    if (!fromMainWindow(event) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !updateReady) {
      throw new Error('업데이트 설치를 시작할 수 없습니다.');
    }
    if (installingOnQuit) return;
    restartRequested = true;
    // A window can still veto the quit. Keep the shells and start the installer only after it commits.
    app.quit();
  });

  // Open a known release page on macOS, or the project's downloads after an automatic download failed.
  // The window does not supply an address.
  ipcMain.handle('open-update-page', async (event) => {
    if (!fromMainWindow(event)) return { success: false };
    await shell.openExternal(manualUpdateUrl || manualUpdate.releasePageUrl());
    return { success: true };
  });

  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // "업데이트 내용" after an update: the window compares the last version whose notes were seen with
  // this one (src/lastVersion.js). Saved data means an existing user even without a record.
  const lastVersionPath = () => path.join(app.getPath('userData'), 'last-version.json');
  const whatsNewState = () => lastVersion.resolveWhatsNew({
    file: lastVersionPath(),
    current: app.getVersion(),
    existingUser: fs.existsSync(sessionsFilePath) || fs.existsSync(path.join(app.getPath('userData'), 'master.json'))
  });
  // A fresh install is decided now, at startup. The window asks only after the first unlock, and by
  // then the master password file exists, so a new user looked like an existing one and got the notes.
  whatsNewState();
  ipcMain.handle('whats-new-state', whatsNewState);
  ipcMain.handle('whats-new-seen', () => {
    lastVersion.writeLastVersion(lastVersionPath(), app.getVersion());
  });

  return { setupAutoUpdater, finishQuit, isInstallingOnQuit: () => installingOnQuit };
}

module.exports = { registerUpdateIpc };
