// Downloading a whole remote folder: walks it over SFTP, makes the same folders on this PC and hands
// every file to the transfer queue (the counterpart of 'sftp-upload-directory' in main.js).
//
// The names come from the server, and they become paths on this PC. A name is used only when it is a
// plain file name: nothing that could step out of the target folder or mean something else to Windows.

const path = require('path');

/** A folder tree larger or deeper than this is refused rather than half-downloaded forever */
const MAX_FILES = 20000;
const MAX_DEPTH = 40;

/** Windows device names: opening "NUL" or "COM1.txt" does not open a file of that name */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Whether a name sent by the server can be used as a file or folder name under the target folder.
 * @param {string} name
 * @param {string} platform process.platform
 */
function isSafeEntryName(name, platform) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  // Separators and control characters (a NUL ends the path for the system call)
  if (/[/\\\u0000-\u001f]/.test(name)) return false;
  if (platform === 'win32') {
    // ':' addresses a drive or an alternate data stream; the rest cannot be in a Windows file name
    if (/[:*?"<>|]/.test(name)) return false;
    // Windows drops trailing dots and spaces: "x." would be written as "x"
    if (/[. ]$/.test(name)) return false;
    if (WINDOWS_DEVICE_NAME.test(name)) return false;
  }
  return true;
}

const joinRemote = (dir, name) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`);

/**
 * @param {object} deps
 * @param {(remoteDir: string) => Promise<Array<{ filename: string, attrs: { isDirectory(): boolean, isFile(): boolean, isSymbolicLink(): boolean } }>>} deps.readdir
 * @param {(localDir: string) => Promise<void>} deps.mkdir creates the folder (and its parents); existing is fine
 * @param {(transfer: { remotePath: string, localPath: string }) => void} deps.queueDownload
 * @param {string} deps.platform
 * @param {string} remoteDir
 * @param {string} localDir
 * @returns {Promise<{ files: number, folders: number, skipped: string[] }>} skipped: remote paths left out
 *   (links, special files, names this PC cannot take)
 */
async function downloadDirectory(deps, remoteDir, localDir) {
  const result = { files: 0, folders: 0, skipped: [] };

  const walk = async (remotePath, localPath, depth) => {
    if (depth > MAX_DEPTH) throw new Error('폴더가 너무 깊습니다 (40단계 초과).');
    await deps.mkdir(localPath);
    result.folders += 1;
    for (const entry of await deps.readdir(remotePath)) {
      const name = entry.filename;
      if (name === '.' || name === '..') continue;
      const remoteEntry = joinRemote(remotePath, String(name));
      if (!isSafeEntryName(name, deps.platform)) {
        result.skipped.push(remoteEntry);
        continue;
      }
      // Links are not followed: one that points back up would never end, and one that points outside
      // would download something the user did not pick
      if (entry.attrs.isSymbolicLink()) {
        result.skipped.push(remoteEntry);
      } else if (entry.attrs.isDirectory()) {
        await walk(remoteEntry, path.join(localPath, name), depth + 1);
      } else if (entry.attrs.isFile()) {
        if (result.files >= MAX_FILES) throw new Error(`파일이 너무 많습니다 (${MAX_FILES.toLocaleString()}개 초과).`);
        deps.queueDownload({ remotePath: remoteEntry, localPath: path.join(localPath, name) });
        result.files += 1;
      } else {
        // Sockets, devices, pipes
        result.skipped.push(remoteEntry);
      }
    }
  };

  await walk(remoteDir, localDir, 0);
  return result;
}

module.exports = { downloadDirectory, isSafeEntryName, MAX_FILES, MAX_DEPTH };
