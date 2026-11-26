// Updates: electron-updater on Windows, a look at the latest GitHub release on macOS (the build is
// unsigned there, so the app only sends the user to the download page), and the "업데이트 내용" state.
// Moved out of main.js as it was. main.js calls setupAutoUpdater once the main window exists.

const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { createUpdateChecker } = require('../updateChecker.js');
const manualUpdate = require('../manualUpdate.js');
const lastVersion = require('../lastVersion.js');

function registerUpdateIpc(ctx) {
  const { ipcMain, app, shell, fromMainWindow, sessionsFilePath } = ctx;

  const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
  // Coming back to the window checks again, but not more often than this
  const UPDATE_FOCUS_RECHECK_MS = 10 * 60 * 1000;
  const UPDATE_FIRST_CHECK_DELAY_MS = 3000;

  // macOS: the build is unsigned, and Squirrel.Mac only applies an update whose signature matches the
  // running app. So the app does not update itself there: it looks for a newer release and sends the
  // user to its page (src/manualUpdate.js). The page address is kept here, the window never sends one.
  const USES_MANUAL_UPDATE = process.platform === 'darwin';
  let manualUpdateUrl = null;
  // A downloaded update installs when the app quits (autoInstallOnAppQuit, and quitAndInstall below):
  // main.js then clears what would hold the install folder (localShell closeAll, the agent bridge)
  let updateReady = false;

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
    autoUpdater.autoInstallOnAppQuit = true;

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

  ipcMain.handle('install-update', async () => {
    if (USES_MANUAL_UPDATE) return;
    // The session host is told to keep the local shells for the next app before the quit begins
    // (main.js, src/sessionHost/client.js keep). A failure there only means they end, as before.
    try { await ctx.beforeUpdateRestart?.(); } catch { /* install anyway */ }
    // Screen tests only (never a packaged app): the same quit with no installer, so a spec can start the
    // app again on the same profile and see the local shells kept (e2e/specs/local-keep-through-update.js)
    if (ctx.testUpdateRestart) {
      updateReady = true;
      app.quit();
      return;
    }
    // Silent: the installer runs without its pages, into the folder the app is installed in, and starts
    // the app again when it is done
    autoUpdater.quitAndInstall(true, true);
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

  return { setupAutoUpdater, installsUpdateOnQuit: () => updateReady };
}

module.exports = { registerUpdateIpc };
