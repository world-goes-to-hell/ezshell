// Opening the tabs again after an update (docs/plan/2026-11-18-restore-tabs-after-update.md): the
// window hands over its tabs right before the update is installed, and takes them back once after
// the app is unlocked again. Also tells the window what an update would cut off (transfers, unsaved
// edits) before it asks for the install.

const path = require('path');
const { saveRestoreTabs, takeRestoreTabs } = require('../restoreTabs.js');

function registerRestoreTabsIpc(ctx) {
  const { ipcMain, app, fromMainWindow, activeTransferCount, unsavedEditCount } = ctx;
  const filePath = () => path.join(app.getPath('userData'), 'restore-tabs.json');
  const allowed = (event) => fromMainWindow(event) && !ctx.isAppLocked && Boolean(ctx.currentMasterPassword);

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

  ipcMain.handle('update-busy-work', (event) => {
    if (!fromMainWindow(event)) return { transfers: 0, unsavedEdits: 0 };
    return { transfers: activeTransferCount(), unsavedEdits: unsavedEditCount() };
  });
}

module.exports = { registerRestoreTabsIpc };
