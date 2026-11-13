// Private key files are read from this PC only. A path from an imported session file (or typed
// anywhere) could name a network share ("\host\share\id": Windows sends the user's NTLM credentials
// to that host when it is opened) or a device ("\.\pipe\x", a read that never ends). Only plain
// absolute paths on a local drive or the filesystem root pass. Loaded by main.js at runtime (copied
// to out/main/src), so keep it CommonJS without Electron.

const fs = require('fs');

const CONTROL = /[\u0000-\u001f\u007f]/;

/** "C:\...", "D:/..." or "/..." (not "//"); no UNC, device, URL, relative, "~" or "%VAR%" path */
function isLocalFilePath(value) {
  if (typeof value !== 'string' || !value || CONTROL.test(value)) return false;
  if (/^[\\/]{2}/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
  if (value.includes('%')) return false;
  return /^[A-Za-z]:[\\/]/.test(value) || /^\/(?!\/)/.test(value);
}

/** The key file's bytes; throws without opening anything for a path that is not on this PC */
function readPrivateKeyFile(value, readFile = fs.readFileSync) {
  if (!isLocalFilePath(value)) throw new Error('이 PC 의 키 파일만 쓸 수 있습니다 (네트워크·장치 경로는 읽지 않습니다). 세션 편집에서 키 파일을 다시 골라 주세요.');
  return readFile(value);
}

module.exports = { isLocalFilePath, readPrivateKeyFile };
