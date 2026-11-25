// Record the main window's tabs during use and take the previous run's record once after unlocking.

const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const { saveRestoreTabs, takeRestoreTabs, serializeRestoreTabs, sealRestoreTabsText, sealRestoreTabsTextAsync, writeRestoreTabs } = require('../restoreTabs.js');

const CLOSE_SNAPSHOT_TIMEOUT_MS = 1500;
const CHECKPOINT_DELAY_MS = 1250;
const CLOSE_RECORD = { source: 'close' };

function registerRestoreTabsIpc(ctx, autoUpdater = require('electron').autoUpdater) {
  const { ipcMain, app, fromMainWindow, activeTransferCount, unsavedEditCount } = ctx;
  const filePath = () => path.join(app.getPath('userData'), 'restore-tabs.json');
  const fromMainFrame = event => fromMainWindow(event) && Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame);
  const allowed = event => fromMainFrame(event) && !ctx.isAppLocked && Boolean(ctx.currentMasterPassword);
  let checkedStartup = false;
  let updateSaved = false;
  let installingUpdate = false;
  let pending = null;
  let nextRequestId = 0;
  let writtenKey = '';
  let checkpoint = null;
  let checkpointTimer = null;
  let sealing = false;

  const canCheckpoint = () => checkedStartup && !updateSaved && !installingUpdate;
  function cancelCheckpointTimer() {
    clearTimeout(checkpointTimer);
    checkpointTimer = null;
  }

  function discardCheckpoint() {
    cancelCheckpointTimer();
    checkpoint = null;
  }

  autoUpdater.on('before-quit-for-update', () => {
    installingUpdate = true;
    discardCheckpoint();
  });

  ipcMain.handle('restore-tabs-save', (event, record) => {
    if (!allowed(event)) return { success: false, error: '앱 잠금을 해제하세요.' };
    if (!record || typeof record !== 'object' || Array.isArray(record)) return { success: false, error: '탭 정보가 올바르지 않습니다.' };
    const result = saveRestoreTabs(filePath(), record, ctx.currentMasterPassword);
    if (result.success) {
      updateSaved = true;
      discardCheckpoint();
    }
    return result;
  });

  // A renderer reload may adopt running shells but must never offer this process's own checkpoint.
  // An explicit update snapshot remains available once, including in reload-based update tests.
  ipcMain.handle('restore-tabs-take', (event) => {
    if (!allowed(event) || (checkedStartup && !updateSaved)) return null;
    checkedStartup = true;
    updateSaved = false;
    writtenKey = '';
    return takeRestoreTabs(filePath(), ctx.currentMasterPassword);
  });

  function stageCheckpoint(record) {
    if (!canCheckpoint() || ctx.isAppLocked || !ctx.currentMasterPassword || !Array.isArray(record?.tabs)) return;
    const result = serializeRestoreTabs(record);
    if (!result.success) return;
    const key = record.tabs.length ? createHash('sha256').update(result.text).digest('hex') : '';
    if (key === writtenKey) discardCheckpoint();
    else if (key !== checkpoint?.key) checkpoint = { key, text: result.text };
  }

  // An empty layout removes the record. A disk-write failure keeps the encrypted bytes for retry.
  function cachedSeal(snapshot) {
    const sealed = snapshot.sealed ?? (snapshot.key ? undefined : '');
    return sealed === undefined ? null : { success: true, sealed };
  }

  function commit(snapshot, result) {
    if (!result.success) {
      console.error(result.error);
      return;
    }
    snapshot.sealed = result.sealed;
    delete snapshot.text;
    try {
      if (result.sealed === '') fs.rmSync(filePath(), { force: true });
      else {
        const saved = writeRestoreTabs(filePath(), result.sealed);
        if (!saved.success) {
          console.error(saved.error);
          return;
        }
      }
      writtenKey = snapshot.key;
      checkpoint = null;
    } catch (error) {
      console.error('Failed to save the tab checkpoint:', error);
    }
  }

  function flushCheckpoint() {
    cancelCheckpointTimer();
    const snapshot = checkpoint;
    if (!canCheckpoint() || !snapshot) return;
    const cached = cachedSeal(snapshot);
    if (cached) commit(snapshot, cached);
    else if (!ctx.isAppLocked && ctx.currentMasterPassword) {
      commit(snapshot, sealRestoreTabsText(snapshot.text, ctx.currentMasterPassword, CLOSE_RECORD));
    }
  }

  async function saveInBackground() {
    checkpointTimer = null;
    const snapshot = checkpoint;
    if (!canCheckpoint() || !snapshot || ctx.isAppLocked || !ctx.currentMasterPassword) return;
    sealing = true;
    try {
      const result = cachedSeal(snapshot) ?? await sealRestoreTabsTextAsync(snapshot.text, ctx.currentMasterPassword, CLOSE_RECORD);
      // The layout, lock state or update snapshot may have changed during encryption.
      if (checkpoint === snapshot && canCheckpoint() && !ctx.isAppLocked) commit(snapshot, result);
    } finally {
      sealing = false;
      if (checkpoint !== snapshot) scheduleCheckpoint();
    }
  }

  function scheduleCheckpoint() {
    if (checkpointTimer || sealing || !checkpoint || !canCheckpoint() || ctx.isAppLocked) return;
    checkpointTimer = setTimeout(saveInBackground, CHECKPOINT_DELAY_MS);
    checkpointTimer.unref?.();
  }

  ipcMain.on('restore-tabs-checkpoint', (event, record) => {
    if (!allowed(event)) return;
    stageCheckpoint(record);
    scheduleCheckpoint();
  });

  function rememberBeforeLock(record) {
    if (ctx.isAppLocked) return;
    stageCheckpoint(record);
    flushCheckpoint();
    // Drop unsealed data if encryption failed. The master password is cleared just after this.
    if (checkpoint?.text !== undefined) discardCheckpoint();
  }

  function discardForPasswordReset() {
    discardCheckpoint();
    writtenKey = '';
    updateSaved = false;
    try { fs.rmSync(filePath(), { force: true }); }
    catch (error) { console.error('Failed to discard the tab checkpoint:', error); }
  }

  ipcMain.on('restore-tabs-close-record', (event, { id, record } = {}) => {
    if (!pending || pending.id !== id || event.sender !== pending.sender || !fromMainFrame(event)) return;
    stageCheckpoint(record);
    pending.finish();
  });

  ipcMain.handle('update-busy-work', (event) => {
    if (!fromMainWindow(event)) return { transfers: 0, unsavedEdits: 0 };
    return { transfers: activeTransferCount(), unsavedEdits: unsavedEditCount() };
  });

  function trackClose(win) {
    let resuming = false;
    const capture = (event, quitting) => {
      if (event.defaultPrevented || resuming || updateSaved || installingUpdate || win.isDestroyed()) return;
      if (ctx.isAppLocked || !ctx.currentMasterPassword || win.webContents.isCrashed()) {
        flushCheckpoint();
        return;
      }
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
        flushCheckpoint();
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
    if (process.platform === 'win32') {
      // Windows may skip before-quit and close. The latest main-process checkpoint is already here.
      win.on('query-session-end', flushCheckpoint);
      win.on('session-end', flushCheckpoint);
    }
    win.once('closed', () => app.removeListener('before-quit', onQuit));
  }

  return { trackClose, rememberBeforeLock, discardForPasswordReset };
}

module.exports = { registerRestoreTabsIpc };
