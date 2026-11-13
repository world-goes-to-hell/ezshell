// MobaXterm sessions: an export (.mxtsessions) or MobaXterm.ini, INI text in the Windows code page.
// [Bookmarks] / [Bookmarks_N] sections hold one folder each (SubRep, "A\B" for nested folders) and
// one session per line: name=#<icon>#<type>%<host>%<port>%<user>%... (type 0 is SSH). Field
// positions follow a community description of the format (no official one exists):
// https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea
// 1 host, 2 port, 3 user, 8/9/10 gateway hosts/ports/users ("__PIPE__" between hops), 14 key file
// ("_CurrentDrive_" for C:), 19 proxy type (6 = SSH), 20-22 proxy host/port/user.
// Passwords are kept elsewhere, encrypted; they are not read.

const { createCollector, MAX_FILE_BYTES } = require('./model.js');

const SSH_TYPE = '0';
const PIPE = '__PIPE__';

function decodeMobaFile(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Not UTF-8: the ANSI code page MobaXterm writes (Korean Windows here)
    return require('iconv-lite').decode(buffer, 'cp949');
  }
}

const firstHop = (value) => String(value ?? '').split(PIPE)[0];
// "_CurrentDrive_" stands for the C drive, written with or without its colon
const keyPath = (value) => String(value ?? '').replace(/^_CurrentDrive_:?/, 'C:');

/** The fields of one session line, or a reason it is left out */
function readSessionValue(value) {
  const match = /^\s*(?:;\s*logout\s*)?#(\d+)#([^#]*)/.exec(String(value));
  if (!match) return { skip: '형식을 알 수 없는 세션' };
  const fields = match[2].split('%');
  if (fields[0] !== SSH_TYPE) return { skip: 'SSH 가 아닌 세션' };
  const user = fields[3] === '<default>' ? '' : fields[3];
  const gateway = firstHop(fields[8]) ? { host: firstHop(fields[8]), port: firstHop(fields[9]), username: firstHop(fields[10]) } : null;
  const proxy = fields[19] === '6' && fields[20] ? { host: fields[20], port: fields[21], username: fields[22] } : null;
  return {
    host: fields[1],
    port: fields[2],
    username: user,
    privateKeyPath: keyPath(fields[14]),
    jump: gateway || proxy
  };
}

function readMobaText(text) {
  const collector = createCollector('mobaxterm', 'MobaXterm');
  let section = null;
  let folderId = null;
  const isBookmarks = (name) => /^bookmarks(_\d+)?$/i.test(name);
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      section = header[1];
      folderId = null;
      continue;
    }
    if (!section || !isBookmarks(section)) continue;
    const at = raw.indexOf('=');
    if (at <= 0) continue;
    const key = raw.slice(0, at).trim();
    const value = raw.slice(at + 1);
    if (key === 'SubRep') {
      // The root section of a full export is "User sessions" (or empty): no folder of its own
      const parts = value.trim() === 'User sessions' ? [] : value.split('\\');
      folderId = collector.folderFor(parts);
      continue;
    }
    if (key === 'ImgNum') continue;
    const fields = readSessionValue(value);
    if (fields.skip) {
      collector.skip(fields.skip);
      continue;
    }
    collector.add({ ...fields, name: key, folderId });
  }
  return collector.result();
}

function readMobaFile(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다.');
  return readMobaText(decodeMobaFile(buffer));
}

module.exports = { readSessionValue, readMobaText, readMobaFile };
