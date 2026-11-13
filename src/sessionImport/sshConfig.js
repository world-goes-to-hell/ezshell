// OpenSSH client config (~/.ssh/config), the way out of programs ezShell cannot read directly
// (Termius, plain ssh). Host blocks with concrete names become sessions; "Host *" gives defaults;
// patterns (*, ?, !) and Match blocks are skipped. ProxyJump's first hop is the jump host, resolved
// through another Host block when it names one. Include is not followed.

const { createCollector, MAX_FILE_BYTES } = require('./model.js');

const KEYS = new Set(['hostname', 'port', 'user', 'identityfile', 'proxyjump']);

function unquote(value) {
  const text = value.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/** Blocks in order: { patterns, options } (first value of a key wins, as in ssh) */
function parseBlocks(text) {
  const blocks = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const match = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === 'host') {
      current = { patterns: value.split(/\s+/).filter(Boolean), options: new Map() };
      blocks.push(current);
    } else if (key === 'match') {
      current = { patterns: [], options: new Map(), isMatch: true };
      blocks.push(current);
    } else if (KEYS.has(key)) {
      if (!current) {
        current = { patterns: ['*'], options: new Map() };
        blocks.push(current);
      }
      if (!current.options.has(key)) current.options.set(key, unquote(value));
    }
  }
  return blocks;
}

const isPattern = (name) => /[*?!]/.test(name);

/** "user@host:port" (first hop of a comma list) */
function parseJump(value) {
  const hop = String(value ?? '').split(',')[0].trim();
  if (!hop || hop.toLowerCase() === 'none') return null;
  const match = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hop);
  if (!match) return null;
  return { username: match[1] ?? '', host: match[2].replace(/^\[|\]$/g, ''), port: match[3] ?? '' };
}

function readSshConfigText(text, { home = '' } = {}) {
  const collector = createCollector('ssh-config', 'OpenSSH config');
  const blocks = parseBlocks(text);
  const defaults = new Map();
  for (const block of blocks) {
    if (block.patterns.length === 1 && block.patterns[0] === '*') {
      for (const [k, v] of block.options) if (!defaults.has(k)) defaults.set(k, v);
    }
  }
  const named = new Map();
  for (const block of blocks) {
    if (block.isMatch) continue;
    for (const pattern of block.patterns) if (!isPattern(pattern) && !named.has(pattern)) named.set(pattern, block.options);
  }
  const expand = (path) => (path.startsWith('~/') && home ? `${home}${path.slice(1)}` : path);
  const option = (options, key) => options.get(key) ?? defaults.get(key);

  for (const block of blocks) {
    if (block.isMatch) {
      collector.skip('Match 블록');
      continue;
    }
    for (const alias of block.patterns) {
      if (isPattern(alias)) {
        if (alias !== '*') collector.skip('패턴 Host');
        continue;
      }
      if (named.get(alias) !== block.options) continue;
      const options = block.options;
      let jump = parseJump(option(options, 'proxyjump'));
      if (jump && named.has(jump.host)) {
        const target = named.get(jump.host);
        jump = { host: target.get('hostname') ?? jump.host, port: jump.port || target.get('port') || '', username: jump.username || target.get('user') || '' };
      }
      collector.add({
        name: alias,
        host: option(options, 'hostname') ?? alias,
        port: option(options, 'port'),
        username: option(options, 'user'),
        privateKeyPath: expand(option(options, 'identityfile') ?? ''),
        hasSavedPassword: false,
        jump
      });
    }
  }
  return collector.result();
}

function readSshConfigFile(buffer, options) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다.');
  return readSshConfigText(buffer.toString('utf8'), options);
}

module.exports = { readSshConfigText, readSshConfigFile, parseJump };
