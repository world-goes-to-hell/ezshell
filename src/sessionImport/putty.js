// PuTTY sessions: HKCU\Software\SimonTatham\PuTTY\Sessions in the registry, read through `reg export`
// (the same .reg text a user can bring from another PC). Session names are percent-encoded bytes of
// the Windows code page. PuTTY does not store passwords. An SSH proxy (ProxyMethod 6) is a jump host.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCollector, MAX_FILE_BYTES } = require('./model.js');

const SESSIONS_KEY = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions';
const PROXY_SSH = 6;
// reg.exe by its full path: a bare name is looked up in the app's and the current folder first
const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

/** .reg files are UTF-16LE (regedit) or ANSI ("REGEDIT4") */
function decodeRegFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  return require('iconv-lite').decode(buffer, 'cp949');
}

/** "%B1%E2%BA%BB%20%BC%B3%C1%A4" → "기본 설정" (the bytes are the Korean Windows code page) */
function decodeSessionName(encoded) {
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    const hex = encoded[i] === '%' ? encoded.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(encoded[i], 'utf8'));
    }
  }
  return require('iconv-lite').decode(Buffer.from(bytes), 'cp949');
}

/** "value" with \\ and \" escapes, or dword:0000001a, or null for other types */
function regValue(raw) {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
  const dword = /^dword:([0-9a-fA-F]{1,8})$/.exec(text);
  if (dword) return Number.parseInt(dword[1], 16);
  return null;
}

/** Sessions of a .reg export: name → values */
function parseReg(text) {
  const sessions = new Map();
  let current = null;
  const prefix = `[${SESSIONS_KEY}\\`.toLowerCase();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      current = null;
      if (trimmed.toLowerCase().startsWith(prefix) && trimmed.endsWith(']')) {
        const encoded = trimmed.slice(prefix.length, -1);
        // Sub-keys of a session (none in PuTTY) are not sessions
        if (encoded && !encoded.includes('\\')) {
          current = new Map();
          sessions.set(decodeSessionName(encoded), current);
        }
      }
      continue;
    }
    const match = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(trimmed);
    if (match && current) {
      const value = regValue(match[2]);
      if (value !== null) current.set(match[1].toLowerCase(), value);
    }
  }
  return sessions;
}

function readPuttyText(text) {
  const collector = createCollector('putty', 'PuTTY');
  for (const [name, values] of parseReg(text)) {
    if (name === 'Default Settings') continue;
    const protocol = String(values.get('protocol') ?? 'ssh').toLowerCase();
    if (protocol !== 'ssh') {
      collector.skip(`${protocol} 세션`);
      continue;
    }
    let host = String(values.get('hostname') ?? '');
    let username = String(values.get('username') ?? '');
    // "user@host" in the host box
    const at = host.lastIndexOf('@');
    if (at > 0) {
      if (!username) username = host.slice(0, at);
      host = host.slice(at + 1);
    }
    const proxy = values.get('proxymethod') === PROXY_SSH
      ? { host: values.get('proxyhost'), port: values.get('proxyport'), username: values.get('proxyusername') }
      : null;
    collector.add({
      name,
      host,
      port: values.get('portnumber'),
      username,
      privateKeyPath: String(values.get('publickeyfile') ?? ''),
      hasSavedPassword: false,
      jump: proxy
    });
  }
  return collector.result();
}

function readPuttyFile(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다.');
  return readPuttyText(decodeRegFile(buffer));
}

/** Whether this PC has PuTTY sessions (Windows) */
function hasPuttySessions(execFile) {
  return new Promise(resolve => {
    execFile(REG_EXE, ['query', SESSIONS_KEY], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(!err && /\\Sessions\\/i.test(String(stdout))));
  });
}

/** This PC's PuTTY sessions, through `reg export` into a temporary file that is removed again */
async function readPuttyRegistry(execFile) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ezshell-putty-'));
  const file = path.join(dir, 'sessions.reg');
  try {
    await new Promise((resolve, reject) => {
      execFile(REG_EXE, ['export', SESSIONS_KEY, file, '/y'], { windowsHide: true, timeout: 10000 }, (err) => (err ? reject(new Error('PuTTY 세션을 읽지 못했습니다.')) : resolve()));
    });
    return readPuttyFile(await fs.promises.readFile(file));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { decodeSessionName, parseReg, readPuttyText, readPuttyFile, hasPuttySessions, readPuttyRegistry };
