// Local terminal tabs: shells of this PC run through a pseudo terminal (node-pty).
// The main window opens them from the tab bar's + menu; nothing else (MCP, other windows) reaches them.

const os = require('os');
const path = require('path');

const MAX_SHELLS = 10;
/** Output kept per shell so a tab that is drawn again (pane split, tab moved) continues from it */
const BACKLOG_CHARS = 256 * 1024;
const MIN_SIZE = 2;
const MAX_SIZE = 500;
const MAX_WRITE_CHARS = 1024 * 1024;

function defaultShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'], name: 'PowerShell' };
  const file = env.SHELL || '/bin/bash';
  return { file, args: ['-l'], name: path.basename(file) };
}

const size = (value, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, n)) : fallback;
};

/**
 * @param {object} deps
 * @param {(file: string, args: string[], options: object) => object} deps.spawn node-pty's spawn
 * @param {(channel: string, payload: object) => void} deps.send to the main window
 */
function createLocalShells({ spawn, send, shell = defaultShell(), cwd = os.homedir(), env = process.env }) {
  const shells = new Map();
  let nextId = 1;

  function open({ cols, rows } = {}) {
    if (shells.size >= MAX_SHELLS) throw new Error(`로컬 터미널은 ${MAX_SHELLS}개까지 열 수 있습니다.`);
    const id = `local:${nextId++}`;
    const pty = spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: size(cols, 80),
      rows: size(rows, 24),
      cwd,
      env
    });
    const entry = { pty, backlog: '', exited: false, exitCode: null };
    shells.set(id, entry);
    pty.onData((data) => {
      entry.backlog += data;
      // Trimmed only now and then: cutting on every chunk copies the whole backlog each time
      if (entry.backlog.length > BACKLOG_CHARS * 2) entry.backlog = entry.backlog.slice(-BACKLOG_CHARS);
      send('local-shell-data', { id, data });
    });
    pty.onExit(({ exitCode }) => {
      entry.exited = true;
      entry.exitCode = exitCode;
      send('local-shell-exit', { id, exitCode });
    });
    return { id, name: shell.name };
  }

  /** What a tab needs to draw itself again; null when the shell is gone */
  function attach(id) {
    const entry = shells.get(id);
    if (!entry) return null;
    return { backlog: entry.backlog.slice(-BACKLOG_CHARS), exited: entry.exited, exitCode: entry.exitCode };
  }

  function write(id, data) {
    const entry = shells.get(id);
    if (!entry || entry.exited || typeof data !== 'string' || data.length > MAX_WRITE_CHARS) return;
    entry.pty.write(data);
  }

  function resize(id, cols, rows) {
    const entry = shells.get(id);
    if (!entry || entry.exited) return;
    try {
      entry.pty.resize(size(cols, 80), size(rows, 24));
    } catch {
      // The shell ended between the check and the call
    }
  }

  function close(id) {
    const entry = shells.get(id);
    if (!entry) return;
    shells.delete(id);
    if (entry.exited) return;
    try {
      entry.pty.kill();
    } catch {
      // Already gone
    }
  }

  function closeAll() {
    for (const id of [...shells.keys()]) close(id);
  }

  return { open, attach, write, resize, close, closeAll, count: () => shells.size };
}

module.exports = { createLocalShells, defaultShell, MAX_SHELLS, BACKLOG_CHARS };
