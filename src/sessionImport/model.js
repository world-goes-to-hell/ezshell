// The common shape every reader of another program's sessions produces, and the limits on it.
// Text from those files is untrusted: control characters go, lengths are capped, hosts have no
// spaces, ports are numbers. Passwords are never read here (phase 1); only whether one was saved.

const { isLocalFilePath } = require('../localKeyPath.js');

const MAX_SESSIONS = 2000;
const MAX_FOLDERS = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_NAME = 100;
const MAX_PATH = 1024;

// Controls, format characters (bidi marks, zero-width), line/paragraph separators and the fillers
// and selectors that draw as nothing: a name with them can pass for another session's name
const CONTROL = new RegExp('[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\u00ad\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180e\\u3164\\ufe00-\\ufe0f\\uffa0]', 'gu');

function cleanText(value, max = MAX_NAME) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').trim().slice(0, max);
}

/**
 * A host name or address as it can be: letters, digits, dots, hyphens, colons and brackets (IPv6),
 * % (zone id). Never a leading "-", which a command line would read as an option.
 */
function cleanHost(value) {
  const host = cleanText(value, 253);
  return /^[\p{L}\p{N}._:\-[\]%]+$/u.test(host) && !host.startsWith('-') ? host : '';
}

/** A user name without spaces, a leading "-", or the characters that split "user@host:port" */
function cleanUser(value) {
  const user = cleanText(value, 64);
  return /[\s@:'"]/.test(user) || user.startsWith('-') ? '' : user;
}

/**
 * A key file on this PC only (src/localKeyPath.js): a network share or device path from someone
 * else's file would be opened at connect time. Relative, "~" and "%VAR%" paths are dropped too.
 */
function cleanKeyPath(value) {
  const text = cleanText(value, MAX_PATH);
  if (!text) return { path: '', dropped: false };
  return isLocalFilePath(text) ? { path: text, dropped: false } : { path: '', dropped: true };
}

function cleanPort(value, fallback = 22) {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

/** A jump host, or null when there is no usable host */
function cleanJump(jump) {
  if (!jump) return null;
  const host = cleanHost(jump.host);
  if (!host) return null;
  return { host, port: cleanPort(jump.port), username: cleanUser(jump.username) };
}

/**
 * Collects folders (by path) and sessions for one source, within the limits. `skip(reason)` counts
 * what was left out (other protocols, sessions without a host, past the limit).
 */
function createCollector(source, label) {
  const folders = [];
  const folderByKey = new Map();
  const sessions = [];
  const skipped = {};
  let truncated = false;

  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

  /** The folder for a path of names (created along the way); null for the top level */
  function folderFor(parts) {
    let parentId = null;
    let key = '';
    for (const raw of parts || []) {
      const name = cleanText(raw);
      if (!name) continue;
      key += `\u0000${name.toLowerCase()}`;
      let id = folderByKey.get(key);
      if (!id) {
        if (folders.length >= MAX_FOLDERS) {
          truncated = true;
          return parentId;
        }
        id = `f${folders.length + 1}`;
        folders.push({ id, name, parentId });
        folderByKey.set(key, id);
      }
      parentId = id;
    }
    return parentId;
  }

  function add(raw) {
    if (sessions.length >= MAX_SESSIONS) {
      truncated = true;
      return false;
    }
    const host = cleanHost(raw.host);
    if (!host) {
      skip('호스트 없음');
      return false;
    }
    const key = cleanKeyPath(raw.privateKeyPath);
    const privateKeyPath = key.path;
    const keyNote = cleanText(raw.keyNote, 200) || (key.dropped ? '키 파일 경로가 이 PC 의 경로가 아니어서 비웠습니다: 키 파일을 직접 골라 주세요' : '');
    const session = {
      id: `s${sessions.length + 1}`,
      name: cleanText(raw.name) || host,
      folderId: raw.folderId ?? null,
      host,
      port: cleanPort(raw.port),
      username: cleanUser(raw.username),
      authType: privateKeyPath || keyNote ? 'privateKey' : 'password',
      privateKeyPath,
      keyNote,
      hasSavedPassword: raw.hasSavedPassword === true ? true : raw.hasSavedPassword === false ? false : null,
      jump: cleanJump(raw.jump)
    };
    sessions.push(session);
    return true;
  }

  return {
    folderFor,
    add,
    skip,
    result: () => ({ source, label, folders, sessions, skipped, truncated })
  };
}

/** A tiny INI reader: sections (case kept) with key=value lines; later keys win */
function parseIni(text) {
  const sections = new Map();
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const at = raw.indexOf('=');
    if (at <= 0 || current === null) continue;
    sections.get(current).set(raw.slice(0, at).trim(), raw.slice(at + 1));
  }
  return sections;
}

/** A value from a section, finding the section and key without regard to case */
function iniGet(sections, section, key) {
  for (const [name, values] of sections) {
    if (name.toLowerCase() !== section.toLowerCase()) continue;
    for (const [k, v] of values) if (k.toLowerCase() === key.toLowerCase()) return v;
  }
  return undefined;
}

module.exports = {
  MAX_SESSIONS, MAX_FOLDERS, MAX_FILE_BYTES,
  cleanText, cleanHost, cleanUser, cleanPort, cleanKeyPath, createCollector, parseIni, iniGet
};
