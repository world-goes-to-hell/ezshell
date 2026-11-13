// Xshell (.xsh) and Xftp (.xfp) session files: UTF-16LE INI files, one per session, in folders that
// are the session folders. An Xshell export (.xts) is a zip of the same files. Passwords are not
// read (phase 1): only whether one was saved. `UserKey` names a key in Xshell's own key store, not a
// file, so such sessions are marked as key sessions whose key file has to be picked again.

const fs = require('fs');
const path = require('path');
const { createCollector, parseIni, iniGet, cleanText, MAX_FILE_BYTES } = require('./model.js');

const MAX_FILES = 3000;
const MAX_DEPTH = 12;
const MAX_ZIP_TOTAL = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;

/** Xshell writes UTF-16LE with a BOM; tolerate UTF-8 too */
function decodeSessionFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  // UTF-16LE without a BOM: every other byte of ASCII text is zero
  if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

/** One Xshell session's fields, or a reason it is left out */
function readXsh(text) {
  const ini = parseIni(text);
  const protocol = String(iniGet(ini, 'CONNECTION', 'Protocol') ?? 'SSH').trim().toUpperCase();
  if (protocol !== 'SSH' && protocol !== 'SFTP') return { skip: `${protocol || '알 수 없는'} 세션` };
  const userKey = cleanText(iniGet(ini, 'CONNECTION:AUTHENTICATION', 'UserKey') ?? '');
  const password = iniGet(ini, 'CONNECTION:AUTHENTICATION', 'Password') ?? '';
  return {
    host: iniGet(ini, 'CONNECTION', 'Host'),
    port: iniGet(ini, 'CONNECTION', 'Port'),
    username: iniGet(ini, 'CONNECTION:AUTHENTICATION', 'UserName'),
    keyNote: userKey ? `Xshell 키 저장소의 키 "${userKey}": 키 파일을 직접 골라 주세요` : '',
    hasSavedPassword: String(password).trim() !== ''
  };
}

/**
 * Xftp's session file. Without samples of every version, only sessions that look like SFTP are
 * taken: a protocol naming SFTP, or port 22.
 */
function readXfp(text) {
  const ini = parseIni(text);
  let found = null;
  for (const [, values] of ini) {
    const get = (key) => { for (const [k, v] of values) if (k.toLowerCase() === key) return v; return undefined; };
    if (get('host') !== undefined) {
      found = get;
      break;
    }
  }
  if (!found) return { skip: '형식을 알 수 없는 Xftp 세션' };
  const protocol = String(found('protocol') ?? '').toUpperCase();
  const port = Number.parseInt(String(found('port') ?? ''), 10);
  if (!protocol.includes('SFTP') && port !== 22) return { skip: 'FTP 세션' };
  return {
    host: found('host'),
    port: found('port'),
    username: found('username') ?? found('user'),
    hasSavedPassword: String(found('password') ?? '').trim() !== ''
  };
}

/** Adds one session file (relative path inside the sessions folder or zip) */
function addFile(collector, relativePath, buffer) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const fileName = parts.pop() || '';
  const ext = path.extname(fileName).toLowerCase();
  const fields = ext === '.xfp' ? readXfp(decodeSessionFile(buffer)) : readXsh(decodeSessionFile(buffer));
  if (fields.skip) {
    collector.skip(fields.skip);
    return;
  }
  collector.add({ ...fields, name: fileName.slice(0, -ext.length), folderId: collector.folderFor(parts) });
}

/** Every .xsh/.xfp under a sessions folder (links are not followed) */
async function readSessionsFolder(root, source = 'xshell', label = 'Xshell') {
  const collector = createCollector(source, label);
  let files = 0;
  // One limit for the whole walk (not per folder)
  let stop = false;
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || stop) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (stop) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && /\.(xsh|xfp)$/i.test(entry.name)) {
        if (++files > MAX_FILES) {
          stop = true;
          return;
        }
        const stat = await fs.promises.stat(full).catch(() => null);
        if (!stat || stat.size > MAX_ENTRY_BYTES) {
          collector.skip('너무 큰 파일');
          continue;
        }
        addFile(collector, path.relative(root, full), await fs.promises.readFile(full));
      }
    }
  }
  await walk(root, 0);
  return collector.result();
}

/** A single .xsh / .xfp file chosen by the user */
function readSessionFile(fileName, buffer) {
  const collector = createCollector(/\.xfp$/i.test(fileName) ? 'xftp' : 'xshell', /\.xfp$/i.test(fileName) ? 'Xftp' : 'Xshell');
  addFile(collector, path.basename(fileName), buffer);
  return collector.result();
}

/** A zip entry's name: UTF-8 when the entry says so, otherwise the Korean Windows code page */
function entryName(entry) {
  const raw = Buffer.isBuffer(entry.fileName) ? entry.fileName : Buffer.from(String(entry.fileName));
  // eslint-disable-next-line no-bitwise
  if (entry.generalPurposeBitFlag & 0x800) return raw.toString('utf8');
  return require('iconv-lite').decode(raw, 'cp949');
}

/**
 * An Xshell export (.xts, a zip). Entries are read only when they are session files with a plain
 * relative path; sizes are checked from the headers and again while reading (a lying header).
 */
function readXts(buffer, yauzl = require('yauzl')) {
  if (buffer.length > MAX_FILE_BYTES) return Promise.reject(new Error('파일이 너무 큽니다.'));
  return new Promise((resolve, reject) => {
    // Names are decoded here (not by yauzl, which fails the whole file on one bad name): an entry
    // whose path climbs out is skipped instead
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(new Error('Xshell 내보내기 파일을 열 수 없습니다.'));
      const collector = createCollector('xshell', 'Xshell');
      let count = 0;
      let total = 0;
      const finish = (error) => {
        zip.close();
        if (error) reject(error);
        else resolve(collector.result());
      };
      zip.on('error', () => finish(new Error('Xshell 내보내기 파일을 읽지 못했습니다.')));
      zip.on('end', () => finish());
      zip.on('entry', (entry) => {
        const name = entryName(entry);
        const unsafe = name.split(/[\\/]/).some(part => part === '..') || path.isAbsolute(name) || /^[A-Za-z]:/.test(name);
        if (unsafe || !/\.(xsh|xfp)$/i.test(name)) return zip.readEntry();
        if (++count > MAX_FILES) return finish();
        if (entry.uncompressedSize > MAX_ENTRY_BYTES || total + entry.uncompressedSize > MAX_ZIP_TOTAL) {
          collector.skip('너무 큰 파일');
          return zip.readEntry();
        }
        zip.openReadStream(entry, (openErr, stream) => {
          if (openErr) {
            collector.skip('읽지 못한 파일');
            return zip.readEntry();
          }
          const chunks = [];
          let size = 0;
          stream.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_ENTRY_BYTES) stream.destroy(new Error('too big'));
            else chunks.push(chunk);
          });
          stream.on('error', () => {
            collector.skip('읽지 못한 파일');
            zip.readEntry();
          });
          stream.on('end', () => {
            total += size;
            // Exported paths start with the export's top folder ("Sessions/개발/a.xsh")
            const relative = name.replace(/^(?:[^/\\]*[/\\])?Sessions[/\\]/i, '');
            addFile(collector, relative, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { decodeSessionFile, readXsh, readXfp, readSessionsFolder, readSessionFile, readXts };
