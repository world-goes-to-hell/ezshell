// Places on this PC for the SFTP panel's local path bar: the usual folders (desktop, documents,
// downloads, ...) and the drives, like the address bar of the Windows file explorer. Takes no input
// from a window: it only lists fixed places. Loaded by main.js at runtime (copied to out/main/src),
// so keep it CommonJS without Electron (main passes app.getPath and the rest in).

const REMEMBER_MS = 30_000
const POWERSHELL_TIMEOUT_MS = 4_000
const MAX_LABEL = 40

const PLACES = [
  ['desktop', '바탕 화면'],
  ['home', '홈 폴더'],
  ['documents', '문서'],
  ['downloads', '다운로드'],
  ['pictures', '사진'],
  ['music', '음악'],
  ['videos', '동영상']
];

// Win32_LogicalDisk.DriveType
const DRIVE_KINDS = {
  2: ['removable', '이동식 디스크'],
  3: ['local', '로컬 디스크'],
  4: ['network', '네트워크 드라이브'],
  5: ['cd', 'CD 드라이브']
};

// UTF-8 output: a Korean volume name ("새 볼륨") would come out in the console code page otherwise
const POWERSHELL_SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType | ConvertTo-Json -Compress';

const oneLine = (text) => String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_LABEL);

/** Drives from the PowerShell JSON (one object or an array); entries that are not a drive letter are dropped */
function parseLogicalDisks(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list
    .filter(disk => disk && typeof disk.DeviceID === 'string' && /^[A-Z]:$/i.test(disk.DeviceID))
    .map(disk => {
      const id = disk.DeviceID.toUpperCase();
      const [kind, kindLabel] = DRIVE_KINDS[disk.DriveType] || ['local', '드라이브'];
      const name = typeof disk.VolumeName === 'string' && disk.VolumeName.trim() ? oneLine(disk.VolumeName) : kindLabel;
      return { path: `${id}\\`, label: `${name} (${id})`, kind };
    });
}

/** The usual folders that exist, in the explorer's order */
async function listPlaces({ getPath, isDirectory }) {
  const found = [];
  for (const [kind, label] of PLACES) {
    let path;
    try {
      path = getPath(kind);
    } catch {
      continue;
    }
    if (typeof path === 'string' && path && await isDirectory(path).catch(() => false)) found.push({ kind, label, path });
  }
  return found;
}

async function windowsDrives({ runPowerShell, isDirectory }) {
  try {
    const drives = parseLogicalDisks(await runPowerShell(POWERSHELL_SCRIPT));
    if (drives.length > 0) return drives;
  } catch {
    // Fall through to the letters
  }
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const open = await Promise.all(letters.map(letter => isDirectory(`${letter}:\\`).catch(() => false)));
  return letters.filter((_, i) => open[i]).map(letter => ({ path: `${letter}:\\`, label: `${letter}:`, kind: 'local' }));
}

async function unixDrives({ readDir, username }) {
  const drives = [{ path: '/', label: '/ (루트)', kind: 'local' }];
  const folders = ['/Volumes', '/mnt', username ? `/media/${username}` : null].filter(Boolean);
  for (const folder of folders) {
    const names = await readDir(folder).catch(() => []);
    for (const name of names) {
      if (typeof name === 'string' && name && !name.startsWith('.')) drives.push({ path: `${folder}/${name}`, label: oneLine(name), kind: 'local' });
    }
  }
  return drives;
}

/**
 * @param {object} deps
 * @param {string} deps.platform process.platform
 * @param {(name: string) => string} deps.getPath app.getPath
 * @param {(path: string) => Promise<boolean>} deps.isDirectory
 * @param {(script: string) => Promise<string>} [deps.runPowerShell] Windows only
 * @param {(dir: string) => Promise<string[]>} [deps.readDir] macOS / Linux only
 * @param {string} [deps.username]
 * @param {() => number} [deps.now]
 */
function createPlacesReader(deps) {
  const now = deps.now || Date.now;
  let remembered = null;
  return {
    async read() {
      if (remembered && now() - remembered.at < REMEMBER_MS) return remembered.value;
      const [places, drives] = await Promise.all([
        listPlaces(deps),
        deps.platform === 'win32' ? windowsDrives(deps) : unixDrives({ readDir: deps.readDir || (async () => []), username: deps.username })
      ]);
      const value = { places, drives };
      remembered = { at: now(), value };
      return value;
    }
  };
}

/** Runs one PowerShell command without a window and returns its output (Windows) */
function powerShellRunner({ execFile, env = process.env }) {
  const exe = `${env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return (script) => new Promise((resolve, reject) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 256 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

module.exports = { parseLogicalDisks, listPlaces, createPlacesReader, powerShellRunner, REMEMBER_MS };
