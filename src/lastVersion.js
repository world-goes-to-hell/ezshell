// The last version whose release notes the user has seen, kept in userData/last-version.json, so the
// first start after an update can show "업데이트 내용" once. Loaded by main.js at runtime (copied to
// out/main/src), so keep it CommonJS without Electron.

const fs = require('fs');

const VERSION = /^\d+\.\d+\.\d+$/;

/** The recorded version, or null when the file is missing, broken or holds something else */
function readLastVersion(file) {
  try {
    const { version } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

function writeLastVersion(file, version) {
  if (!VERSION.test(version)) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ version }));
  } catch {
    // Not fatal: the notes show again on the next start
  }
}

/**
 * What the window needs to decide which notes to show. A fresh install (no record, no saved data)
 * records the current version right away so nothing is shown; anyone else keeps the old record until
 * the notes are confirmed (`writeLastVersion`), so a crash before reading shows them again.
 */
function resolveWhatsNew({ file, current, existingUser }) {
  const previous = readLastVersion(file);
  if (previous === null && !existingUser) {
    writeLastVersion(file, current);
    return { previous: current, current, existingUser };
  }
  return { previous, current, existingUser };
}

module.exports = { readLastVersion, writeLastVersion, resolveWhatsNew };
