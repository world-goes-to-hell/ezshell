// FileZilla's Site Manager: sitemanager.xml (%APPDATA%\FileZilla, ~/.config/filezilla) or a file
// exported from it (File > Export), both <FileZilla3><Servers> with <Folder>name … </Folder> and
// <Server> (Host, Port, Protocol, User, Logontype, Keyfile, Name). Only SFTP sites (Protocol 1) are
// SSH: FTP/FTPS sites are counted and left out. Passwords (<Pass>) are never read, only whether one
// was saved.
//
// The XML is read by a small parser of our own: FileZilla writes plain elements, attributes and text.
// A DOCTYPE is refused (no entity declarations to expand) and depth and element count are capped.

const { createCollector, MAX_FILE_BYTES } = require('./model.js');

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 200000;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// FileZilla's ServerProtocol numbers (1 is SFTP)
const PROTOCOL_NAMES = { 0: 'FTP', 3: 'FTPS', 4: 'FTPS', 6: 'FTP' };
// Logontype: 2 asks for the password, 3 is interactive, 5 uses a key file
const ASKS_PASSWORD = new Set(['2', '3']);
const KEY_FILE = '5';
const PPK_NOTE = 'PuTTY 키(.ppk)는 PPK 2 형식의 RSA·DSA 만 쓸 수 있습니다. 접속이 안 되면 PuTTYgen 으로 OpenSSH 형식으로 바꿔 주세요';

function decode(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] !== '#') return NAMED[ref] ?? whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function readAttrs(source) {
  const attrs = {};
  for (const match of source.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]] = decode(match[2] ?? match[3]);
  }
  return attrs;
}

/** The root element: { name, attrs, children, text } (text: its own text pieces, trimmed and joined) */
function parseXml(input) {
  const text = String(input).replace(/^﻿/, '');
  const stack = [];
  let root = null;
  let elements = 0;
  let at = 0;
  const addText = (piece) => {
    const value = decode(piece).trim();
    if (value && stack.length) stack[stack.length - 1].pieces.push(value);
  };
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open === -1) {
      addText(text.slice(at));
      break;
    }
    if (open > at) addText(text.slice(at, open));
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) throw new Error('unclosed comment');
      at = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end === -1) throw new Error('unclosed CDATA');
      const value = text.slice(open + 9, end).trim();
      if (value && stack.length) stack[stack.length - 1].pieces.push(value);
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', open)) throw new Error('declarations are not read');
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) throw new Error('unclosed declaration');
      at = end + 2;
      continue;
    }
    const close = text.indexOf('>', open + 1);
    if (close === -1) throw new Error('unclosed tag');
    const body = text.slice(open + 1, close);
    at = close + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error('mismatched tag');
      node.text = node.pieces.join(' ');
      delete node.pieces;
      continue;
    }
    const selfClosing = body.endsWith('/');
    const tag = /^([A-Za-z_][\w.:-]*)([\s\S]*?)\/?$/.exec(body);
    if (!tag) throw new Error('bad tag');
    if (++elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) throw new Error('too large');
    const node = { name: tag[1], attrs: readAttrs(tag[2]), children: [], pieces: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) throw new Error('two roots');
    else root = node;
    if (selfClosing) {
      node.text = '';
      delete node.pieces;
    } else {
      stack.push(node);
    }
  }
  if (stack.length || !root) throw new Error('unclosed document');
  return root;
}

const child = (node, name) => node.children.find(c => c.name === name);
const value = (node, name) => child(node, name)?.text ?? '';

function addServer(collector, server, folderPath) {
  const protocol = value(server, 'Protocol').trim() || '0';
  if (protocol !== '1') {
    collector.skip(`${PROTOCOL_NAMES[protocol] ?? '기타 프로토콜'} 사이트`);
    return;
  }
  const logon = value(server, 'Logontype').trim();
  const keyFile = logon === KEY_FILE ? value(server, 'Keyfile') : '';
  collector.add({
    name: value(server, 'Name'),
    host: value(server, 'Host'),
    port: value(server, 'Port'),
    username: value(server, 'User'),
    privateKeyPath: keyFile,
    keyNote: /\.ppk$/i.test(keyFile.trim()) ? PPK_NOTE : '',
    hasSavedPassword: value(server, 'Pass') ? true : ASKS_PASSWORD.has(logon) ? false : null,
    folderId: collector.folderFor(folderPath)
  });
}

function walk(collector, node, folderPath) {
  for (const item of node.children) {
    if (item.name === 'Server') addServer(collector, item, folderPath);
    else if (item.name === 'Folder') walk(collector, item, [...folderPath, item.text]);
  }
}

function readFileZillaText(text) {
  let root;
  try {
    root = parseXml(text);
  } catch {
    throw new Error('FileZilla 사이트 관리자 파일을 읽지 못했습니다.');
  }
  if (root.name !== 'FileZilla3') throw new Error('FileZilla 사이트 관리자 파일이 아닙니다.');
  const collector = createCollector('filezilla', 'FileZilla');
  const servers = child(root, 'Servers');
  if (servers) walk(collector, servers, []);
  return collector.result();
}

function readFileZillaFile(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다.');
  return readFileZillaText(buffer.toString('utf8'));
}

module.exports = { parseXml, readFileZillaText, readFileZillaFile };
