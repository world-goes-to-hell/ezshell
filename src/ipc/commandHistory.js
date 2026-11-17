// Terminal command history: kept per connection, encrypted with the master password like sessions.
// Moved out of main.js as it was. main.js flushes before it locks or quits, forgets the decrypted
// copy when it locks, and discards everything when the master password is reset.

const fs = require('fs');
const path = require('path');
const cryptoUtil = require('../crypto.js');
const commandHistory = require('../commandHistory.js');

function registerCommandHistoryIpc(ctx) {
  const { ipcMain, BrowserWindow, userDataPath } = ctx;

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
    return !ctx.isAppLocked && Boolean(ctx.currentMasterPassword);
  }

  function loadCommandHistory() {
    if (commandHistoryCache) return commandHistoryCache;
    if (!fs.existsSync(commandHistoryFilePath)) {
      commandHistoryCache = {};
      return commandHistoryCache;
    }
    try {
      const file = JSON.parse(fs.readFileSync(commandHistoryFilePath, 'utf8'));
      const plain = cryptoUtil.decrypt(file.encrypted, ctx.currentMasterPassword);
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
    if (!commandHistoryCache || !ctx.currentMasterPassword) return;
    commandHistoryGeneration++;
    try {
      writeCommandHistoryFile(cryptoUtil.encrypt(JSON.stringify(commandHistoryCache), ctx.currentMasterPassword));
    } catch (err) {
      console.error('Failed to save command history:', err.message);
    }
  }

  async function saveCommandHistoryInBackground() {
    commandHistorySaveTimer = null;
    if (!commandHistoryCache || !ctx.currentMasterPassword) return;
    const generation = ++commandHistoryGeneration;
    try {
      const encrypted = await cryptoUtil.encryptAsync(JSON.stringify(commandHistoryCache), ctx.currentMasterPassword);
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

  /** The app locks: the decrypted copy goes (pending changes were flushed first) */
  function forgetCommandHistory() {
    commandHistoryCache = null;
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

  return { flushCommandHistory, discardCommandHistory, forgetCommandHistory };
}

module.exports = { registerCommandHistoryIpc };
