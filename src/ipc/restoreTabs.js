// The main window hands over its tabs before closing and takes them back once after unlocking.
// The explicit update path saves the tabs before starting the installer.

const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron');
const { saveRestoreTabs, takeRestoreTabs, sealRestoreTabs, writeRestoreTabs } = require('../restoreTabs.js');

const CLOSE_SNAPSHOT_TIMEOUT_MS = 1500;

function registerRestoreTabsIpc(ctx) {
  const { ipcMain, app, fromMainWindow, activeTransferCount, unsavedEditCount } = ctx;
  const filePath = () => path.join(app.getPath('userData'), 'restore-tabs.json');
  const allowed = (event) => fromMainWindow(event) && !ctx.isAppLocked && Boolean(ctx.currentMasterPassword);
  let installingUpdate = false;
  let pending = null;
  let nextRequestId = 0;
  let sealedBeforeLock = null;

  autoUpdater.on('before-quit-for-update', () => { installingUpdate = true; });

  ipcMain.handle('restore-tabs-save', (event, record) => {
    if (!allowed(event)) return { success: false, error: '앱 잠금을 해제하세요.' };
    if (!record || typeof record !== 'object' || Array.isArray(record)) return { success: false, error: '탭 정보가 올바르지 않습니다.' };
    return saveRestoreTabs(filePath(), record, ctx.currentMasterPassword);
  });

  // Once: the file is gone after this, whatever it held (the window checks the record itself)
  ipcMain.handle('restore-tabs-take', (event) => {
    if (!allowed(event)) return null;
    return takeRestoreTabs(filePath(), ctx.currentMasterPassword);
  });

  // The password is dropped on lock. Keep just the encrypted snapshot in memory until exit.
  function rememberBeforeLock(record) {
    if (ctx.isAppLocked) return;
    sealedBeforeLock = null;
    if (!Array.isArray(record?.tabs)) return;
    if (record.tabs.length === 0) {
      sealedBeforeLock = '';
      return;
    }
    const result = sealRestoreTabs(record, ctx.currentMasterPassword, { source: 'close' });
    if (result.success) sealedBeforeLock = result.sealed;
    else console.error(result.error);
  }

  function writeCloseSnapshot(sealed) {
    if (sealed === '') {
      fs.rmSync(filePath(), { force: true });
      return;
    }
    const result = writeRestoreTabs(filePath(), sealed);
    if (!result.success) console.error(result.error);
  }

  function saveLockedSnapshot() {
    if (sealedBeforeLock === null) return;
    try { writeCloseSnapshot(sealedBeforeLock); }
    catch (error) { console.error('Failed to save tabs on close:', error); }
    sealedBeforeLock = null;
  }

  ipcMain.on('restore-tabs-close-record', (event, { id, record } = {}) => {
    if (!pending || pending.id !== id || event.sender !== pending.sender || !fromMainWindow(event)) return;
    try {
      if (!allowed(event) || !Array.isArray(record?.tabs)) return;
      if (record.tabs.length > 0) {
        const result = sealRestoreTabs(record, ctx.currentMasterPassword, { source: 'close' });
        if (result.success) writeCloseSnapshot(result.sealed);
        else console.error(result.error);
      } else {
        writeCloseSnapshot('');
      }
    } catch (error) {
      console.error('Failed to save tabs on close:', error);
    } finally {
      pending.finish();
    }
  });

  ipcMain.handle('update-busy-work', (event) => {
    if (!fromMainWindow(event)) return { transfers: 0, unsavedEdits: 0 };
    return { transfers: activeTransferCount(), unsavedEdits: unsavedEditCount() };
  });

  function trackClose(win) {
    let resuming = false;
    const capture = (event, quitting) => {
      if (event.defaultPrevented || resuming || installingUpdate || win.isDestroyed()) return;
      if (ctx.isAppLocked) {
        saveLockedSnapshot();
        return;
      }
      if (!ctx.currentMasterPassword || win.webContents.isCrashed()) return;
      event.preventDefault();
      if (pending) {
        pending.quitting ||= quitting;
        return;
      }

      const id = ++nextRequestId;
      const finish = () => {
        if (pending?.id !== id) return;
        const { quitting } = pending;
        pending = null;
        clearTimeout(timeout);
        if (win.isDestroyed()) return;
        if (ctx.isAppLocked && !installingUpdate) saveLockedSnapshot();
        resuming = true;
        try {
          if (quitting) app.quit();
          else win.close();
        } finally {
          resuming = false;
        }
      };
      const timeout = setTimeout(finish, CLOSE_SNAPSHOT_TIMEOUT_MS);
      pending = { id, quitting, sender: win.webContents, finish };
      try {
        win.webContents.send('restore-tabs-before-close', id);
      } catch {
        finish();
      }
    };
    const onQuit = (event) => capture(event, true);
    app.on('before-quit', onQuit);
    win.on('close', (event) => capture(event, false));
    win.once('closed', () => app.removeListener('before-quit', onQuit));
  }

  return { trackClose, rememberBeforeLock };
}

module.exports = { registerRestoreTabsIpc };
