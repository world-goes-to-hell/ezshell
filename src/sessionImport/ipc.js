// IPC for importing other programs' sessions. Main window only. The window sends a source id from
// the listing, or asks main to show the file dialog; no path comes from the window.

const { createSessionImport, FILE_FILTERS } = require('./sources.js');

/**
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').Dialog} deps.dialog
 * @param {(event: object) => boolean} deps.fromMainWindow
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWindow
 * @param {object} deps.importer createSessionImport(...) result (tests pass a fake)
 */
function registerSessionImportIpc({ ipcMain, dialog, fromMainWindow, getMainWindow, importer }) {
  const refuse = () => ({ ok: false, error: '본창에서만 쓸 수 있습니다.' });
  const answer = async (work) => {
    try {
      return { ok: true, ...(await work()) };
    } catch (err) {
      return { ok: false, error: err && err.message ? String(err.message).slice(0, 200) : '읽지 못했습니다.' };
    }
  };

  ipcMain.handle('session-import-sources', (event) => (fromMainWindow(event) ? answer(async () => ({ sources: await importer.listSources() })) : refuse()));
  ipcMain.handle('session-import-read', (event, id) => (fromMainWindow(event) ? answer(async () => ({ result: await importer.readSource(id) })) : refuse()));
  ipcMain.handle('session-import-file', async (event) => {
    if (!fromMainWindow(event)) return refuse();
    const window = getMainWindow();
    const picked = await dialog.showOpenDialog(window, { title: '다른 프로그램의 세션 파일', properties: ['openFile'], filters: FILE_FILTERS });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, canceled: true };
    return answer(async () => ({ result: await importer.readFile(picked.filePaths[0]) }));
  });
}

module.exports = { registerSessionImportIpc, createSessionImport };
