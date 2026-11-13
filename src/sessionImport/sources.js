// Where other programs keep their sessions on this PC, and reading a file the user picked.
// The window only names a source from the last listing (by id) or asks main to show a file dialog;
// it never sends a path. Passwords are not read (phase 1).

const fs = require('fs');
const path = require('path');
const { MAX_FILE_BYTES } = require('./model.js');
const xshell = require('./xshell.js');
const putty = require('./putty.js');
const moba = require('./mobaxterm.js');
const tabby = require('./tabby.js');
const sshConfig = require('./sshConfig.js');

const XSHELL_VERSIONS = ['8', '7', '6', '5'];

const isDir = (p) => fs.promises.stat(p).then(s => s.isDirectory(), () => false);
const isFile = (p) => fs.promises.stat(p).then(s => s.isFile(), () => false);

async function readLimited(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('파일이 아닙니다.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다 (5MB 까지).');
  return fs.promises.readFile(file);
}

/**
 * @param {object} deps
 * @param {string} deps.platform
 * @param {(name: string) => string} deps.getPath app.getPath
 * @param {object} deps.env process.env
 * @param {string} deps.home
 * @param {Function} deps.execFile child_process.execFile
 */
function createSessionImport({ platform, getPath, env, home, execFile }) {
  // The sources found by the last listing: id → how to read it
  let found = new Map();

  async function candidates() {
    const list = [];
    const documents = (() => { try { return getPath('documents'); } catch { return path.join(home, 'Documents'); } })();
    for (const version of XSHELL_VERSIONS) {
      const base = path.join(documents, 'NetSarang Computer', version);
      const xs = path.join(base, 'Xshell', 'Sessions');
      if (await isDir(xs)) list.push({ id: `xshell-${version}`, label: `Xshell ${version}`, detail: xs, read: () => xshell.readSessionsFolder(xs, 'xshell', `Xshell ${version}`) });
      const xf = path.join(base, 'Xftp', 'Sessions');
      if (await isDir(xf)) list.push({ id: `xftp-${version}`, label: `Xftp ${version}`, detail: xf, read: () => xshell.readSessionsFolder(xf, 'xftp', `Xftp ${version}`) });
    }
    if (platform === 'win32' && await putty.hasPuttySessions(execFile)) {
      list.push({ id: 'putty', label: 'PuTTY', detail: '레지스트리 (HKCU\\Software\\SimonTatham\\PuTTY\\Sessions)', read: () => putty.readPuttyRegistry(execFile) });
    }
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const mobaFiles = [path.join(appData, 'MobaXterm', 'MobaXterm.ini'), path.join(documents, 'MobaXterm', 'MobaXterm.ini')];
    for (const file of mobaFiles) {
      if (await isFile(file)) {
        list.push({ id: 'mobaxterm', label: 'MobaXterm', detail: file, read: async () => moba.readMobaFile(await readLimited(file)) });
        break;
      }
    }
    const tabbyFiles = platform === 'win32'
      ? [path.join(appData, 'tabby', 'config.yaml')]
      : platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'tabby', 'config.yaml')]
        : [path.join(home, '.config', 'tabby', 'config.yaml')];
    for (const file of tabbyFiles) {
      if (await isFile(file)) list.push({ id: 'tabby', label: 'Tabby', detail: file, read: async () => tabby.readTabbyFile(await readLimited(file)) });
    }
    const config = path.join(home, '.ssh', 'config');
    if (await isFile(config)) list.push({ id: 'ssh-config', label: 'OpenSSH config', detail: config, read: async () => sshConfig.readSshConfigFile(await readLimited(config), { home }) });
    return list;
  }

  return {
    /** Programs found on this PC (id, label, where) */
    async listSources() {
      const list = await candidates();
      found = new Map(list.map(source => [source.id, source]));
      return list.map(({ id, label, detail }) => ({ id, label, detail }));
    },

    /** Reads one source from the last listing; an unknown id is refused */
    async readSource(id) {
      const source = typeof id === 'string' ? found.get(id) : undefined;
      if (!source) throw new Error('목록에 없는 프로그램입니다. 목록을 다시 불러와 주세요.');
      return source.read();
    },

    /** A file the user picked in main's dialog: the kind comes from its name, or its content */
    async readFile(file) {
      const buffer = await readLimited(file);
      const name = path.basename(file).toLowerCase();
      if (name.endsWith('.xts')) return xshell.readXts(buffer);
      if (name.endsWith('.xsh') || name.endsWith('.xfp')) return xshell.readSessionFile(name, buffer);
      if (name.endsWith('.reg')) return putty.readPuttyFile(buffer);
      if (name.endsWith('.mxtsessions')) return moba.readMobaFile(buffer);
      if (name.endsWith('.yaml') || name.endsWith('.yml')) return tabby.readTabbyFile(buffer);
      const head = buffer.subarray(0, 64 * 1024).toString('utf8');
      if (/^\s*\[Bookmarks/im.test(head)) return moba.readMobaFile(buffer);
      if (/^\s*Host\s+\S/im.test(head)) return sshConfig.readSshConfigFile(buffer, { home });
      throw new Error('어느 프로그램의 파일인지 알 수 없습니다.');
    }
  };
}

const FILE_FILTERS = [
  { name: '세션 파일', extensions: ['xsh', 'xts', 'xfp', 'reg', 'mxtsessions', 'ini', 'yaml', 'yml', 'config', 'conf', 'txt'] },
  { name: '모든 파일', extensions: ['*'] }
];

module.exports = { createSessionImport, FILE_FILTERS };
