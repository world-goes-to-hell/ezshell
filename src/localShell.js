// Local terminal tabs: shells of this PC run through a pseudo terminal (node-pty).
// The main window opens them from the tab bar's + menu; nothing else (MCP, other windows) reaches them.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getProcessTree } = require('./ipc/agentProcessParents.js');

const MAX_SHELLS = 10;
/** Output kept per shell so a tab that is drawn again (pane split, tab moved) continues from it */
const BACKLOG_CHARS = 256 * 1024;
const MIN_SIZE = 2;
const MAX_SIZE = 500;
const MAX_WRITE_CHARS = 1024 * 1024;
const TERMINAL_TYPE = 'xterm-256color';
const AGENT_PROCESS_CHECK_MS = 1000;
const exec = promisify(execFile);

// Let the user's existing PowerShell prompt render as usual, then report the FileSystem location.
// The OSC sequence gets consumed by xterm and does not occupy a row in the terminal.
const POWERSHELL_DIRECTORY_PROMPT = String.raw`
$global:__ezShellOriginalPrompt = (Get-Item Function:\prompt).ScriptBlock
function global:prompt {
    $ezShellPromptText = & $global:__ezShellOriginalPrompt
    $ezShellLocation = Get-Location
    if ($ezShellLocation.Provider.Name -eq 'FileSystem' -and $ezShellLocation.ProviderPath -cne $global:__ezShellReportedDirectory) {
        try {
            $ezShellUri = [System.Uri]::new($ezShellLocation.ProviderPath)
            [Console]::Write("$([char]27)]7;$($ezShellUri.AbsoluteUri)$([char]7)")
            $global:__ezShellReportedDirectory = $ezShellLocation.ProviderPath
        } catch {}
    }
    $ezShellPromptText
}
`;

// Keep the wrapper in the new PowerShell's process. Profiles and Codex's global config stay
// available, and interactive Codex can associate its MCP process with this PTY.
const POWERSHELL_CODEX_FUNCTION = String.raw`
if ((Get-Command codex -ErrorAction SilentlyContinue).CommandType -in 'Application', 'ExternalScript') {
    function global:codex {
        $native = Get-Command codex -CommandType Application,ExternalScript | Select-Object -First 1
        if (!$native) { return }
        $valueOptions = '-c', '--config', '--enable', '--disable', '-i', '--image', '-m', '--model',
            '--local-provider', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir'
        $otherCommands = 'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin',
            'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug',
            'apply', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive',
            'cloud', 'exec-server', 'features', 'help'
        $isolated = $true
        $seenPositional = $false
        for ($i = 0; $i -lt $args.Count; $i++) {
            $argument = [string]$args[$i]
            if ($argument -ceq '--') { break }
            if ($argument -cmatch '^--(?:no-daemon|remote|remote-auth-token-env|help|version)(?:=|$)' -or $argument -cin '-h', '-V') {
                $isolated = $false
                break
            }
            if ($argument -cin $valueOptions) { $i++; continue }
            if (!$seenPositional -and !$argument.StartsWith('-')) {
                $seenPositional = $true
                if ($argument -cin $otherCommands) { $isolated = $false; break }
            }
        }
        if ($isolated -and ((& $native --help 2>$null) -match '^\s*--no-daemon(?:\s|$)')) {
            & $native --no-daemon @args
        } else {
            & $native @args
        }
    }
}
`;

// What ties a process to a running Claude Code session. Started from inside Claude Code (a developer
// running `npm run dev` there), the app passed these on and every Claude in a local shell took itself for
// a sub-session of that one: transcript saving off (no resume), its messaging socket. User settings
// (CLAUDE_CONFIG_DIR, CLAUDE_CODE_GIT_BASH_PATH and the like) stay.
const CLAUDE_SESSION_MARKERS = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SPAWN_BACKEND',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH'
]);

function localTerminalEnvironment(env, platform) {
  const shellEnv = { ...env };
  for (const key of Object.keys(shellEnv)) {
    if (CLAUDE_SESSION_MARKERS.has(key.toUpperCase())) delete shellEnv[key];
  }
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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuming a past session (agent history panel): Codex takes a subcommand before its options, Claude
 * a flag. The id goes into a shell command line, so nothing but a session id is accepted.
 */
function resumeArgs(agent, resume) {
  if (resume === undefined) return '';
  if (agent === undefined || typeof resume !== 'string' || !SESSION_ID.test(resume)) {
    throw new Error('이어서 실행할 세션이 올바르지 않습니다.');
  }
  return agent === 'codex' ? ` resume ${resume}` : ` --resume ${resume}`;
}

// A Claude typed into the shell gets ezShell's usage status line for that run (agentUsageReport.js:
// the usage goes to the app's status bar and the terminal keeps its rows). Left alone when the user
// passes --settings, and when the shell has no settings file (messaging off).
const POWERSHELL_CLAUDE_FUNCTION = String.raw`
if ($env:EZSHELL_AGENT_SETTINGS -and (Get-Command claude -ErrorAction SilentlyContinue).CommandType -in 'Application', 'ExternalScript') {
    function global:claude {
        $native = Get-Command claude -CommandType Application,ExternalScript | Select-Object -First 1
        if (!$native) { return }
        if (($args | Where-Object { [string]$_ -cmatch '^--settings(?:=|$)' }) -or !(Test-Path -LiteralPath $env:EZSHELL_AGENT_SETTINGS)) {
            & $native @args
        } else {
            & $native --settings $env:EZSHELL_AGENT_SETTINGS @args
        }
    }
}
`;

function shellArgs(shell, agent, platform, withMessaging, resume) {
  const resumed = resumeArgs(agent, resume);
  if (agent === undefined) {
    if (platform !== 'win32' || !/^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.win32.basename(shell.file))) return shell.args;
    const agentFunctions = withMessaging ? POWERSHELL_CODEX_FUNCTION + POWERSHELL_CLAUDE_FUNCTION : '';
    return [...shell.args, '-NoExit', '-Command', agentFunctions + POWERSHELL_DIRECTORY_PROMPT];
  }
  if (agent !== 'codex' && agent !== 'claude') throw new Error('지원하지 않는 실행 도구입니다.');
  // Per-launch MCP settings preserve the user's project and global agent config.
  const codexConfig = [
    'mcp_servers.ezshell-cli-mcp.command=',
    "mcp_servers.ezshell-cli-mcp.args=['-e','require(process.env.EZSHELL_AGENT_MCP_SCRIPT).run()']",
    "mcp_servers.ezshell-cli-mcp.env.ELECTRON_RUN_AS_NODE='1'",
    "mcp_servers.ezshell-cli-mcp.env_vars=['EZSHELL_AGENT_PIPE','EZSHELL_AGENT_TOKEN','EZSHELL_AGENT_MCP_SCRIPT']"
  ];
  // A shared Codex server starts MCP outside this terminal and may reuse another session's
  // configuration. Check for the flag so older versions can still start normally.
  const useLocalCodex = withMessaging && agent === 'codex';
  if (platform !== 'win32') {
    const options = !withMessaging ? '' : agent === 'codex'
      ? codexConfig.map((value, index) => ` -c "${value}${index === 0 ? '$EZSHELL_CLI_EXE' : ''}"`).join('')
      : ' --mcp-config "$EZSHELL_AGENT_MCP_CONFIG" --settings "$EZSHELL_AGENT_SETTINGS"';
    const launch = useLocalCodex
      ? `exec /bin/sh -c 'case "$(codex --help 2>/dev/null)" in *--no-daemon*) exec codex${resumed} --no-daemon "$@" ;; *) exec codex${resumed} "$@" ;; esac' ezshell-codex${options}`
      : `exec ${agent}${resumed}${options}`;
    return [...shell.args, '-i', '-c', launch];
  }
  // Prefer installed .exe and .cmd launchers, including npm's launcher on PowerShell systems.
  const options = !withMessaging ? '' : agent === 'codex'
    ? codexConfig.map((value, index) => ` -c "${value}${index === 0 ? '$env:EZSHELL_CLI_EXE' : ''}"`).join('')
    : ' --mcp-config "$env:EZSHELL_AGENT_MCP_CONFIG" --settings "$env:EZSHELL_AGENT_SETTINGS"';
  const localFlag = useLocalCodex
    ? "$ezShellArgs = @(); if ((& $cli --help 2>$null) -match '^\\s*--no-daemon(?:\\s|$)') { $ezShellArgs += '--no-daemon' }; "
    : '';
  const launch = `$cli = Get-Command ${agent}.exe,${agent}.cmd,${agent} -ErrorAction SilentlyContinue | Select-Object -First 1; if (!$cli) { Write-Host '${agent} CLI를 찾을 수 없습니다.'; exit 127 }; ${localFlag}& $cli${resumed}${useLocalCodex ? ' @ezShellArgs' : ''}${options}; exit $LASTEXITCODE`;
  return [...shell.args, '-Command', launch];
}

const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';
const PROGRAM_STATES = { idle: 'idle', working: 'working', done: 'idle', blocked: 'blocked', error: 'error', clear: 'unknown' };
const PROGRESS_STATES = ['idle', 'working', 'error', 'working', 'working'];

// A spinner frame on its own in the title means the agent is working: braille dots (Codex, older
// Claude Code) or half/quarter circles (Claude Code since 2026: ◐◑, idle shows ✳). Recorded from the
// real CLIs; Claude Code sends no program status report, so its title is all there is.
const WORKING_TITLE = /(?:^|\s)[⠁-⣿◐-◓◴-◷](?:\s|$)/u;

function agentStatus(entry) {
  const status = entry.reportedStatus ?? entry.titleStatus;
  return status === 'working' && entry.codexInput && !entry.codexInput.submitted ? 'starting' : status;
}

function directoryFromOsc(value, platform) {
  try {
    const url = new URL(value);
    // A command's output can print OSC too. Only accept local paths and skip UNC/remote hosts.
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
    const folder = fileURLToPath(url, { windows: platform === 'win32' });
    return folder.includes('\0') || (platform === 'win32' && !/^[a-z]:[\\/]/i.test(folder)) ? null : folder;
  } catch {
    return null;
  }
}

// Keep partial OSC reports across chunks, including the shell's working directory and agent state.
function trackTerminalOsc(entry, data, platform, replyToProbe = true) {
  const output = entry.oscTail + data;
  const sequences = /\x1b\](0|2|7|9|7501);([^\x07\x1b]{0,4096})(?:\x07|\x1b\\)/g;
  for (const [, code, value] of output.matchAll(sequences)) {
    if (code === '7') {
      entry.reportedDirectory = directoryFromOsc(value, platform) ?? entry.reportedDirectory;
      continue;
    }
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
      else entry.titleStatus = WORKING_TITLE.test(title) || /^(?:Working|Thinking)\b/i.test(title) ? 'working' : 'idle';
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

// CLI-native image paste reads from the same Windows clipboard as ezShell.
const WINDOWS_IMAGE_PASTE = { codex: '\x16', claude: '\x1bv' };

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

const processName = name => name.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, '');
const appRuntime = processName(process.execPath);

/**
 * @param {object} deps
 * @param {(file: string, args: string[], options: object) => object} deps.spawn node-pty's spawn
 * @param {(channel: string, payload: object) => void} deps.send to the main window
 */
function createLocalShells({
  spawn, send, agents, shell = defaultShell(), cwd = os.homedir(), env = process.env,
  platform = process.platform, processTree = () => getProcessTree(platform), processAlive = isProcessAlive
}) {
  const shells = new Map();
  let nextId = 1;

  const hasAgent = entry => Boolean(entry?.agent && !entry.exited && (!entry.externalAgent || processAlive(entry.externalAgent.pid)));

  function observeInbox(id, entry) {
    const { createAgentInboxWake } = require('./ipc/agentInboxWake.js');
    const pendingMessages = () => agents.unreadFor?.(id) ?? [];
    // Read but not answered yet: a request the agent confirmed while busy and put off
    const unhandledMessages = () => agents.unhandledFor?.(id) ?? [];
    entry.inbox = createAgentInboxWake({
      kind: entry.agent, cols: entry.cols, rows: entry.rows,
      pendingMessages,
      unhandledMessages,
      isWorking: () => {
        const status = agentStatus(entry);
        return status !== 'idle' && !(entry.externalAgent && status === 'unknown');
      },
      isRunningTask: () => agentStatus(entry) === 'working',
      // Nothing reported yet (a CLI just started): the wake waits for a still, empty composer instead
      isUnknown: () => agentStatus(entry) === 'unknown',
      write(data) {
        if (!hasAgent(entry)) return false;
        // Pasting needs mail to announce; the Enter that submits a line already pasted does not (the
        // agent may have read and answered it meanwhile, and the line would stay in the composer)
        if (data !== '\r' && !pendingMessages().length && !unhandledMessages().length) return false;
        try {
          entry.pty.write(data);
          if (entry.codexInput) trackCodexInput(entry.codexInput, data);
          return true;
        } catch { return false; }
      },
      // A line the user sent from the chat view (no mail needed)
      rawWrite(data) {
        if (!hasAgent(entry)) return false;
        try {
          entry.pty.write(data);
          if (entry.codexInput) trackCodexInput(entry.codexInput, data);
          return true;
        } catch { return false; }
      }
    });
    entry.inbox.setComposing(entry.composing);
  }

  function releaseExternalAgent(entry) {
    const binding = entry.externalAgent;
    if (!binding) return;
    clearInterval(binding.timer);
    entry.inbox?.close();
    Object.assign(entry, {
      agent: undefined, reportStatus: undefined, externalAgent: undefined, inbox: undefined,
      codexInput: null, titleStatus: 'unknown', reportedStatus: null, oscTail: ''
    });
    return binding;
  }

  function finishExternalAgent(entry) {
    const binding = releaseExternalAgent(entry);
    binding?.onExit(binding.id);
  }

  // Bind to the CLI ancestor, whose lifetime can be longer than any one MCP connection.
  async function bindAgentProcess({ pid, kind }) {
    const candidates = new Map();
    for (const [id, entry] of shells) {
      if (!entry.exited && (!entry.agent || entry.externalAgent) && entry.pty.pid > 0) candidates.set(entry.pty.pid, { id, entry });
    }
    if (!candidates.size) return;
    let processes;
    try { processes = await processTree(); }
    catch { return; }
    const visited = new Set();
    let cliPid;
    let runtimePid;
    for (let parent = processes.get(pid)?.parent; parent > 0 && !visited.has(parent); parent = processes.get(parent)?.parent) {
      visited.add(parent);
      const candidate = candidates.get(parent);
      if (!candidate) {
        const ancestor = processes.get(parent);
        if (!ancestor) return;
        const name = processName(ancestor.name);
        if (name === kind) cliPid ??= parent;
        if (name === 'node' || name === appRuntime) runtimePid ??= parent;
        continue;
      }
      const { id, entry } = candidate;
      const agentPid = cliPid ?? runtimePid;
      if (!agentPid) return;
      return ({ agentId, setStatus, onExit }) => {
        if (shells.get(id) !== entry || entry.exited || entry.pty.pid !== parent || !processAlive(agentPid)) return;
        let binding = entry.externalAgent;
        if (binding && !processAlive(binding.pid)) {
          finishExternalAgent(entry);
          binding = undefined;
        }
        if (entry.agent && (binding?.pid !== agentPid || entry.agent !== kind)) return;
        if (!binding) {
          binding = { id: agentId, pid: agentPid, onExit };
          entry.externalAgent = binding;
          entry.agent = kind;
          entry.codexInput = kind === 'codex' ? { hasDraft: false, submitted: false } : null;
          entry.oscTail = '';
          trackTerminalOsc(entry, entry.backlog, platform, false);
          observeInbox(id, entry);
          entry.inbox.writeOutput(entry.backlog);
          binding.timer = setInterval(() => {
            if (!processAlive(agentPid)) finishExternalAgent(entry);
          }, AGENT_PROCESS_CHECK_MS);
          binding.timer.unref?.();
        }
        entry.reportStatus = setStatus;
        const connection = {};
        binding.connection = connection;
        return {
          shellId: id,
          agentId: binding.id,
          status: agentStatus(entry),
          detach() {
            if (entry.externalAgent !== binding || binding.connection !== connection) return false;
            binding.connection = undefined;
            if (!processAlive(binding.pid)) {
              releaseExternalAgent(entry);
              return false;
            }
            return true;
          }
        };
      };
    }
  }

  function open({ cols, rows, cwd: directory, agent, resume, replacementFor } = {}) {
    const previous = replacementFor === undefined ? undefined : shells.get(replacementFor);
    if (replacementFor !== undefined) {
      if (!previous || !resume) throw new Error('바꿀 셸을 찾지 못했습니다.');
      if ([...shells.values()].some(entry => entry.replacementFor === replacementFor)) throw new Error('이 칸의 셸을 바꾸는 중입니다.');
    }
    // A replacement may use one extra slot until the renderer adopts it and closes the old shell.
    if (shells.size >= MAX_SHELLS + Number(Boolean(previous))) {
      throw new Error(`로컬 터미널은 ${MAX_SHELLS}개까지 열 수 있습니다.`);
    }
    const workingDirectory = directory === undefined ? cwd : requireLocalDirectory(directory);
    const id = `local:${nextId++}`;
    const args = shellArgs(shell, agent, platform, Boolean(agents), resume);
    const columns = previous?.cols ?? size(cols, 80);
    const lines = previous?.rows ?? size(rows, 24);
    const shellEnv = localTerminalEnvironment(env, platform);
    // A resumed Codex writes on in its old session file: the usage watcher finds it by this id
    const registration = agent && agents?.register(agent, id, workingDirectory, shellEnv, resume && SESSION_ID.test(resume) ? resume.toLowerCase() : null);
    // Every shell's own token: the usage status line of a Claude typed into it reports with it
    const shellUsageEnv = agents?.registerShell?.(id) ?? {};
    let pty;
    try {
      pty = spawn(shell.file, args, {
        name: TERMINAL_TYPE,
        cols: columns,
        rows: lines,
        cwd: workingDirectory,
        env: { ...(registration?.env ?? shellEnv), ...shellUsageEnv }
      });
    } catch (error) {
      agents?.forgetShell?.(id);
      registration?.close();
      throw error;
    }
    const codexInput = agent === 'codex' ? { hasDraft: false, submitted: false } : null;
    const entry = {
      pty, agent, registration, codexInput, cols: columns, rows: lines, composing: false, replacementFor,
      // For a window that reloads and takes the shell back as a tab (`list`)
      cwd: directory === undefined ? null : workingDirectory,
      launchDirectory: workingDirectory, reportedDirectory: null,
      reportStatus: status => registration?.setStatus?.(status),
      backlog: '', exited: false, exitCode: null, titleStatus: 'unknown', reportedStatus: null, oscTail: ''
    };
    if (registration) observeInbox(id, entry);
    shells.set(id, entry);
    pty.onData((data) => {
      if (!entry.exited) {
        trackTerminalOsc(entry, data, platform);
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
      finishExternalAgent(entry);
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

  function pasteClipboardImage(id) {
    const entry = shells.get(id);
    if (platform !== 'win32' || !hasAgent(entry) || !Object.hasOwn(WINDOWS_IMAGE_PASTE, entry.agent)) return false;
    write(id, WINDOWS_IMAGE_PASTE[entry.agent]);
    if (entry.codexInput && !entry.codexInput.submitted) entry.codexInput.hasDraft = true;
    return true;
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
    finishExternalAgent(entry);
    entry.registration?.close();
    agents?.forgetShell?.(id);
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

  async function currentDirectory(id) {
    const entry = shells.get(id);
    if (!entry) return null;
    const pid = entry.pty.pid;
    if (!entry.exited && Number.isInteger(pid) && pid > 0 && platform !== 'win32') {
      try {
        let folder;
        if (platform === 'linux') folder = await fs.promises.readlink(`/proc/${pid}/cwd`);
        if (platform === 'darwin') {
          const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-Fn0'], {
            timeout: 1800, encoding: 'utf8', maxBuffer: 16384
          });
          folder = stdout.split('\0').find(field => field.startsWith('n/'))?.slice(1);
        }
        if (folder && path.isAbsolute(folder) && shells.get(id) === entry && !entry.exited) return folder;
      } catch { /* keep the most recent reported or launch directory */ }
    }
    return shells.get(id) === entry ? entry.reportedDirectory ?? entry.launchDirectory : null;
  }

  return {
    open, attach, write, pasteClipboardImage, resize, close, closeAll, bindAgentProcess, currentDirectory,
    /**
     * Every shell, oldest first. The shells outlive their tabs, so a window that reloaded (and lost
     * all its tabs) takes these back; otherwise they kept running unseen, agents included.
     */
    list: () => [...shells].map(([id, entry]) => ({
      id, name: shell.name, exited: entry.exited, cwd: entry.cwd, agent: entry.agent ?? null
    })),
    setComposing(id, value) {
      const entry = shells.get(id);
      if (!entry) return;
      entry.composing = value;
      entry.inbox?.setComposing(value);
    },
    /** The agent running in the shell ('claude' / 'codex') and its state, or null */
    agentOf(id) {
      const entry = shells.get(id);
      return hasAgent(entry) ? { kind: entry.agent, status: agentStatus(entry) } : null;
    },
    /**
     * A line from the chat view (src/agentChat): into the agent's composer only, never the shell. Not
     * while it asks for approval (the text would answer the question).
     */
    async chatSend(id, text) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || !entry.inbox) return { ok: false, reason: 'not-agent' };
      if (agentStatus(entry) === 'blocked') return { ok: false, reason: 'approval' };
      const result = await entry.inbox.submitText(text);
      if (result.ok && entry.codexInput && entry.codexInput.submitted) entry.reportStatus?.(agentStatus(entry));
      return result;
    },
    /** The agent's numbered prompt on screen (permission, question), for the chat view; or null */
    approvalOf(id) {
      const entry = shells.get(id);
      return hasAgent(entry) && entry.inbox ? entry.inbox.approvalPrompt() : null;
    },
    /** Answers that prompt with a choice, only if the screen still shows the same prompt */
    async answerApproval(id, key, signature) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || !entry.inbox) return { ok: false, reason: 'not-agent' };
      return entry.inbox.answerApproval(key, signature);
    },
    /** Esc: stops the agent's current turn */
    interruptAgent(id) {
      const entry = shells.get(id);
      if (!hasAgent(entry)) return false;
      entry.inbox?.userInput('\x1b');
      try { entry.pty.write('\x1b'); return true; } catch { return false; }
    },
    wakeInbox: id => shells.get(id)?.inbox?.kick(),
    wakeInboxes: () => { for (const entry of shells.values()) entry.inbox?.kick(); },
    isRunning: id => shells.get(id)?.exited === false,
    hasWorkingAgent: ids => ids.some(id => {
      const entry = shells.get(id);
      return hasAgent(entry) && agentStatus(entry) === 'working';
    }),
    count: () => shells.size
  };
}

module.exports = { createLocalShells, defaultShell, requireLocalDirectory, MAX_SHELLS, BACKLOG_CHARS };
