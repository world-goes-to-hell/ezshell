// SFTP path bookmarks of each saved session, and which saved session a tab belongs to.
// Moved out of main.js as it was.

const path = require('path');

function registerPathBookmarksIpc(ctx) {
  const { ipcMain, BrowserWindow, userDataPath, loadFromFile, saveToFile, connectionStates } = ctx;

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
    const { host, port, username, savedSessionId, sessionName, color } = connState.config;
    return { host, port, username, savedSessionId: savedSessionId || null, sessionName, color };
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
}

module.exports = { registerPathBookmarksIpc };
