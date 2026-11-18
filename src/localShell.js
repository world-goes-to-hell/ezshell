// Local terminal tabs: shells of this PC run through a pseudo terminal (node-pty).
// The main window opens them from the tab bar's + menu; nothing else (MCP, other windows) reaches them.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { getProcessParents } = require('./ipc/agentProcessParents.js');

const MAX_SHELLS = 10;
/** Output kept per shell so a tab that is drawn again (pane split, tab moved) continues from it */
const BACKLOG_CHARS = 256 * 1024;
const MIN_SIZE = 2;
const MAX_SIZE = 500;
const MAX_WRITE_CHARS = 1024 * 1024;
const TERMINAL_TYPE = 'xterm-256color';

function localTerminalEnvironment(env, platform) {
  const shellEnv = { ...env };
  const keys = Object.keys(shellEnv);
  const envKey = name => platform === 'win32' ? keys.find(key => key.toUpperCase() === name) ?? name : name;
  const termKey = envKey('TERM');
  const terminalProgram = shellEnv[envKey('TERM_PROGRAM')]?.toLowerCase();
  // Orca can pass NO_COLOR even when its TERM advertises colors.
  if (terminalProgram === 'orca' || shellEnv[termKey]?.toLowerCase() === 'dumb') {
    delete shellEnv[envKey('NO_COLOR')];
  }
  shellEnv[termKey] = TERMINAL_TYPE;
  shellEnv[envKey('COLORTERM')] = 'truecolor';
  return shellEnv;
}

function loginShell() {
  try {
    const shell = os.userInfo().shell;
    return typeof shell === 'string' && shell.startsWith('/') ? shell : null;
  } catch {
    return null;
  }
}

function defaultShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'], name: 'PowerShell' };
  // An app started from the Dock or Finder often has no SHELL in its environment: ask the system
  // for the user's login shell before falling back (zsh is the macOS default)
  const file = env.SHELL || loginShell() || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return { file, args: ['-l'], name: path.basename(file) };
}

const size = (value, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, n)) : fallback;
};

function requireLocalDirectory(folder) {
  if (typeof folder !== 'string' || folder.includes('\0') || !path.isAbsolute(folder)) {
    throw new Error('작업 폴더의 절대 경로가 필요합니다.');
  }
  const directory = path.normalize(folder);
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('작업 폴더를 찾을 수 없습니다.');
  }
  return directory;
}

function shellArgs(shell, agent, platform, withMessaging) {
  if (agent === undefined) return shell.args;
  if (agent !== 'codex' && agent !== 'claude') throw new Error('지원하지 않는 실행 도구입니다.');
  // Per-launch MCP settings preserve the user's project and global agent config.
  const codexConfig = [
    'mcp_servers.ezshell-cli-mcp.command=',
    "mcp_servers.ezshell-cli-mcp.args=['-e','require(process.env.EZSHELL_AGENT_MCP_SCRIPT).run()']",
    "mcp_servers.ezshell-cli-mcp.env.ELECTRON_RUN_AS_NODE='1'",
    "mcp_servers.ezshell-cli-mcp.env_vars=['EZSHELL_AGENT_PIPE','EZSHELL_AGENT_TOKEN','EZSHELL_AGENT_MCP_SCRIPT']"
  ];
  if (platform !== 'win32') {
    const options = !withMessaging ? '' : agent === 'codex'
      ? codexConfig.map((value, index) => ` -c "${value}${index === 0 ? '$EZSHELL_CLI_EXE' : ''}"`).join('')
      : ' --mcp-config "$EZSHELL_AGENT_MCP_CONFIG"';
    return [...shell.args, '-i', '-c', `exec ${agent}${options}`];
  }
  // Prefer installed .exe and .cmd launchers, including npm's launcher on PowerShell systems.
  const options = !withMessaging ? '' : agent === 'codex'
    ? codexConfig.map((value, index) => ` -c "${value}${index === 0 ? '$env:EZSHELL_CLI_EXE' : ''}"`).join('')
    : ' --mcp-config "$env:EZSHELL_AGENT_MCP_CONFIG"';
  const launch = `$cli = Get-Command ${agent}.exe,${agent}.cmd,${agent} -ErrorAction SilentlyContinue | Select-Object -First 1; if (!$cli) { Write-Host '${agent} CLI를 찾을 수 없습니다.'; exit 127 }; & $cli${options}; exit $LASTEXITCODE`;
  return [...shell.args, '-Command', launch];
}

const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';
const PROGRAM_STATES = { idle: 'idle', working: 'working', done: 'idle', blocked: 'blocked', error: 'error', clear: 'unknown' };
const PROGRESS_STATES = ['idle', 'working', 'error', 'working', 'working'];

function agentStatus(entry) {
  const status = entry.reportedStatus ?? entry.titleStatus;
  return status === 'working' && entry.codexInput && !entry.codexInput.submitted ? 'starting' : status;
}

// Keep partial OSC reports across chunks. Prefer each agent's program state
// over the display title and progress bar used by earlier CLI versions.
function trackAgentActivity(entry, data, replyToProbe = true) {
  const output = entry.oscTail + data;
  const sequences = /\x1b\](0|2|9|7501);([^\x07\x1b]{0,4096})(?:\x07|\x1b\\)/g;
  for (const [, code, value] of output.matchAll(sequences)) {
    if (code === '7501' && value === '?') {
      // A CLI in a plain shell may ask before its MCP connection is ready.
      if (replyToProbe) entry.pty.write(PROGRAM_STATUS_REPLY);
      continue;
    }
    if (!entry.agent) continue;
    if (code === '7501') {
      const fields = value.split(':');
      const app = fields.find(field => field.startsWith('app='))?.slice(4);
      if (app && app !== entry.agent && !(entry.agent === 'claude' && app === 'claude-code')) continue;
      // Nested reports describe background jobs, not the terminal's agent.
      if (fields.some(field => field.startsWith('id='))) continue;
      const state = fields.find(field => field.startsWith('state='))?.slice(6);
      if (state && Object.hasOwn(PROGRAM_STATES, state)) entry.reportedStatus = PROGRAM_STATES[state];
    } else if (code === '9') {
      const state = /^4;([0-4])(?:;\d+)?$/.exec(value)?.[1];
      if (state) entry.titleStatus = PROGRESS_STATES[Number(state)];
    } else {
      const title = value.trim();
      if (!title || /(?:^|[\\/])(?:cmd|powershell|pwsh)\.exe(?:\s|$)/i.test(title)) continue;
      if (/^\[\s*[!.]\s*\]\s*Action Required\b/i.test(title)) entry.titleStatus = 'blocked';
      else if (/^Starting\b/i.test(title)) entry.titleStatus = 'starting';
      else entry.titleStatus = /(?:^|\s)[\u2801-\u28ff](?:\s|$)/u.test(title) || /^(?:Working|Thinking)\b/i.test(title) ? 'working' : 'idle';
    }
  }
  entry.oscTail = output.slice(-4110).match(/\x1b(?:\][^\x07\x1b]*\x1b?)?$/)?.[0] ?? '';
}

// A fresh Codex session can spin while it connects to MCP servers with an
// empty composer. Arm its PTY activity indicator after the first submission.
function trackCodexInput(input, data) {
  if (input.submitted) return;
  if (/^(?:\r|\n|\x1b\[13(?:;1)?u)$/.test(data)) {
    input.submitted = input.hasDraft;
    input.hasDraft = false;
    return;
  }
  if (data === '\x03' || data === '\x15' || data === '\x1b') {
    input.hasDraft = false;
    return;
  }
  const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
  const text = paste?.[1] ?? (data.startsWith('\x1b') ? '' : data);
  if (/[^\s\x00-\x1f\x7f]/u.test(text)) input.hasDraft = true;
}

/**
 * @param {object} deps
 * @param {(file: string, args: string[], options: object) => object} deps.spawn node-pty's spawn
 * @param {(channel: string, payload: object) => void} deps.send to the main window
 */
function createLocalShells({
  spawn, send, agents, shell = defaultShell(), cwd = os.homedir(), env = process.env,
  platform = process.platform, processParents = () => getProcessParents(platform)
}) {
  const shells = new Map();
  let nextId = 1;

  function observeInbox(id, entry) {
    const { createAgentInboxWake } = require('./ipc/agentInboxWake.js');
    const pendingMessages = () => agents.unreadFor?.(id) ?? [];
    entry.inbox = createAgentInboxWake({
      kind: entry.agent, cols: entry.cols, rows: entry.rows,
      pendingMessages,
      isWorking: () => {
        const status = agentStatus(entry);
        return status !== 'idle' && !(entry.disconnectAgent && status === 'unknown');
      },
      write(data) {
        if (entry.exited || !pendingMessages().length) return false;
        try {
          entry.pty.write(data);
          if (entry.codexInput) trackCodexInput(entry.codexInput, data);
          return true;
        } catch { return false; }
      }
    });
    entry.inbox.setComposing(entry.composing);
  }

  // Global MCP registrations work outside ezShell too. Only a connection launched
  // from this shell's process tree may use its already-guarded composer wake.
  async function bindAgentProcess({ pid, kind, setStatus, disconnect }) {
    const candidates = new Map();
    for (const [id, entry] of shells) {
      if (!entry.exited && !entry.agent && entry.pty.pid > 0) candidates.set(entry.pty.pid, { id, entry });
    }
    if (!candidates.size) return;
    let parents;
    try { parents = await processParents(); }
    catch { return; }
    const visited = new Set();
    for (let parent = parents.get(pid); parent > 0 && !visited.has(parent); parent = parents.get(parent)) {
      visited.add(parent);
      const candidate = candidates.get(parent);
      if (!candidate) continue;
      const { id, entry } = candidate;
      if (shells.get(id) !== entry || entry.exited || entry.agent || entry.pty.pid !== parent) return;
      entry.agent = kind;
      entry.reportStatus = setStatus;
      entry.disconnectAgent = disconnect;
      entry.codexInput = kind === 'codex' ? { hasDraft: false, submitted: false } : null;
      entry.oscTail = '';
      trackAgentActivity(entry, entry.backlog, false);
      observeInbox(id, entry);
      entry.inbox.writeOutput(entry.backlog);
      return {
        shellId: id,
        status: agentStatus(entry),
        close() {
          if (entry.disconnectAgent !== disconnect) return;
          entry.inbox?.close();
          Object.assign(entry, {
            agent: undefined, reportStatus: undefined, disconnectAgent: undefined, inbox: undefined,
            codexInput: null, titleStatus: 'unknown', reportedStatus: null, oscTail: ''
          });
        }
      };
    }
  }

  function open({ cols, rows, cwd: directory, agent } = {}) {
    if (shells.size >= MAX_SHELLS) throw new Error(`로컬 터미널은 ${MAX_SHELLS}개까지 열 수 있습니다.`);
    const workingDirectory = directory === undefined ? cwd : requireLocalDirectory(directory);
    const id = `local:${nextId++}`;
    const args = shellArgs(shell, agent, platform, Boolean(agents));
    const columns = size(cols, 80);
    const lines = size(rows, 24);
    const shellEnv = localTerminalEnvironment(env, platform);
    const registration = agent && agents?.register(agent, id, workingDirectory, shellEnv);
    let pty;
    try {
      pty = spawn(shell.file, args, {
        name: TERMINAL_TYPE,
        cols: columns,
        rows: lines,
        cwd: workingDirectory,
        env: registration?.env ?? shellEnv
      });
    } catch (error) {
      registration?.close();
      throw error;
    }
    const codexInput = agent === 'codex' ? { hasDraft: false, submitted: false } : null;
    const entry = {
      pty, agent, registration, codexInput, cols: columns, rows: lines, composing: false,
      reportStatus: status => registration?.setStatus?.(status),
      backlog: '', exited: false, exitCode: null, titleStatus: 'unknown', reportedStatus: null, oscTail: ''
    };
    if (registration) observeInbox(id, entry);
    shells.set(id, entry);
    pty.onData((data) => {
      if (!entry.exited) {
        trackAgentActivity(entry, data);
        entry.reportStatus?.(agentStatus(entry));
      }
      entry.inbox?.writeOutput(data);
      entry.backlog += data;
      // Trimmed only now and then: cutting on every chunk copies the whole backlog each time
      if (entry.backlog.length > BACKLOG_CHARS * 2) entry.backlog = entry.backlog.slice(-BACKLOG_CHARS);
      send('local-shell-data', { id, data });
    });
    pty.onExit(({ exitCode }) => {
      entry.exited = true;
      entry.exitCode = exitCode;
      entry.inbox?.close();
      entry.disconnectAgent?.();
      if (registration?.finish) registration.finish(exitCode);
      else registration?.close();
      send('local-shell-exit', { id, exitCode });
    });
    return { id, name: shell.name, ...(directory === undefined ? {} : { cwd: workingDirectory }) };
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
    entry.inbox?.userInput(data);
    entry.pty.write(data);
    if (entry.codexInput && !entry.codexInput.submitted) {
      trackCodexInput(entry.codexInput, data);
      if (entry.codexInput.submitted) entry.reportStatus?.(agentStatus(entry));
    }
  }

  function resize(id, cols, rows) {
    const entry = shells.get(id);
    if (!entry || entry.exited) return;
    try {
      const columns = size(cols, 80);
      const lines = size(rows, 24);
      entry.pty.resize(columns, lines);
      entry.cols = columns;
      entry.rows = lines;
      entry.inbox?.resize(columns, lines);
    } catch {
      // The shell ended between the check and the call
    }
  }

  function close(id) {
    const entry = shells.get(id);
    if (!entry) return;
    shells.delete(id);
    entry.inbox?.close();
    entry.disconnectAgent?.();
    entry.registration?.close();
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

  return {
    open, attach, write, resize, close, closeAll, bindAgentProcess,
    setComposing(id, value) {
      const entry = shells.get(id);
      if (!entry) return;
      entry.composing = value;
      entry.inbox?.setComposing(value);
    },
    wakeInbox: id => shells.get(id)?.inbox?.kick(),
    wakeInboxes: () => { for (const entry of shells.values()) entry.inbox?.kick(); },
    isRunning: id => shells.get(id)?.exited === false,
    hasWorkingAgent: ids => ids.some(id => {
      const entry = shells.get(id);
      return entry?.agent && !entry.exited && agentStatus(entry) === 'working';
    }),
    count: () => shells.size
  };
}

module.exports = { createLocalShells, defaultShell, requireLocalDirectory, MAX_SHELLS, BACKLOG_CHARS };
