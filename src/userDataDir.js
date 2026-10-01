const path = require('path');

// Electron names the user data folder after package.json "name" (the packaged package.json has no
// productName), so both installed builds and `npm run dev` used %APPDATA%\my-ssh-client. Renaming the
// package to ezshell would silently switch to an empty folder and "lose" saved sessions, the master
// password, settings and the theme, so the old folder keeps winning while it exists.

/** Folder names used before the app was renamed to ezShell */
function legacyDataDirNames() {
  return ['my-ssh-client'];
}

/**
 * @param {{ appDataDir: string, defaultDir: string, legacyNames: string[], exists: (dir: string) => boolean }} options
 * @returns {string} the user data folder to use
 */
function resolveUserDataDir({ appDataDir, defaultDir, legacyNames, exists }) {
  for (const name of legacyNames) {
    const dir = path.join(appDataDir, name);
    if (exists(dir)) return dir;
  }
  return defaultDir;
}

module.exports = { resolveUserDataDir, legacyDataDirNames };
