// Local terminal tabs: shells of this PC run through a pseudo terminal (node-pty).
// The main window opens them from the tab bar's + menu; nothing else (MCP, other windows) reaches them.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { getProcessTree } = require('./ipc/agentProcessParents.js');
const { createAgentHookState, hookStatus, applyAgentHook, reconcileAgentHook } = require('./ipc/agentHookState.js');
const { POWERSHELL_CODEX_HOOK_ARGS, injectCodexHooks, quoteCodexHookArgs, codexProjectHooksPossible, observeCodexHookReview } = require('./ipc/codexHookLaunch.js');
const { processCommandLine, processList, resumeCommand, words } = require('./agentIdle.js');
const { antigravityBrainRoot, openAntigravityTranscript } = require('./agentChat/antigravitySessions.js');
const { developmentAddress, stopDevelopmentProcess: stopDeveloperTree, waitDevelopmentPort: waitDeveloperPort } = require('./ipc/developmentProcess.js');
const { createLogDecoder, windowsConsoleEncoding } = require('./ipc/developmentEncoding.js');
const { trackRunCleanup, waitRunCleanup } = require('./ipc/runScratch.js');
const { isLocalFilePath } = require('./localKeyPath.js');

/** Output kept per shell so a tab that is drawn again (pane split, tab moved) continues from it */
const BACKLOG_CHARS = 256 * 1024;
const MIN_SIZE = 2;
const MAX_SIZE = 500;
const MAX_WRITE_CHARS = 1024 * 1024;
const TERMINAL_TYPE = 'xterm-256color';
const AGENT_PROCESS_CHECK_MS = 1000;
const CLAUDE_START_TOLERANCE_MS = 1000;
const CLAUDE_SESSION_DELAY_MS = 60_000;
// Putting an idle agent to sleep (agentIdle.js): how long its CLI may take to close after `/exit`, and how
// long the resumed one may take to come back (its messages MCP binds it to the shell again)
const SLEEP_EXIT_MS = 15 * 1000;
const WAKE_BIND_MS = 2 * 60 * 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
${POWERSHELL_CODEX_HOOK_ARGS}
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
        $noDaemon = $false
        $seenPositional = $false
        for ($i = 0; $i -lt $args.Count; $i++) {
            $argument = [string]$args[$i]
            if ($argument -ceq '--') { break }
            if ($argument -ceq '--no-daemon') { $noDaemon = $true; continue }
            if ($argument -cmatch '^--(?:remote|remote-auth-token-env|help|version)(?:=|$)' -or $argument -cin '-h', '-V') {
                $isolated = $false
                break
            }
            if ($argument -cin $valueOptions) { $i++; continue }
            if (!$seenPositional -and !$argument.StartsWith('-')) {
                $seenPositional = $true
                if ($argument -cin $otherCommands) { $isolated = $false; break }
            }
        }
        $extras = @()
        $hookArgs = @()
        if ($isolated) {
            if (!$noDaemon -and ((& $native --help 2>$null) -match '^\s*--no-daemon(?:\s|$)')) { $extras += '--no-daemon' }
            $hookArgs = @(Get-EzShellCodexHookArgs $native ($__ezShellAutomaticCodex -eq $true))
        }
        if ($hookArgs.Count) { [Console]::Write("$([char]27)]777;ezshell-codex-hooks=start;$env:EZSHELL_CODEX_HOOK_NONCE$([char]7)") }
        try {
            if ($args -ccontains '--') { & $native @extras @hookArgs @args }
            else { & $native @extras @args @hookArgs }
        } finally {
            if ($hookArgs.Count) { [Console]::Write("$([char]27)]777;ezshell-codex-hooks=end;$env:EZSHELL_CODEX_HOOK_NONCE$([char]7)") }
        }
    }
}
`;

// What ties a process to a running Claude Code session. Started from inside Claude Code (a developer
// running `npm run dev` there), the app passed these on and every Claude in a local shell took itself for
// a sub-session of that one: transcript saving off (no resume), its messaging socket. User settings
// (CLAUDE_CONFIG_DIR, CLAUDE_CODE_GIT_BASH_PATH and the like) stay. A new local shell also gets
// its own ezShell credentials, even when the app itself was launched from another agent's shell.
const AGENT_SESSION_MARKERS = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SPAWN_BACKEND',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH',
  'EZSHELL_AGENT_ID', 'EZSHELL_AGENT_TOKEN', 'EZSHELL_SHELL_TOKEN', 'EZSHELL_AGENT_PIPE',
  'EZSHELL_AGENT_MCP_CONFIG', 'EZSHELL_AGENT_MCP_SCRIPT', 'EZSHELL_AGENT_SETTINGS', 'EZSHELL_AGENT_USAGE_SCRIPT', 'EZSHELL_AGENT_HOOK_SCRIPT',
  'EZSHELL_CODEX_HOOK_MODE_FILE', 'EZSHELL_CODEX_HOOK_ARGS', 'EZSHELL_CODEX_HOOK_NONCE',
  'EZSHELL_AGENT_WAKE_KIND', 'EZSHELL_AGENT_WAKE_MCP_CONFIG', 'EZSHELL_AGENT_SHELL_KIND', 'EZSHELL_AGENT_SHELL_MCP_CONFIG',
  'EZSHELL_ANTIGRAVITY_SETTINGS', 'EZSHELL_ANTIGRAVITY_STATUS_SCRIPT', 'EZSHELL_ANTIGRAVITY_STATUS_FORWARD',
  'EZSHELL_ANTIGRAVITY_STATUS_COMMAND',
  'EZSHELL_CLI_EXE', 'EZSHELL_CLI_SCRIPT'
]);

function localTerminalEnvironment(env, platform) {
  const shellEnv = { ...env };
  for (const key of Object.keys(shellEnv)) {
    if (AGENT_SESSION_MARKERS.has(key.toUpperCase())) delete shellEnv[key];
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

function launchedDirectoryIdentity(folder) {
  if (!isLocalFilePath(folder)) return null;
  try {
    const directory = fs.realpathSync.native(folder);
    if (!isLocalFilePath(directory)) return null;
    const stat = fs.statSync(directory, { bigint: true });
    return stat.isDirectory() && stat.ino !== 0n ? { directory, dev: stat.dev, ino: stat.ino } : null;
  } catch { return null; }
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuming a past session (agent history panel): Codex takes a subcommand before its options, Claude
 * a flag. The id goes into a shell command line, so nothing but a session id is accepted.
 */
function resumeArgs(agent, resume) {
  if (resume === undefined) return '';
  if ((agent !== 'claude' && agent !== 'codex') || typeof resume !== 'string' || !SESSION_ID.test(resume)) {
    throw new Error('이어서 실행할 세션이 올바르지 않습니다.');
  }
  return agent === 'codex' ? ` resume ${resume}` : ` --resume ${resume}`;
}

// A Claude typed into the shell gets per-session messaging and the usage status line. Explicit
// MCP flags (including the one sent by wake()) and explicit settings take priority.
const POWERSHELL_CLAUDE_FUNCTION = String.raw`
if ($env:EZSHELL_AGENT_SETTINGS -and (Get-Command claude -ErrorAction SilentlyContinue).CommandType -in 'Application', 'ExternalScript') {
    function global:claude {
        $native = Get-Command claude -CommandType Application,ExternalScript | Select-Object -First 1
        if (!$native) { return }
        $settings = @()
        if (!($args | Where-Object { [string]$_ -cmatch '^--settings(?:=|$)' }) -and (Test-Path -LiteralPath $env:EZSHELL_AGENT_SETTINGS)) {
            $settings = @('--settings', $env:EZSHELL_AGENT_SETTINGS)
        }
        $mcp = @()
        $subcommands = 'agents', 'auth', 'doctor', 'help', 'install', 'mcp', 'plugin', 'plugins', 'setup-token', 'update', 'upgrade', 'remote-control', 'rc'
        if (($args.Count -eq 0 -or $args[0] -cnotin $subcommands) -and $env:EZSHELL_AGENT_SHELL_MCP_CONFIG -and
            !($args | Where-Object { [string]$_ -cmatch '^(?:--(?:mcp-config|strict-mcp-config|print|help|version)(?:=|$)|--$|-[phvV]$)' }) -and
            (Test-Path -LiteralPath $env:EZSHELL_AGENT_SHELL_MCP_CONFIG)) {
            $mcp = @('--mcp-config', $env:EZSHELL_AGENT_SHELL_MCP_CONFIG)
        }
        & $native @settings @args @mcp
    }
}
`;

const AGY_SETTINGS_WARNING = '이 Antigravity CLI 는 ezShell 채팅 보기에 필요한 설정을 지원하지 않습니다. agy update 로 업데이트하면 채팅 보기를 쓸 수 있습니다.';

const POWERSHELL_FIND_AGY = String.raw`
$agyCommand = Get-Command agy.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$agyCommand -and $env:LOCALAPPDATA) {
    $agyInstalled = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
    if (Test-Path -LiteralPath $agyInstalled -PathType Leaf) { $agyCommand = $agyInstalled }
}
`;

const POWERSHELL_AGY_SETTINGS_SUPPORT = String.raw`
function global:Test-EzShellAgySettings($command) {
    $executable = if ($command -is [System.Management.Automation.ApplicationInfo]) { $command.Path } else { $command }
    $file = Get-Item -LiteralPath $executable -ErrorAction SilentlyContinue
    $probe = $global:ezShellAgySettingsProbe
    if ($file -and $probe -and $probe.Path -ceq $file.FullName -and $probe.Length -eq $file.Length -and $probe.Modified -eq $file.LastWriteTimeUtc.Ticks) {
        return $probe.Supported
    }
    $ErrorActionPreference = 'Continue'
    $helpText = & $command --help 2>&1
    $supported = ($helpText -join [Environment]::NewLine) -cmatch '(?:^|\s)--settings(?:[=\s]|$)'
    if ($file -and ($supported -or $LASTEXITCODE -eq 0)) {
        $global:ezShellAgySettingsProbe = @{
            Path = $file.FullName; Length = $file.Length; Modified = $file.LastWriteTimeUtc.Ticks; Supported = $supported
        }
    }
    return $supported
}
`;

const POWERSHELL_AGY_LAUNCH = String.raw`
if (Test-EzShellAgySettings $agyCommand) {
    $savedAgyOsc = $env:AGY_CLI_OSC7501
    $savedAgyMessages = $env:AGY_CLI_OSC7501_MESSAGES
    try {
        $env:AGY_CLI_OSC7501 = 'on'
        $env:AGY_CLI_OSC7501_MESSAGES = 'brief'
        & $agyCommand --settings $env:EZSHELL_ANTIGRAVITY_SETTINGS @args
    } finally {
        $env:AGY_CLI_OSC7501 = $savedAgyOsc
        $env:AGY_CLI_OSC7501_MESSAGES = $savedAgyMessages
    }
} else {
    if (!$global:ezShellAgySettingsWarningShown) {
        $global:ezShellAgySettingsWarningShown = $true
        [Console]::WriteLine("$([char]27)[2m${AGY_SETTINGS_WARNING}$([char]27)[0m")
    }
    & $agyCommand @args
}
`;

const POWERSHELL_AGY_FUNCTION = String.raw`
if ($env:EZSHELL_ANTIGRAVITY_SETTINGS -and !(Get-Command agy -CommandType Alias,Function,ExternalScript -ErrorAction SilentlyContinue)) {
    ${POWERSHELL_FIND_AGY}
    if ($agyCommand) {
        ${POWERSHELL_AGY_SETTINGS_SUPPORT}
        function global:agy {
            ${POWERSHELL_FIND_AGY}
            if (!$agyCommand) { return }
            $subcommands = 'acp','agent','agents','changelog','help','install','mcp','mic-serve','models','plugin','plugins','remote-control','update'
            if (($args | Where-Object { [string]$_ -cmatch '^(?:--(?:settings|help|version|print|prompt|input-format|output-format|remote-agent|remote-control)(?:=|$)|-[phV]$)' -or [string]$_ -cin $subcommands }) -or !(Test-Path -LiteralPath $env:EZSHELL_ANTIGRAVITY_SETTINGS)) {
                & $agyCommand @args
            } else {
                ${POWERSHELL_AGY_LAUNCH}
            }
        }
    }
}
`;

const POSIX_AGY_LAUNCH = String.raw`exec /bin/sh -c '
agy_command=$(command -v agy) || { printf "%s\n" "Antigravity CLI를 찾을 수 없습니다." >&2; exit 127; }
if "$agy_command" --help 2>&1 | grep -Eq "(^|[[:space:]])--settings([=[:space:]]|$)"; then
    AGY_CLI_OSC7501=on AGY_CLI_OSC7501_MESSAGES=brief "$agy_command" --settings "$EZSHELL_ANTIGRAVITY_SETTINGS"
else
    printf "\033[2m%s\033[0m\n" "${AGY_SETTINGS_WARNING}"
    "$agy_command"
fi
exit $?
'`;

function shellArgs(shell, agent, platform, withMessaging, resume, codexHooks, restoring) {
  const resumed = resumeArgs(agent, resume);
  if (agent === undefined) {
    if (platform !== 'win32' || !/^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.win32.basename(shell.file))) return shell.args;
    const agentFunctions = withMessaging ? POWERSHELL_CODEX_FUNCTION + POWERSHELL_CLAUDE_FUNCTION + POWERSHELL_AGY_FUNCTION : '';
    return [...shell.args, '-NoExit', '-Command', agentFunctions + POWERSHELL_DIRECTORY_PROMPT];
  }
  if (agent === 'antigravity') {
    // Keep the shell as the CLI's parent so the status reporter can prove which PTY it belongs to.
    if (platform !== 'win32') return [...shell.args, '-i', '-c', POSIX_AGY_LAUNCH];
    return [...shell.args, '-NoExit', '-Command', POWERSHELL_DIRECTORY_PROMPT + POWERSHELL_FIND_AGY + POWERSHELL_AGY_SETTINGS_SUPPORT + String.raw`
if ($agyCommand) { ${POWERSHELL_AGY_LAUNCH} }
else { Write-Host 'Antigravity CLI를 찾을 수 없습니다.' }
`];
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
    const hooks = codexHooks ? ' ' + quoteCodexHookArgs() : '';
    const launch = useLocalCodex
      ? `exec /bin/sh -c 'case "$(codex --help 2>/dev/null)" in *--no-daemon*) exec codex${resumed} --no-daemon "$@" ;; *) exec codex${resumed} "$@" ;; esac' ezshell-codex${options}${hooks}`
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
  const hooks = codexHooks ? `${POWERSHELL_CODEX_HOOK_ARGS}\n$ezShellArgs += @(Get-EzShellCodexHookArgs $cli ${restoring ? '$true' : '$false'}); ` : '';
  const launch = `$cli = Get-Command ${agent}.exe,${agent}.cmd,${agent} -ErrorAction SilentlyContinue | Select-Object -First 1; if (!$cli) { Write-Host '${agent} CLI를 찾을 수 없습니다.'; exit 127 }; ${localFlag}${hooks}& $cli${resumed}${useLocalCodex ? ' @ezShellArgs' : ''}${options}; exit $LASTEXITCODE`;
  return [...shell.args, '-Command', launch];
}

function developmentShellArgs(shell, task, platform) {
  if (platform !== 'win32') {
    const command = task.custom ? task.command : `exec ${task.command}`;
    return [...shell.args, '-c', [task.installCommand, command].filter(Boolean).join(' && ')];
  }
  const commands = [task.installCommand, task.command].filter(Boolean);
  const encoding = !task.tomcat && windowsConsoleEncoding(task.logEncoding);
  const script = [encoding, ...commands.map(command => `${command}\nif (!$?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }`)].filter(Boolean).join('\n');
  return [...shell.args, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function developmentEnvironment(env, task, platform) {
  const result = localTerminalEnvironment(env, platform);
  const keyOf = key => platform === 'win32' ? Object.keys(result).find(name => name.toUpperCase() === key) ?? key : key;
  for (const [key, value] of Object.entries(task.env ?? {})) result[keyOf(key)] = value;
  if (task.clearJavaCommand) delete result[keyOf('JAVACMD')];
  if (task.javaHome) {
    const pathKey = keyOf('PATH');
    result[keyOf('JAVA_HOME')] = task.javaHome;
    result[pathKey] = [path.join(task.javaHome, 'bin'), result[pathKey]].filter(Boolean).join(path.delimiter);
  }
  return result;
}

const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';
const PROGRAM_STATES = { idle: 'idle', working: 'working', done: 'idle', blocked: 'blocked', error: 'error', clear: 'unknown' };
const PROGRESS_STATES = ['idle', 'working', 'error', 'working', 'working'];

// A spinner frame on its own in the title means the agent is working: braille dots (Codex, older
// Claude Code) or half/quarter circles (Claude Code since 2026: ◐◑, idle shows ✳). Recorded from the
// real CLIs; Claude Code sends no program status report, so its title is all there is.
const WORKING_TITLE = /(?:^|\s)[⠁-⣿◐-◓◴-◷](?:\s|$)/u;
const LONG_HOOK_TURN_MS = 120_000;

function agentStatus(entry) {
  if (entry.screenApproval) return 'blocked';
  const official = hookStatus(entry.hookState);
  if (official) return official;
  if (entry.agent === 'antigravity') {
    const status = entry.externalAgent?.antigravity?.status;
    if (entry.reportedStatus === 'blocked' || status === 'blocked') return 'blocked';
    if (status === 'starting' || status === 'working' || status === 'error') return status;
    return entry.reportedStatus ?? status ?? 'unknown';
  }
  let status = entry.reportedStatus ?? entry.titleStatus;
  const activity = entry.hookState ? null : entry.codexActivity;
  const turn = activity?.turn;
  if (turn && turn.at > Math.max(activity.oscAt, activity.submittedAt)) {
    if (turn.status === 'idle' && entry.reportedStatus === 'working' && entry.titleStatus !== 'blocked') status = 'idle';
    else if (turn.status === 'working' && status !== 'blocked' && status !== 'error') return 'working';
  }
  return status === 'working' && entry.codexInput && !entry.codexInput.submitted && !turn ? 'starting' : status;
}

function agentStatusSource(entry, status) {
  if ((entry.agent !== 'claude' && entry.agent !== 'codex') || status === 'unknown') return;
  if (entry.screenApproval) return 'screen';
  if (hookStatus(entry.hookState)) return 'hook';
  const screen = entry.reportedStatus ?? entry.titleStatus;
  if (status === screen || (status === 'starting' && screen === 'working')) return 'screen';
}

function reportShellStatus(entry, setStatus, status) {
  const source = agentStatusSource(entry, status);
  if (source) setStatus?.(status, source);
  else setStatus?.(status);
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

function verifiedCodexRoleDirectory(entry, reportedCwd, platform) {
  const cwd = entry.reportedDirectory ?? entry.launchDirectory;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof cwd !== 'string' || typeof reportedCwd !== 'string' ||
      !paths.isAbsolute(cwd) || !paths.isAbsolute(reportedCwd)) return null;
  return paths.relative(cwd, reportedCwd) === '' ? cwd : null;
}

// Keep partial OSC reports across chunks, including the shell's working directory and agent state.
// Terminal modes a CLI turns on once, when it starts (bracketed paste, application cursor keys). They are
// kept from the whole output, not only the backlog: an agent typed into the shell gets its screen when its
// messages MCP connects, which can be long after the start scrolled out of the backlog, and without
// bracketed paste that screen never finds the composer (2026-11-23 user report: a capture could not be sent).
const TRACKED_MODES = new Set(['1', '2004']);

function trackTerminalModes(entry, data) {
  const output = entry.modeTail + data;
  for (const [, params, set] of output.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    for (const mode of params.split(';')) if (TRACKED_MODES.has(mode)) entry.modes[mode] = set === 'h';
  }
  // A sequence split between chunks is read with the next one (reading one twice changes nothing)
  entry.modeTail = output.slice(-16);
}

/** The tracked modes as sequences that draw nothing, written after the backlog to a new screen */
const modeSequences = entry => Object.entries(entry.modes).map(([mode, on]) => `\x1b[?${mode}${on ? 'h' : 'l'}`).join('');

function trackTerminalOsc(entry, data, platform, replyToProbe = true) {
  const output = entry.oscTail + data;
  const sequences = /\x1b\](0|2|7|9|777|7501);([^\x07\x1b]{0,4096})(?:\x07|\x1b\\)/g;
  for (const [, code, value] of output.matchAll(sequences)) {
    if (code === '777') {
      if (replyToProbe) entry.codexLaunchMarker?.(value);
      continue;
    }
    if (code === '7') {
      entry.reportedDirectory = directoryFromOsc(value, platform) ?? entry.reportedDirectory;
      continue;
    }
    if (code === '7501' && value === '?') {
      // A CLI in a plain shell may ask before its MCP connection is ready.
      if (!entry.agent) entry.pendingAntigravityStatus = null;
      if (replyToProbe) entry.pty.write(PROGRAM_STATUS_REPLY);
      continue;
    }
    if (code === '7501') {
      const fields = value.split(':');
      const app = fields.find(field => field.startsWith('app='))?.slice(4);
      // Nested reports describe background jobs, not the terminal's agent.
      if (fields.some(field => field.startsWith('id='))) continue;
      const state = fields.find(field => field.startsWith('state='))?.slice(6);
      if (!state || !Object.hasOwn(PROGRAM_STATES, state)) continue;
      if (!entry.agent && app === 'antigravity') entry.pendingAntigravityStatus = PROGRAM_STATES[state];
      if (!entry.agent || (entry.agent === 'antigravity' && !app)) continue;
      if (app && app !== entry.agent && !(entry.agent === 'claude' && app === 'claude-code')) continue;
      entry.reportedStatus = PROGRAM_STATES[state];
      if (entry.agent === 'codex' && state === 'working') entry.codexReview?.turnStarted();
      if (entry.codexActivity) entry.codexActivity.oscAt = Date.now();
      continue;
    }
    if (!entry.agent) continue;
    if (code === '9') {
      const state = /^4;([0-4])(?:;\d+)?$/.exec(value)?.[1];
      if (state) entry.titleStatus = PROGRESS_STATES[Number(state)];
    } else {
      const title = value.trim();
      if (!title || /(?:^|[\\/])(?:cmd|powershell|pwsh)\.exe(?:\s|$)/i.test(title)) continue;
      if (/^\[\s*[!.]\s*\]\s*Action Required\b/i.test(title)) entry.titleStatus = 'blocked';
      else if (/^Starting\b/i.test(title)) entry.titleStatus = 'starting';
      else entry.titleStatus = WORKING_TITLE.test(title) || /^(?:Working|Thinking)\b/i.test(title) ? 'working' : 'idle';
      if (entry.agent === 'claude' && replyToProbe) {
        const status = entry.titleStatus === 'working' ? 'working' : /(?:^|\s)✳(?:\s|$)/u.test(title) ? 'idle' : null;
        const at = Date.now();
        entry.hookTitle = status ? { status, at, since: entry.hookTitle?.status === status ? entry.hookTitle.since : at } : null;
      }
    }
    if (entry.agent === 'codex' && entry.titleStatus === 'working') entry.codexReview?.turnStarted();
  }
  entry.oscTail = output.slice(-4110).match(/\x1b(?:\][^\x07\x1b]*\x1b?)?$/)?.[0] ?? '';
}

// A fresh Codex session can spin while it connects to MCP servers with an
// empty composer. Arm its PTY activity indicator after the first submission.
function trackCodexInput(entry, data) {
  const input = entry.codexInput;
  if (!input || (input.submitted && !entry.codexActivity)) return;
  if (/^(?:\r|\n|\x1b\[13(?:;1)?u)$/.test(data)) {
    const submitsDraft = input.hasDraft;
    input.hasDraft = false;
    if (submitsDraft) {
      input.submitted = true;
      if (entry.codexActivity) entry.codexActivity.submittedAt = Date.now();
      entry.reportStatus?.(agentStatus(entry));
    }
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

const codexActivityFor = sessionId => sessionId
  ? { sessionId, startedAt: Date.now(), oscAt: 0, submittedAt: 0, turn: null }
  : null;

// CLI-native image paste reads from the same Windows clipboard as ezShell.
const WINDOWS_IMAGE_PASTE = { codex: '\x16', claude: '\x1bv' };

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

const processName = name => name.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, '');
const appRuntime = processName(process.execPath);

async function antigravityConversationIsCurrent(root, sessionId, startedAt, platform) {
  if (!root || !SESSION_ID.test(sessionId) || !(startedAt > 0)) return false;
  const directory = path.join(root, sessionId);
  const pathKey = value => platform === 'win32' ? value.toLowerCase() : value;
  try {
    const [stat, resolved] = await Promise.all([fs.promises.lstat(directory), fs.promises.realpath(directory)]);
    if (!stat.isDirectory() || pathKey(resolved) !== pathKey(directory)) return false;
    if ((stat.birthtimeMs || stat.mtimeMs) > startedAt) return true;
    // Resuming can append to an older transcript without updating the parent directory.
    const transcript = await openAntigravityTranscript(root, sessionId);
    if (!transcript) return false;
    await transcript.handle.close();
    return transcript.stat.mtimeMs > startedAt;
  } catch { return false; }
}

/**
 * Ends whole process trees at once and waits (a quit that installs an update). Closing the terminal
 * alone does not reach the agents: node-pty ends the console's processes asynchronously, after the app
 * has already gone, so an agent kept running and its message MCP (this app's exe) held the install
 * folder. The installer then failed with "Failed to uninstall old application files: 2".
 */
function killProcessTreesSync(pids, platform = process.platform) {
  if (pids.length === 0) return;
  try {
    if (platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', ...pids.flatMap(pid => ['/PID', String(pid)])], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } else {
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    }
  } catch { /* some were already gone: taskkill exits non-zero */ }
}

/**
 * @param {object} deps
 * @param {(file: string, args: string[], options: object) => object} deps.spawn node-pty's spawn
 * @param {(channel: string, payload: object) => void} deps.send to the main window
 */
function createLocalShells({
  spawn, send, agents, shell = defaultShell(), cwd = os.homedir(), env = process.env,
  platform = process.platform, processTree = () => getProcessTree(platform), processAlive = isProcessAlive,
  timedProcessTree = () => processList({ platform }), commandLine = pid => processCommandLine(pid, { platform }),
  readClaudeSessions, onInboxDraftBlocked, antigravityRoot = antigravityBrainRoot(),
  killTrees = pids => killProcessTreesSync(pids, platform),
  stopDevelopmentProcess = pty => stopDeveloperTree(pty, platform, processAlive), waitDevelopmentPort = waitDeveloperPort
}) {
  const shells = new Map();
  let nextId = 1;
  let pendingProcessTree;
  let pendingTimedTree;
  let claudeScan;
  const claudeChecks = new Map();

  function readAgentProcesses() {
    pendingProcessTree ??= Promise.resolve().then(processTree).finally(() => { pendingProcessTree = undefined; });
    return pendingProcessTree;
  }

  function readTimedProcesses() {
    pendingTimedTree ??= Promise.resolve().then(timedProcessTree).finally(() => { pendingTimedTree = undefined; });
    return pendingTimedTree;
  }

  const hasAgent = entry => Boolean(entry?.agent && !entry.exited && (!entry.externalAgent || processAlive(entry.externalAgent.pid)));

  function publishHookStatus(entry, before) {
    const status = agentStatus(entry);
    entry.reportStatus?.(status);
    if (status === before) return;
    entry.activeAt = Date.now();
    entry.inbox?.kick();
  }

  function clearHookTimer(entry) {
    clearTimeout(entry.hookTimer);
    entry.hookTimerAt = null;
  }

  function clearCodexReview(entry) {
    entry.codexReview?.close();
    entry.codexReview = null;
  }

  const entryAgentId = entry => entry.externalAgent?.id ?? entry.registration?.env?.EZSHELL_AGENT_ID;
  const codexAttached = entry => hasAgent(entry) && entry.agent === 'codex' && agents?.hasConnectedAgent?.(entryAgentId(entry));

  function startCodexReview(id, entry) {
    const mode = agents?.codexHookMode?.();
    if (!injectCodexHooks(mode) || (entry.agent && entry.agent !== 'codex')) return;
    clearCodexReview(entry);
    let projectHooks;
    entry.codexReview = observeCodexHookReview({
      cols: entry.cols, rows: entry.rows,
      projectHooks: () => projectHooks ??= codexProjectHooksPossible(entry.reportedDirectory ?? entry.launchDirectory),
      onReviewChange: review => send('local-shell-codex-hook-review', { id, review }),
      mayDecline: () => codexAttached(entry) && agents.codexHookMode() === mode,
      onDecline: () => agents.setCodexHookMode?.('disabled') === true
    });
  }

  function reconcileHooks(entry) {
    if (!entry.hookState) return;
    const now = Date.now();
    const next = reconcileAgentHook(entry.hookState, {
      now, title: entry.hookTitle, screenBlocked: entry.screenApproval, interruptedAt: entry.userInterruptAt
    });
    if (next === entry.hookTimerAt) return;
    clearHookTimer(entry);
    if (next === null) return;
    entry.hookTimerAt = next;
    entry.hookTimer = setTimeout(() => {
      entry.hookTimerAt = null;
      if (!hasAgent(entry) || entry.sleeping) return;
      const before = agentStatus(entry);
      reconcileHooks(entry);
      publishHookStatus(entry, before);
    }, Math.max(1, next - now));
    entry.hookTimer.unref?.();
  }

  function observeInbox(id, entry) {
    const { createAgentInboxWake, supportsAntigravityInput } = require('./ipc/agentInboxWake.js');
    const antigravity = entry.agent === 'antigravity';
    if (antigravity && !supportsAntigravityInput) return;
    const pendingMessages = () => antigravity ? [] : agents.unreadFor?.(id) ?? [];
    // Read but not answered yet: a request the agent confirmed while busy and put off
    const unhandledMessages = () => antigravity ? [] : agents.unhandledFor?.(id) ?? [];
    entry.subagentInputLabels = new Set();
    entry.parentInput = target => !target || (!entry.subagentInputLabels.has(target) && !(entry.agent === 'codex' && target.startsWith('/root/')));
    const inbox = createAgentInboxWake({
      kind: entry.agent, cols: entry.cols, rows: entry.rows,
      pendingMessages,
      unhandledMessages,
      wakeRecovery: entry.inboxWakeRecovery ??= { blocked: false },
      messageSeenAt: id => agents.messageSeenAt?.(entryAgentId(entry), id),
      isHookWorking: () => hookStatus(entry.hookState) === 'working',
      parentInput: entry.parentInput,
      onApprovalChange(visible) {
        if (!hasAgent(entry)) return;
        const before = agentStatus(entry);
        entry.screenApproval = visible;
        reconcileHooks(entry);
        publishHookStatus(entry, before);
      },
      onDraftBlockChange(blocked) {
        if (shells.get(id) !== entry || entry.inbox !== inbox) return;
        entry.inboxDraftBlocked = blocked;
        send('local-shell-inbox-draft', { id, blocked });
        const agentId = entryAgentId(entry);
        if (blocked && agentId) onInboxDraftBlocked?.({ id: agentId, shellId: id, kind: 'inbox-draft' });
      },
      isWorking: () => {
        const status = agentStatus(entry);
        return status !== 'idle' && !(entry.externalAgent && status === 'unknown');
      },
      isRunningTask: () => agentStatus(entry) === 'working',
      // Nothing reported yet (a CLI just started): the wake waits for a still, empty composer instead
      isUnknown: () => agentStatus(entry) === 'unknown',
      isLive: () => shells.get(id)?.inbox === inbox && hasAgent(entry),
      isBlocked: () => (antigravity || hookStatus(entry.hookState)) ? agentStatus(entry) === 'blocked' : entry.reportedStatus === 'blocked',
      write(data) {
        if (!hasAgent(entry)) return false;
        // Pasting needs mail to announce; the Enter that submits a line already pasted does not (the
        // agent may have read and answered it meanwhile, and the line would stay in the composer)
        if (data !== '\r' && !pendingMessages().length && !unhandledMessages().length) return false;
        try {
          entry.pty.write(data);
          entry.activeAt = Date.now();
          trackCodexInput(entry, data);
          return true;
        } catch { return false; }
      },
      // A line the user sent from the chat view (no mail needed)
      rawWrite(data, trackInput = true) {
        if (!hasAgent(entry) || (antigravity && agentStatus(entry) !== 'idle')) return false;
        try {
          entry.pty.write(data);
          entry.activeAt = Date.now();
          if (trackInput) {
            entry.codexReview?.input(data, agents?.codexHookMode?.());
            trackCodexInput(entry, data);
          }
          return true;
        } catch { return false; }
      }
    });
    entry.inbox = inbox;
    inbox.setComposing(entry.composing);
    if (antigravity) return;
    // The model / effort picker of the usage line (agentPicker.js): keys only while the CLI's picker shows
    const { createAgentPicker } = require('./ipc/agentPicker.js');
    const writeAgentKeys = data => {
      if (!hasAgent(entry) || entry.inbox !== inbox) return false;
      try { entry.pty.write(data); return true; } catch { return false; }
    };
    // Claude's AskUserQuestion answered from the chat view's card (claudeQuestions.js): keys only while it shows
    entry.questions = null;
    if (entry.agent === 'claude') {
      const { createClaudeQuestionAnswerer } = require('./ipc/claudeQuestions.js');
      entry.questions = createClaudeQuestionAnswerer({
        lines: () => (entry.inbox === inbox ? inbox.screenLines() : []),
        appCursor: () => entry.inbox === inbox && inbox.applicationCursorKeys(),
        hold: value => inbox.setHeld(value),
        write: writeAgentKeys
      });
    }
    entry.picker = createAgentPicker({
      kind: entry.agent,
      lines: () => (entry.inbox === inbox ? inbox.screenLines() : []),
      appCursor: () => entry.inbox === inbox && inbox.applicationCursorKeys(),
      submit: text => (entry.inbox === inbox ? inbox.submitText(text, undefined, { strict: true }) : Promise.resolve({ ok: false, reason: 'not-agent' })),
      hold: value => inbox.setHeld(value),
      write: writeAgentKeys
    });
    if (entry.agent === 'codex') {
      const { createCodexSpeed } = require('./ipc/codexSpeed.js');
      entry.speedControl = createCodexSpeed({
        lines: () => inbox.screenLines(),
        submit: target => inbox.submitText(`/${target}`, undefined, { codexSpeed: target }),
        probe: () => inbox.submitText('/ultrafas', undefined, { codexSpeed: 'ultrafast', probe: true }),
        hold: value => inbox.setHeld(value),
        isLive: () => hasAgent(entry) && entry.inbox === inbox && shells.get(id) === entry
      });
    }
  }

  /**
   * Why the usage line's picker may not run now, or null. Only while the agent waits for input: a slash
   * command mid-task or at a prompt would land in that task or answer the question.
   */
  function pickerRefusal(entry) {
    if (!hasAgent(entry) || !entry.picker) return { ok: false, reason: 'not-agent' };
    const status = agentStatus(entry);
    if (status === 'blocked') return { ok: false, reason: 'approval' };
    if (status === 'working' || status === 'starting') return { ok: false, reason: 'working' };
    return null;
  }

  /**
   * Development runs only (`electron .`): when the picker was not found on the screen main keeps of the
   * agent, the console gets that screen and its size, to compare with what the pane shows (2026-11-20: a
   * Codex picker on the pane but "no picker" in the app). Never in an installed app: the screen holds the conversation.
   */
  function tracePickerMiss(entry, result) {
    if (!process.defaultApp || result?.ok || !['no-picker', 'changed'].includes(result?.reason)) return;
    const screen = entry.inbox?.screenLines() ?? [];
    console.warn(`[agentPicker] ${result.reason}: pty ${entry.cols}x${entry.rows}, screen ${screen.length} rows`);
    console.warn(screen.map((row, index) => `${String(index).padStart(2)}|${row}`).join('\n'));
  }

  function releaseExternalAgent(entry) {
    const binding = entry.externalAgent;
    if (!binding) return;
    clearInterval(binding.timer);
    clearHookTimer(entry);
    entry.inbox?.close();
    Object.assign(entry, {
      agent: undefined, reportStatus: undefined, externalAgent: undefined, inbox: undefined, picker: undefined, speedControl: undefined,
      codexInput: null, codexActivity: null, titleStatus: 'unknown', reportedStatus: null, pendingAntigravityStatus: null,
      screenApproval: false, chatInterrupts: 0, oscTail: '',
      hookState: null, hookTitle: null, userInterruptAt: undefined
    });
    return binding;
  }

  function finishExternalAgent(entry) {
    const binding = releaseExternalAgent(entry);
    binding?.onExit(binding.id);
  }

  function attachExternalAgent(id, entry, kind, pid, { agentId, setStatus, onExit, antigravity, allowWake, resumeId }) {
    if (shells.get(id) !== entry || entry.exited || !processAlive(pid)) return;
    let binding = entry.externalAgent;
    if (binding && !processAlive(binding.pid)) {
      finishExternalAgent(entry);
      binding = undefined;
    }
    if (entry.agent && (binding?.pid !== pid || entry.agent !== kind)) return;
    if (!binding) {
      const woken = allowWake ? entry.sleeping : null;
      binding = { id: woken ? woken.agentId : agentId, pid, onExit };
      if (woken) {
        clearTimeout(woken.timer);
        entry.sleeping = null;
        entry.activeAt = Date.now();
        send('local-shell-sleep', { id, sleeping: null });
      }
      entry.externalAgent = binding;
      entry.agent = kind;
      entry.codexInput = kind === 'codex' ? { hasDraft: false, submitted: false } : null;
      entry.codexActivity = kind === 'codex' ? codexActivityFor(woken?.sessionId ?? resumeId) : null;
      if (antigravity) {
        binding.antigravity = antigravity;
        binding.roleSessionId = antigravity.roleSessionId;
        entry.reportedStatus = entry.pendingAntigravityStatus ?? null;
        entry.pendingAntigravityStatus = null;
      } else {
        entry.oscTail = '';
        trackTerminalOsc(entry, entry.backlog, platform, false);
      }
      observeInbox(id, entry);
      entry.inbox?.writeOutput(entry.backlog + modeSequences(entry));
      binding.timer = setInterval(() => {
        if (!processAlive(pid)) finishExternalAgent(entry);
      }, AGENT_PROCESS_CHECK_MS);
      binding.timer.unref?.();
    }
    entry.reportStatus = status => reportShellStatus(entry, setStatus, status);
    const status = agentStatus(entry);
    return { shellId: id, agentId: binding.id, status, statusSource: agentStatusSource(entry, status) };
  }

  async function findAgentProcess({ pid, kind, shellId }) {
    const candidates = new Map();
    for (const [id, entry] of shells) {
      if (!entry.development && !entry.exited && (!entry.agent || entry.externalAgent) && entry.pty.pid > 0) candidates.set(entry.pty.pid, { id, entry });
    }
    if (!candidates.size) return;
    let processes;
    try {
      processes = await readAgentProcesses();
      // A shared snapshot may have begun before this agent's MCP process was started.
      if (!processes.has(pid)) processes = await readAgentProcesses();
      if (!processes.has(pid)) throw new Error('프로세스가 아직 검색되지 않았습니다.');
    } catch {
      throw new Error('에이전트 프로세스 계보를 확인할 수 없습니다. 다시 시도해 주세요.');
    }
    const antigravity = kind === 'antigravity';
    if (antigravity) {
      const helper = processes.get(pid);
      if (!helper) return;
      let executable = helper.executable;
      if (!executable && platform === 'linux') executable = await fs.promises.readlink(`/proc/${pid}/exe`).catch(() => null);
      if (!executable && platform === 'darwin') executable = helper.name;
      const imageKey = platform === 'win32' ? value => path.win32.normalize(value).toLowerCase() : value => value;
      if (!executable || imageKey(executable) !== imageKey(process.execPath)) return;
    }
    const visited = new Set();
    let cliPid;
    let codexLaunchPid;
    let runtimeAboveCli = false;
    let runtimePid;
    let statusShellSeen = false;
    for (let parent = processes.get(pid)?.parent; parent > 0 && !visited.has(parent); parent = processes.get(parent)?.parent) {
      visited.add(parent);
      const candidate = candidates.get(parent);
      if (!candidate) {
        const ancestor = processes.get(parent);
        if (!ancestor) return;
        const name = processName(ancestor.name);
        if (name === (antigravity ? 'agy' : kind)) {
          if (antigravity && cliPid) return;
          cliPid ??= parent;
          if (kind === 'codex') codexLaunchPid = parent;
        }
        // agy invokes the reporter through its status-line shell. A tool's extra process is a
        // different branch even when it inherited the PTY's token.
        if (antigravity && !cliPid) {
          if (name !== (platform === 'win32' ? 'cmd' : 'sh')) return;
          statusShellSeen = true;
        }
        if (name === 'node' || name === appRuntime) {
          runtimePid ??= parent;
          if (cliPid) runtimeAboveCli = true;
        }
        continue;
      }
      const { id, entry } = candidate;
      if (antigravity && platform === 'win32' && !statusShellSeen) return;
      const agentPid = antigravity ? cliPid : cliPid ?? runtimePid;
      if (agentPid && (shellId === undefined || id === shellId)) {
        return { id, entry, agentPid, ptyPid: parent, codexLaunchPid: runtimeAboveCli ? undefined : codexLaunchPid,
          agentStartedAt: processes.get(agentPid)?.startedAt, nativeCodex: kind === 'codex' && Boolean(cliPid) };
      }
      return;
    }
  }

  // Bind to the CLI ancestor, whose lifetime can be longer than any one MCP connection.
  async function bindAgentProcess(request) {
    const match = await findAgentProcess(request);
    if (!match) return;
    const { id, entry, agentPid, ptyPid, codexLaunchPid, agentStartedAt, nativeCodex } = match;
    // A UUID explicitly passed to the CLI can be looked up by filename. The picker and a
    // time-based transcript match do not identify the session of this process.
    let resumeId;
    if (codexLaunchPid === agentPid && !entry.sleeping) {
      const [exe, ...args] = words(await commandLine(codexLaunchPid));
      const [subcommand, sessionId] = args[0] === '--no-daemon' ? args.slice(1) : args;
      if (exe && processName(exe) === 'codex' && subcommand === 'resume' && SESSION_ID.test(sessionId ?? '')) {
        resumeId = sessionId.toLowerCase();
      }
    }
    return registration => {
      if (shells.get(id) !== entry || entry.exited || entry.pty.pid !== ptyPid || !processAlive(agentPid)) return;
      const existing = entry.externalAgent;
      const sameAgent = existing?.pid === agentPid && entry.agent === request.kind;
      const waking = !existing && entry.sleeping?.phase === 'waking' && entry.sleeping.kind === request.kind;
      if (entry.sleeping && !waking && !sameAgent) throw new Error('셸의 에이전트가 아직 깨어나지 않았습니다.');
      const existingId = waking ? entry.sleeping.agentId : sameAgent && existing.hadMcp ? existing.id : null;
      const sameLiveCli = Boolean(sameAgent && agentStartedAt > 0 && existing.mcpProcessStartedAt === agentStartedAt);
      if (existingId) registration.authorizeBinding(existingId, waking, sameLiveCli);
      else registration.authorizeBinding?.(null, false, false);
      // A CLI discovered through its own file has a provisional UI identity and no message lease.
      // The first MCP registration gets a new ID instead of authenticating that provisional ID by PID.
      const claudeSession = sameAgent ? existing.claudeSession : undefined;
      const codexRoleCwd = nativeCodex ? verifiedCodexRoleDirectory(entry, request.cwd, platform) : null;
      if (sameAgent && !existing.hadMcp) finishExternalAgent(entry);
      const attached = attachExternalAgent(id, entry, request.kind, agentPid, { ...registration, allowWake: waking, resumeId });
      if (!attached) return;
      const binding = entry.externalAgent;
      if (claudeSession) Object.assign(binding, { claudeSession, claudeProcessStartedAt: existing.claudeProcessStartedAt });
      binding.hadMcp = true;
      binding.mcpProcessStartedAt ??= agentStartedAt || undefined;
      const connection = {};
      binding.connection = connection;
      return {
        ...attached,
        ...(resumeId ? { resumeId } : {}),
        ...(codexRoleCwd ? { codexProcessStartedAt: agentStartedAt, codexRoleCwd } : {}),
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

  async function reportAntigravityStatus({ shellId, pid, status, sequence, isCurrent }) {
    const match = await findAgentProcess({ pid, kind: 'antigravity', shellId }).catch(() => null);
    if (!match || !isCurrent() || !processAlive(pid)) return false;
    const { id, entry, agentPid, ptyPid } = match;
    const previous = entry.externalAgent?.pid === agentPid ? entry.externalAgent : null;
    if (sequence <= (previous?.antigravity?.sequence ?? 0)) return false;
    let processStartedAt = previous?.antigravity?.processStartedAt;
    let roleSessionId = null;
    if (status.sessionId && status.sessionId !== previous?.roleSessionId) {
      processStartedAt ??= (await readTimedProcesses().catch(() => null))?.get(agentPid)?.startedAt || undefined;
      if (await antigravityConversationIsCurrent(antigravityRoot, status.sessionId, processStartedAt, platform)) {
        roleSessionId = status.sessionId;
      }
    }
    if (!isCurrent() || shells.get(id) !== entry || entry.pty.pid !== ptyPid ||
        entry.exited || !processAlive(pid) || !processAlive(agentPid)) return false;
    const binding = entry.externalAgent;
    if (entry.agent === 'antigravity' && binding?.pid === agentPid) {
      if (sequence <= binding.antigravity.sequence) return false;
      binding.antigravity = { cwd: status.cwd, status: status.status, sequence,
        processStartedAt: processStartedAt ?? binding.antigravity.processStartedAt };
      if (roleSessionId) binding.roleSessionId = roleSessionId;
      if (binding.roleSessionId) agents?.setVerifiedSession?.(binding.id, binding.roleSessionId);
      entry.reportStatus?.(agentStatus(entry));
      return true;
    }
    const antigravity = { cwd: status.cwd, status: status.status, sequence, processStartedAt, roleSessionId };
    return agents?.registerLocalAntigravity?.(status.cwd, registration =>
      attachExternalAgent(id, entry, 'antigravity', agentPid, { ...registration, antigravity }), roleSessionId) ?? false;
  }

  async function discoverLocalClaude() {
    const candidates = new Map();
    for (const [id, entry] of shells) {
      if (entry.development) continue;
      const pid = entry.pty.pid;
      if (entry.exited || entry.sleeping || !Number.isSafeInteger(pid) || pid <= 0 || (entry.agent && entry.agent !== 'claude')) continue;
      candidates.set(pid, { id, entry, ptyPid: pid });
    }
    if (!candidates.size) {
      claudeChecks.clear();
      return;
    }
    const sessions = new Map((await readClaudeSessions()).filter(session => processAlive(session.pid))
      .map(session => [`${session.pid}:${session.startedAt}:${session.processStartedAt ?? ''}`, session]));
    for (const [key, check] of claudeChecks) {
      if (!sessions.has(key) || (check && candidates.get(check.ptyPid)?.entry !== check.entry)) claudeChecks.delete(key);
    }
    const fresh = [...sessions].filter(([key]) => !claudeChecks.has(key));
    if (fresh.length) {
      const processes = await readTimedProcesses();
      const matchesProcessStart = session => {
        const startedAt = processes.get(session.pid)?.startedAt;
        if (!(startedAt > 0)) return false;
        return session.processStartedAt !== undefined
          ? Math.abs(startedAt - session.processStartedAt) <= CLAUDE_START_TOLERANCE_MS
          : session.startedAt >= startedAt - CLAUDE_START_TOLERANCE_MS && session.startedAt <= startedAt + CLAUDE_SESSION_DELAY_MS;
      };
      const sessionPids = new Set([...sessions.values()].filter(matchesProcessStart).map(session => session.pid));
      for (const { entry } of candidates.values()) {
        const binding = entry.externalAgent;
        const startedAt = processes.get(binding?.pid)?.startedAt;
        if (binding?.claudeProcessStartedAt && startedAt > 0 &&
            Math.abs(startedAt - binding.claudeProcessStartedAt) > CLAUDE_START_TOLERANCE_MS) {
          // The old PID belongs to a new process whose session must get a new logical agent.
          finishExternalAgent(entry);
        }
      }
      for (const [key, session] of fresh) {
        const process = processes.get(session.pid);
        if (!process) continue;
        claudeChecks.set(key, null);
        if (!sessionPids.has(session.pid) || !['claude', 'node', 'bun', appRuntime].includes(processName(process.name))) continue;
        let parent = process.parent;
        const visited = new Set([session.pid]);
        while (parent > 0 && !candidates.has(parent) && !sessionPids.has(parent) && !visited.has(parent)) {
          visited.add(parent);
          parent = processes.get(parent)?.parent;
        }
        // POSIX managed launches may exec Claude under the PTY's PID. Nested Claude sessions
        // belong to the parent CLI, even when that parent is also the PTY process.
        const direct = candidates.get(session.pid);
        const candidate = direct?.entry.registration ? direct : !sessionPids.has(parent) && candidates.get(parent);
        if (candidate && session.startedAt >= candidate.entry.openedAt) {
          claudeChecks.set(key, { ...candidate, startedAt: process.startedAt });
        }
      }
    }
    const matches = new Map();
    for (const [key, session] of sessions) {
      const check = claudeChecks.get(key);
      if (check) matches.set(check.id, matches.has(check.id) ? null : { ...check, session });
    }
    for (const match of matches.values()) {
      if (!match) continue;
      const { id, entry, ptyPid, startedAt, session } = match;
      if (shells.get(id) !== entry || entry.exited || entry.sleeping || entry.pty.pid !== ptyPid || !processAlive(session.pid)) continue;
      const managedId = entry.registration?.env.EZSHELL_AGENT_ID;
      if (managedId && entry.agent === 'claude') {
        if (entry.managedClaudePid && entry.managedClaudePid !== session.pid) continue;
        entry.managedClaudePid = session.pid;
        agents?.setVerifiedSession?.(managedId, session.sessionId);
        continue;
      }
      if (hasAgent(entry) && entry.externalAgent?.pid !== session.pid) continue;
      // MCP may have connected while the process tree was being read.
      if (entry.externalAgent?.pid === session.pid) {
        entry.externalAgent.claudeSession = session;
        entry.externalAgent.claudeProcessStartedAt = startedAt;
        agents?.setVerifiedSession?.(entry.externalAgent.id, session.sessionId);
        continue;
      }
      agents.registerLocalClaude(session, registration => {
        const attached = attachExternalAgent(id, entry, 'claude', session.pid, registration);
        if (attached) Object.assign(entry.externalAgent, { claudeSession: session, claudeProcessStartedAt: startedAt });
        return attached;
      });
    }
  }

  if (readClaudeSessions && agents?.registerLocalClaude) {
    setInterval(() => {
      claudeScan ??= discoverLocalClaude().catch(() => {}).finally(() => { claudeScan = undefined; });
    }, AGENT_PROCESS_CHECK_MS).unref?.();
  }

  function open({ cols, rows, cwd: directory, agent, resume, replacementFor, restoring } = {}) {
    const previous = replacementFor === undefined ? undefined : shells.get(replacementFor);
    if (replacementFor !== undefined) {
      if (!previous || !resume) throw new Error('바꿀 셸을 찾지 못했습니다.');
      if ([...shells.values()].some(entry => entry.replacementFor === replacementFor)) throw new Error('이 칸의 셸을 바꾸는 중입니다.');
    }
    const workingDirectory = directory === undefined ? previous?.launchDirectory ?? cwd : requireLocalDirectory(directory);
    const launchIdentity = platform === 'win32' ? launchedDirectoryIdentity(workingDirectory) : null;
    const id = `local:${nextId++}`;
    const automatic = restoring === true;
    const codexHooks = agent === 'codex' && injectCodexHooks(agents?.codexHookMode?.(), automatic);
    const args = shellArgs(shell, agent, platform, Boolean(agents), resume, codexHooks, automatic);
    const columns = previous?.cols ?? size(cols, 80);
    const lines = previous?.rows ?? size(rows, 24);
    const shellEnv = localTerminalEnvironment(env, platform);
    // A resumed Codex writes on in its old session file: the usage watcher finds it by this id
    const registeredAgent = agent === 'antigravity' ? undefined : agent;
    const resumeId = resume && SESSION_ID.test(resume) ? resume.toLowerCase() : null;
    const registration = registeredAgent && agents?.register(registeredAgent, id, workingDirectory, shellEnv, resumeId);
    // The shell's own token authenticates status reports from a CLI started inside it.
    const shellUsageEnv = agents?.registerShell?.(id) ?? {};
    const openedAt = Date.now();
    let pty;
    try {
      if (agent === 'antigravity' && !shellUsageEnv.EZSHELL_ANTIGRAVITY_SETTINGS) {
        throw new Error('Antigravity 상태 연결을 시작할 수 없습니다.');
      }
      pty = spawn(shell.file, args, {
        name: TERMINAL_TYPE,
        cols: columns,
        rows: lines,
        cwd: launchIdentity?.directory ?? workingDirectory,
        env: { ...(registration?.env ?? shellEnv), ...shellUsageEnv }
      });
    } catch (error) {
      agents?.forgetShell?.(id);
      registration?.close();
      throw error;
    }
    const codexInput = agent === 'codex' ? { hasDraft: false, submitted: false } : null;
    const entry = {
      pty, agent: registeredAgent, registration, codexInput, cols: columns, rows: lines, composing: false, replacementFor,
      codexActivity: codexInput ? codexActivityFor(resumeId) : null,
      wakeMcp: Boolean(shellUsageEnv.EZSHELL_AGENT_WAKE_MCP_CONFIG),
      // For a window that reloads and takes the shell back as a tab (`list`)
      cwd: directory === undefined ? previous?.cwd ?? null : workingDirectory,
      launchDirectory: workingDirectory, launchIdentity, reportedDirectory: null,
      reportStatus: status => reportShellStatus(entry, registration?.setStatus, status),
      backlog: '', modes: {}, modeTail: '', exited: false, exitCode: null, titleStatus: 'unknown', reportedStatus: null, screenApproval: false, chatInterrupts: 0, oscTail: '',
      // Last sign of work (status, typing, a line sent to the agent) and the sleep it may be in (agentIdle.js)
      activeAt: openedAt, openedAt, sleeping: null
    };
    const nonce = shellUsageEnv.EZSHELL_CODEX_HOOK_NONCE;
    if (!agent && platform === 'win32' && nonce) {
      entry.codexLaunchMarker = value => {
        if (value === `ezshell-codex-hooks=start;${nonce}`) startCodexReview(id, entry);
        else if (value === `ezshell-codex-hooks=end;${nonce}`) clearCodexReview(entry);
      };
    }
    if (codexHooks) startCodexReview(id, entry);
    if (registration) observeInbox(id, entry);
    shells.set(id, entry);
    pty.onData((data) => {
      if (!entry.exited) {
        trackTerminalOsc(entry, data, platform);
        reconcileHooks(entry);
        const status = agentStatus(entry);
        entry.reportStatus?.(status);
        if (entry.agent && status !== 'idle') entry.activeAt = Date.now();
      }
      trackTerminalModes(entry, data);
      entry.codexReview?.write(data);
      entry.inbox?.writeOutput(data);
      entry.backlog += data;
      // Trimmed only now and then: cutting on every chunk copies the whole backlog each time
      if (entry.backlog.length > BACKLOG_CHARS * 2) entry.backlog = entry.backlog.slice(-BACKLOG_CHARS);
      send('local-shell-data', { id, data });
    });
    pty.onExit(({ exitCode }) => {
      entry.exited = true;
      clearHookTimer(entry);
      clearCodexReview(entry);
      entry.exitCode = exitCode;
      endSleep(id, entry);
      entry.inbox?.close();
      finishExternalAgent(entry);
      if (registration?.finish) registration.finish(exitCode);
      else registration?.close();
      send('local-shell-exit', { id, exitCode });
    });
    return { id, name: shell.name, ...(directory === undefined ? {} : { cwd: workingDirectory }) };
  }

  function setDevelopment(id, entry, patch) {
    entry.development = { ...entry.development, ...patch };
    send('local-shell-development-state', { id, development: entry.development });
  }

  function launchDevelopment(id, entry) {
    const task = entry.developmentTask;
    task.onEvent?.({ type: 'start', shellId: id, phase: task.preparation ? 'prepare' : 'server' });
    entry.developmentInterrupted = false;
    setDevelopment(id, entry, { status: 'starting', url: null, exitCode: null });
    const launch = new AbortController();
    const { signal } = launch;
    const exit = Promise.withResolvers();
    entry.developmentLaunch = launch;
    entry.developmentExit = exit.promise;
    entry.pty = null;
    entry.exited = false;
    entry.exitCode = null;
    let runtime = task;
    const active = () => entry.developmentLaunch === launch && !entry.exited;
    const stopAction = () => entry.developmentAction ?? (entry.developmentInterrupted || signal.aborted ? 'stop' : undefined);

    function finish(exitCode, phase, failed = false) {
      if (!active()) return;
      entry.exited = true;
      entry.exitCode = exitCode;
      disposeDevelopmentTask(runtime, !failed && !stopAction() ? exitCode : null);
      exit.resolve();
      if (shells.get(id) !== entry) return;
      task.onEvent?.({ type: 'exit', shellId: id, exitCode, phase, failed, action: stopAction() });
      if (!entry.developmentAction) setDevelopment(id, entry, { status: 'exited', exitCode });
      send('local-shell-exit', { id, exitCode });
    }

    function forward(data, phase) {
      if (!data || shells.get(id) !== entry) return;
      entry.backlog = (entry.backlog + data).slice(-BACKLOG_CHARS);
      send('local-shell-data', { id, data });
      task.onEvent?.({ type: 'data', shellId: id, data, phase });
    }

    async function startAfterPreparation(prepared) {
      entry.pty = null;
      task.onEvent?.({ type: 'prepared', shellId: id });
      try {
        runtime = await task.preparation.finish(signal, prepared);
        if (signal.aborted || shells.get(id) !== entry) { finish(null, 'launch'); return; }
        launchProcess(runtime, 'server');
      } catch (error) {
        if (!signal.aborted) forward(`\r\nERROR ${error.code ? 'Tomcat 실행 폴더를 준비하지 못했습니다.' : error.message}\r\n`, 'launch');
        finish(null, 'launch', true);
      }
    }

    async function prepareInMain() {
      try {
        const prepared = await task.preparation.run({ signal, env: developmentEnvironment(env, task, platform), log: data => forward(data, 'prepare') });
        if (stopAction() || shells.get(id) !== entry) finish(null, 'prepare');
        else await startAfterPreparation(prepared);
      } catch (error) {
        if (signal.aborted) { finish(null, 'prepare'); return; }
        const diagnostics = typeof error.stderr === 'string' ? error.stderr.trim() : '';
        const message = diagnostics ? 'javac 컴파일에 실패했습니다.' : error.code ? '이클립스식 빌드를 실행하지 못했습니다.' : error.message;
        forward(`\r\nERROR ${message}\r\n${diagnostics ? diagnostics.replace(/\r?\n/g, '\r\n') + '\r\n' : ''}`, 'prepare');
        finish(Number.isInteger(error.code) ? error.code : 1, 'prepare', true);
      }
    }

    function launchProcess(currentTask, phase) {
      const taskEnv = developmentEnvironment(env, currentTask, platform);
      const decoder = createLogDecoder(currentTask.logEncoding);
      const pty = spawn(shell.file, developmentShellArgs(shell, currentTask, platform), {
        name: TERMINAL_TYPE, cols: entry.cols, rows: entry.rows, cwd: entry.launchDirectory, env: taskEnv,
        ...(platform !== 'win32' && currentTask.logEncoding !== undefined && { encoding: null })
      });
      entry.pty = pty;
      let fragment = '';
      pty.onData(raw => {
        if (!active() || entry.pty !== pty) return;
        const decoded = decoder.write(raw);
        const data = currentTask.filterOutput ? currentTask.filterOutput(decoded) : decoded;
        forward(data, phase);
        if (phase !== 'server' || entry.development.url) return;
        const lines = (fragment + data).split(/[\r\n]+/);
        fragment = lines.pop().slice(-2048);
        const url = developmentAddress(lines);
        if (url) setDevelopment(id, entry, { url });
      });
      pty.onExit(({ exitCode }) => {
        if (!active() || entry.pty !== pty) return;
        const remaining = decoder.finish();
        forward(currentTask.filterOutput ? currentTask.filterOutput(remaining, true) : remaining, phase);
        if (phase === 'prepare' && exitCode === 0 && !stopAction() && shells.get(id) === entry) void startAfterPreparation();
        else finish(exitCode, phase);
      });
      if (phase === 'server' && active()) {
        if (currentTask.hotReload || currentTask.hotReloadFailure || currentTask.expectedUrl) {
          (currentTask.onEvent ?? task.onEvent)?.({ type: 'launched', shellId: id, pid: pty.pid, env: taskEnv });
        }
        setDevelopment(id, entry, { status: 'running', ...(currentTask.expectedUrl && { url: currentTask.expectedUrl }) });
      }
    }

    try {
      if (task.launchNotice) forward(`\r\n${task.launchNotice}\r\n`, 'launch');
      if (task.preparation?.run) void prepareInMain();
      else if (task.preparation) launchProcess({ cwd: task.cwd, command: task.preparation.command, env: task.env, javaHome: task.javaHome,
        logEncoding: task.logEncoding, ...task.preparation.launch }, 'prepare');
      else launchProcess(task, 'server');
    } catch (error) {
      finish(null, task.preparation ? 'prepare' : 'server', true);
      throw error;
    }
  }

  let developmentClosing = false;
  function disposeDevelopmentTask(task, exitCode = null) {
    if (task?.cleanup) trackRunCleanup(Promise.resolve().then(() => task.cleanup(exitCode)));
  }

  async function openDevelopmentTask(task, { cols, rows }, allowed = () => true) {
    if (developmentClosing) {
      disposeDevelopmentTask(task);
      throw new Error('앱이 종료되는 중입니다.');
    }
    const label = task.label ?? (task.relative === '.' ? task.name : `${task.name} · ${path.basename(task.cwd)}`);
    const normalized = value => platform === 'win32' ? value.toLowerCase() : value;
    for (const [id, entry] of shells) {
      const running = entry.developmentTask;
      if (running?.id === task.id && normalized(running.cwd) === normalized(task.cwd)) {
        if (entry.exited && !entry.developmentAction) await changeDevelopmentTask(id, task.id, 'restart', allowed, () => task);
        else disposeDevelopmentTask(task);
        return { id, name: shell.name, cwd: task.cwd, label, development: entry.development };
      }
    }
    let directory;
    try {
      directory = requireLocalDirectory(task.cwd);
      if (!allowed()) throw new Error('실행 권한을 다시 확인해 주세요.');
    } catch (error) { disposeDevelopmentTask(task); throw error; }
    const id = `local:${nextId++}`;
    const entry = {
      cwd: directory, launchDirectory: directory, cols: size(cols, 80), rows: size(rows, 24),
      developmentTask: task, development: { taskId: task.id, name: task.name, label },
      backlog: '', exited: true, exitCode: null
    };
    shells.set(id, entry);
    try { launchDevelopment(id, entry) }
    catch (error) { close(id); throw error }
    return { id, name: shell.name, cwd: directory, label, development: entry.development };
  }

  function stopDevelopmentEntry(entry) {
    entry.developmentLaunch?.abort();
    return entry.developmentStop ??= Promise.resolve().then(() => entry.pty && stopDevelopmentProcess(entry.pty))
      .finally(() => { entry.developmentStop = null });
  }

  function drainDevelopmentTasks() {
    developmentClosing = true;
    const active = [...shells.values()].filter(entry => entry.development && !entry.exited);
    if (!active.length) return waitRunCleanup();
    return Promise.allSettled(active.map(async entry => {
      await stopDevelopmentEntry(entry).catch(() => {});
      await entry.developmentExit;
    })).then(waitRunCleanup);
  }

  async function changeDevelopmentTask(id, taskId, action, allowed = () => true, prepare) {
    const entry = shells.get(id);
    if (!entry?.developmentTask || entry.developmentTask.id !== taskId || !['restart', 'stop'].includes(action)) {
      throw new Error('기동한 개발 서버를 찾을 수 없습니다.');
    }
    if (!allowed()) throw new Error('먼저 잠금을 해제해 주세요.');
    if (developmentClosing && action === 'restart') throw new Error('앱이 종료되는 중입니다.');
    if (action === 'restart' && entry.developmentTask.onEvent && !prepare) throw new Error('실행 구성에서 재기동해 주세요.');
    if (entry.developmentAction) throw new Error('개발 서버를 전환하는 중입니다.');
    const previousLaunch = entry.developmentLaunch;
    entry.developmentAction = action;
    try {
      if (!entry.exited) {
        setDevelopment(id, entry, { status: 'stopping' });
        await stopDevelopmentEntry(entry);
        if (shells.get(id) !== entry) throw new Error('개발 서버 탭이 닫혔습니다.');
        await Promise.race([entry.developmentExit, delay(4500)]);
        if (!entry.exited) throw new Error('개발 서버의 종료를 확인하지 못했습니다.');
      }
      if (action === 'restart') {
        await waitDevelopmentPort(entry.development.url);
        if (developmentClosing) throw new Error('앱이 종료되는 중입니다.');
        if (shells.get(id) !== entry) throw new Error('개발 서버 탭이 닫혔습니다.');
        if (!allowed()) throw new Error('먼저 잠금을 해제해 주세요.');
        if (prepare) {
          const task = await prepare();
          if (developmentClosing || !allowed() || shells.get(id) !== entry || task.id !== taskId) {
            disposeDevelopmentTask(task);
            throw new Error('실행 구성이 바뀌었습니다.');
          }
          try { entry.cwd = entry.launchDirectory = requireLocalDirectory(task.cwd); }
          catch (error) { disposeDevelopmentTask(task); throw error; }
          entry.developmentTask = task;
          if (task.label) setDevelopment(id, entry, { name: task.name, label: task.label });
        }
        // ConPTY starts the new console with ED 2 and CUP home. Move the old viewport into
        // scrollback first so its logs and this divider survive the new console's redraw.
        const data = `\x1b[?1049l\x1b[?6l\x1b[r\x1b[0m\x1b[${entry.rows};1H\r\n── 개발 서버 재기동 ──${'\r\n'.repeat(entry.rows)}`;
        entry.backlog = (entry.backlog + data).slice(-BACKLOG_CHARS);
        send('local-shell-data', { id, data });
        launchDevelopment(id, entry);
      }
    } finally {
      entry.developmentAction = undefined;
      if (shells.get(id) === entry && entry.developmentLaunch === previousLaunch && entry.development.status !== 'running') {
        setDevelopment(id, entry, { status: entry.exited ? 'exited' : 'running', exitCode: entry.exitCode });
      }
    }
  }

  /** What a tab needs to draw itself again; null when the shell is gone */
  function attach(id) {
    const entry = shells.get(id);
    if (!entry) return null;
    return { backlog: entry.backlog.slice(-BACKLOG_CHARS), exited: entry.exited, exitCode: entry.exitCode,
      ...(entry.inboxDraftBlocked && { inboxDraftBlocked: true }), ...(entry.development && { development: entry.development }) };
  }

  function write(id, data) {
    const entry = shells.get(id);
    if (!entry || entry.exited || typeof data !== 'string' || data.length > MAX_WRITE_CHARS) return;
    // Asleep: the pane is covered and the shell waits for the resume line; keys would go before it
    if (entry.sleeping) return;
    entry.activeAt = Date.now();
    if (data === '\x1b' || data === '\x03') entry.userInterruptAt = entry.activeAt;
    if (entry.inbox?.deferProbeInput(data)) return;
    if (data === '\x03' && entry.developmentTask?.onEvent) {
      entry.developmentInterrupted = true;
      entry.developmentTask.onEvent({ type: 'interrupt', shellId: id });
      if (!entry.pty) entry.developmentLaunch?.abort();
    }
    if (!entry.inbox) (entry.inboxWakeRecovery ??= { blocked: false }).blocked = true;
    entry.inbox?.userInput(data);
    entry.pty?.write(data);
    const reviewing = entry.codexReview?.review;
    entry.codexReview?.input(data, agents?.codexHookMode?.());
    if (!reviewing) trackCodexInput(entry, data);
  }

  function pasteClipboardImage(id) {
    const entry = shells.get(id);
    if (platform !== 'win32' || !hasAgent(entry) || !Object.hasOwn(WINDOWS_IMAGE_PASTE, entry.agent)) return false;
    write(id, WINDOWS_IMAGE_PASTE[entry.agent]);
    if (entry.codexInput) entry.codexInput.hasDraft = true;
    return true;
  }

  function resize(id, cols, rows) {
    const entry = shells.get(id);
    if (!entry || (entry.exited && !entry.development)) return;
    try {
      const columns = size(cols, 80);
      const lines = size(rows, 24);
      if (!entry.exited) entry.pty?.resize(columns, lines);
      entry.cols = columns;
      entry.rows = lines;
      entry.inbox?.resize(columns, lines);
      entry.codexReview?.resize(columns, lines);
    } catch {
      // The shell ended between the check and the call
    }
  }

  function close(id) {
    const entry = shells.get(id);
    if (!entry) return;
    shells.delete(id);
    if (entry.development) {
      entry.developmentTask.onEvent?.({ type: 'closed', shellId: id, wasRunning: !entry.exited });
      send('local-shell-development-state', { id, development: null });
      if (!entry.exited) {
        trackRunCleanup(stopDevelopmentEntry(entry).catch(() => {
          try { entry.pty?.kill() } catch { /* already gone */ }
        }).then(() => entry.developmentExit));
      }
      return;
    }
    clearHookTimer(entry);
    clearCodexReview(entry);
    endSleep(id, entry);
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

  /** The shell went away (closed, exited) while its agent slept: that agent has ended */
  function endSleep(id, entry, { notify = false } = {}) {
    const sleeping = entry.sleeping;
    if (!sleeping) return;
    clearTimeout(sleeping.timer);
    entry.sleeping = null;
    agents?.cancelSleep?.(sleeping.agentId, { ended: true });
    if (notify) send('local-shell-sleep', { id, sleeping: null });
  }

  function killProcessTree(pid) {
    try {
      if (platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else process.kill(pid, 'SIGTERM');
    } catch { /* already gone */ }
  }

  /**
   * Closes an idle agent typed into this shell and keeps the shell for resuming it (agentIdle.js). Only
   * while it waits with an empty composer: `/exit` goes in like a chat line, which checks both.
   */
  async function sleep(id, { sessionId, flags = [] } = {}) {
    const entry = shells.get(id);
    const binding = entry?.externalAgent;
    // Sleeping agents can be woken by their inbox, which needs a message MCP registration.
    if (!binding?.hadMcp || !hasAgent(entry) || entry.sleeping || !entry.inbox) return { ok: false, reason: 'not-agent' };
    if (agentStatus(entry) !== 'idle') return { ok: false, reason: 'working' };
    if (!SESSION_ID.test(sessionId ?? '')) return { ok: false, reason: 'no-session' };
    const kind = entry.agent;
    const sleeping = { kind, agentId: binding.id, sessionId: sessionId.toLowerCase(), flags, phase: 'closing', since: Date.now(), timer: null };
    entry.sleeping = sleeping;
    agents?.sleep?.(binding.id, sleeping.sessionId);
    const result = await entry.inbox.submitText(kind === 'codex' ? '/quit' : '/exit', undefined, { strict: true });
    if (!result.ok) {
      if (entry.sleeping === sleeping) entry.sleeping = null;
      agents?.cancelSleep?.(binding.id, { ended: false });
      return result;
    }
    for (const until = Date.now() + SLEEP_EXIT_MS; processAlive(binding.pid) && Date.now() < until;) await delay(200);
    if (processAlive(binding.pid)) {
      killProcessTree(binding.pid);
      for (const until = Date.now() + 3000; processAlive(binding.pid) && Date.now() < until;) await delay(200);
    }
    if (shells.get(id) !== entry || entry.sleeping !== sleeping || entry.exited) return { ok: false, reason: 'changed' };
    if (entry.externalAgent === binding) finishExternalAgent(entry);
    sleeping.phase = 'asleep';
    send('local-shell-sleep', { id, sleeping: { kind, since: sleeping.since } });
    return { ok: true };
  }

  /** Resumes the sleeping agent in its shell; it is awake again once its messages MCP binds it */
  function wake(id) {
    const entry = shells.get(id);
    const sleeping = entry?.sleeping;
    if (!sleeping || entry.exited) return { ok: false, reason: 'not-asleep' };
    if (sleeping.phase === 'waking') return { ok: true };
    if (sleeping.phase !== 'asleep') return { ok: false, reason: 'busy' };
    let line;
    try {
      line = resumeCommand(sleeping.kind, sleeping.sessionId, sleeping.flags);
      if (entry.wakeMcp) {
        const shellVar = platform === 'win32' ? '$env:' : '$';
        if (sleeping.kind === 'claude') {
          line += ` --mcp-config "${shellVar}EZSHELL_AGENT_WAKE_MCP_CONFIG"`;
        } else {
          line += [
            ` -c "mcp_servers.ezshell-cli-mcp.command=${shellVar}EZSHELL_CLI_EXE"`,
            ` -c "mcp_servers.ezshell-cli-mcp.args=['-e','require(process.env.EZSHELL_AGENT_MCP_SCRIPT).run()']"`,
            ` -c "mcp_servers.ezshell-cli-mcp.env.ELECTRON_RUN_AS_NODE='1'"`,
            ` -c "mcp_servers.ezshell-cli-mcp.env.EZSHELL_AGENT_WAKE_KIND='codex'"`,
            ` -c "mcp_servers.ezshell-cli-mcp.env_vars=['EZSHELL_AGENT_PIPE','EZSHELL_SHELL_TOKEN','EZSHELL_AGENT_MCP_SCRIPT']"`
          ].join('');
        }
      }
      if (sleeping.kind === 'codex') {
        if (platform === 'win32') line = `& { $__ezShellAutomaticCodex = $true; ${line} }`;
        else if (injectCodexHooks(agents?.codexHookMode?.(), true)) line += ' ' + quoteCodexHookArgs();
      }
    } catch {
      endSleep(id, entry, { notify: true });
      return { ok: false, reason: 'no-session' };
    }
    sleeping.phase = 'waking';
    try {
      entry.pty.write(line + '\r');
    } catch {
      endSleep(id, entry, { notify: true });
      return { ok: false, reason: 'write-failed' };
    }
    sleeping.timer = setTimeout(() => {
      if (entry.sleeping !== sleeping) return;
      endSleep(id, entry);
      send('local-shell-sleep', { id, sleeping: null, failed: true });
    }, WAKE_BIND_MS);
    sleeping.timer.unref?.();
    send('local-shell-sleep', { id, sleeping: { kind: sleeping.kind, since: sleeping.since, waking: true } });
    return { ok: true };
  }

  /** The user keeps the shell as a terminal: the sleeping agent has ended */
  function stayAwake(id) {
    const entry = shells.get(id);
    if (entry?.sleeping?.phase !== 'asleep') return false;
    endSleep(id, entry, { notify: true });
    return true;
  }

  /** killTrees: the app quits to install an update, so nothing started in a shell may outlive it */
  function closeAll({ killTrees: endTrees = false } = {}) {
    const live = [...shells.values()].filter(entry => !entry.exited && Number.isInteger(entry.pty?.pid) && entry.pty.pid > 0);
    const pids = live.filter(entry => endTrees || (platform === 'win32' && entry.development)).map(entry => entry.pty.pid);
    if (pids.length > 0) killTrees(pids);
    if (platform !== 'win32') for (const entry of live.filter(entry => entry.development)) {
      try { process.kill(-entry.pty.pid, 'SIGTERM') } catch { /* already gone */ }
    }
    for (const id of [...shells.keys()]) close(id);
  }

  async function processDirectory(id) {
    const entry = shells.get(id);
    if (!entry) return null;
    const pty = entry.pty;
    const pid = pty?.pid;
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
        if (folder && path.isAbsolute(folder) && shells.get(id) === entry && entry.pty === pty && !entry.exited) return folder;
      } catch { /* keep the most recent reported or launch directory */ }
    }
    return null;
  }

  async function currentDirectory(id) {
    const entry = shells.get(id);
    return await processDirectory(id) ?? (entry && shells.get(id) === entry ? entry.reportedDirectory ?? entry.launchDirectory : null);
  }

  async function runAuthorityDirectory(id) {
    if (platform !== 'win32') return processDirectory(id);
    const entry = shells.get(id);
    const identity = entry?.launchIdentity;
    const pid = entry?.pty?.pid;
    if (!identity || entry.exited || !Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) return null;
    // ConPTY supplies the launch directory but has no live CWD query. Display OSCs never grant authority.
    const current = launchedDirectoryIdentity(identity.directory);
    return current && current.dev === identity.dev && current.ino === identity.ino ? identity.directory : null;
  }

  return {
    open, openDevelopmentTask, changeDevelopmentTask, drainDevelopmentTasks, attach, write, pasteClipboardImage, resize, close, closeAll, bindAgentProcess, reportAntigravityStatus, currentDirectory, runAuthorityDirectory,
    /**
     * Every shell, oldest first. The shells outlive their tabs, so a window that reloaded (and lost
     * all its tabs) takes these back; otherwise they kept running unseen, agents included.
     */
    list: () => [...shells].map(([id, entry]) => ({
      id, name: shell.name, exited: entry.exited, cwd: entry.cwd, agent: entry.agent ?? null,
      ...(entry.development && { development: entry.development })
    })),
    setComposing(id, value) {
      const entry = shells.get(id);
      if (!entry) return;
      entry.composing = value;
      entry.inbox?.setComposing(value);
    },
    reportAgentHook(id, agentId, report, { checkStop = false } = {}) {
      const entry = shells.get(id);
      if (agents?.hooksEnabled?.() === false || !hasAgent(entry) || entry.sleeping || entry.agent !== report.kind) return;
      if (agentId !== entryAgentId(entry)) return;
      const before = agentStatus(entry);
      const now = Date.now();
      entry.hookState ??= createAgentHookState(report.kind);
      const state = entry.hookState;
      const oldSession = state.sessionId;
      entry.inbox?.stopWakeReport(report);
      let block;
      if (checkStop && report.event === 'Stop' && report.promptId && state.turn?.id === report.promptId &&
          report.startedAt >= state.turnAt && (!report.sessionId || !state.sessionId || report.sessionId === state.sessionId) &&
          agentStatus(entry) === 'working' && now - (entry.userInterruptAt ?? -Infinity) >= 10_000) {
        const waitingForThisStop = () => hasAgent(entry) && !entry.sleeping && entry.hookState === state &&
          state.turnAt === report.startedAt && state.turn?.id === report.promptId;
        block = entry.inbox?.prepareStopWake(report, () => {
          if (!waitingForThisStop()) return;
          const status = agentStatus(entry);
          applyAgentHook(state, report, Date.now());
          reconcileHooks(entry);
          publishHookStatus(entry, status);
        }, () => report.kind === 'claude' && waitingForThisStop() && entry.hookTitle?.status === 'working');
      }
      applyAgentHook(state, report, now, { stopBlocked: Boolean(block), screenBlocked: entry.screenApproval });
      const session = state.sessionId;
      if (session && session !== oldSession) agents?.setHookSession?.(agentId, session);
      if (report.kind === 'codex' && !report.subagent) clearCodexReview(entry);
      reconcileHooks(entry);
      publishHookStatus(entry, before);
      return block ? { block } : true;
    },
    clearAgentHooks() {
      for (const entry of shells.values()) {
        const before = agentStatus(entry);
        clearHookTimer(entry);
        clearCodexReview(entry);
        entry.hookState = null;
        entry.hookTitle = null;
        entry.inbox?.clearStopWakes();
        publishHookStatus(entry, before);
        entry.inbox?.kick();
      }
    },
    /** Internal rollout activity from the session UUID used to launch this Codex. */
    setCodexTurnStatus(id, agentId, sessionId, turn) {
      const entry = shells.get(id);
      const activity = entry?.codexActivity;
      if (!activity || !hasAgent(entry) || entry.sleeping || entry.hookState || activity.sessionId !== sessionId) return;
      if (agentId !== (entry.externalAgent?.id ?? entry.registration?.env?.EZSHELL_AGENT_ID)) return;
      if (turn && (turn.at < activity.startedAt || turn.at < (activity.turn?.at ?? 0))) return;
      const previous = agentStatus(entry);
      activity.turn = turn;
      if (turn?.status === 'working' && turn.at >= activity.submittedAt) entry.codexReview?.turnStarted();
      const status = agentStatus(entry);
      if (status !== previous) {
        entry.reportStatus?.(status);
        entry.activeAt = Date.now();
        entry.inbox?.kick();
      }
    },
    codexHookReview: id => shells.get(id)?.codexReview?.review ?? null,
    declineCodexHooks(id) {
      const entry = shells.get(id);
      if (!entry?.codexReview?.review || !agents?.setCodexHookMode?.('disabled')) return false;
      clearCodexReview(entry);
      return true;
    },
    confirmStopDelivery: id => shells.get(id)?.inbox?.stopWakeReport(),
    /** The agent running in the shell and its state, or null */
    agentOf(id) {
      const entry = shells.get(id);
      if (!hasAgent(entry)) return null;
      const binding = entry.externalAgent;
      const session = entry.hookState?.sessionId
        ? { sessionId: entry.hookState.sessionId, cwd: binding?.claudeSession?.cwd ?? entry.launchDirectory }
        : binding?.antigravity
        ? { sessionId: binding.roleSessionId, cwd: binding.antigravity.cwd }
        : binding?.claudeSession;
      return { kind: entry.agent, status: agentStatus(entry), ...(session ? { sessionId: session.sessionId, cwd: session.cwd } : {}) };
    },
    chatAgentId(id) {
      const entry = shells.get(id);
      return hasAgent(entry) ? entry.externalAgent?.id ?? entry.registration?.env.EZSHELL_AGENT_ID : null;
    },
    codexSpeedOf(id) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || !entry.speedControl) return null;
      const state = entry.speedControl.read();
      if (!state.ultrafastAvailable && !pickerRefusal(entry) && !entry.picker.isOpen()) {
        void entry.speedControl.detectUltrafast().catch(() => {});
      }
      return state;
    },
    async toggleCodexSpeed(id, target) {
      const entry = shells.get(id);
      const speed = entry?.speedControl;
      if (!speed) return { ok: false, reason: 'not-agent' };
      await speed.pendingProbe();
      if (shells.get(id)?.speedControl !== speed) return { ok: false, reason: 'not-agent' };
      const refused = pickerRefusal(entry);
      if (refused) return refused;
      if (entry.picker.isOpen()) return { ok: false, reason: 'busy' };
      return speed.toggle(target);
    },
    /**
     * A line from the chat view (src/agentChat): into the agent's composer only, never the shell. Not
     * while it asks for approval (the text would answer the question).
     */
    chatInputTarget(id) {
      const entry = shells.get(id);
      return hasAgent(entry) ? entry.inbox?.inputTarget() ?? null : null;
    },
    rememberSubagentInput(id, label) {
      const labels = shells.get(id)?.subagentInputLabels;
      if (!labels) return;
      labels.add(label);
      if (labels.size > 64) labels.delete(labels.values().next().value);
    },
    async chatSend(id, text, images, target, sameConversation = () => true, { canSend, offerForce, forceToken } = {}) {
      const entry = shells.get(id);
      const inbox = entry?.inbox;
      if (!inbox) return { ok: false, reason: 'not-agent' };
      const interrupts = entry.chatInterrupts;
      const probe = entry.speedControl?.pendingProbe();
      if (probe) await probe;
      if (shells.get(id)?.inbox !== inbox || !hasAgent(entry)) return { ok: false, reason: 'not-agent' };
      if (entry.chatInterrupts !== interrupts) return { ok: false, reason: 'interrupted' };
      if (agentStatus(entry) === 'blocked') return { ok: false, reason: 'approval' };
      if (entry.agent === 'antigravity') {
        if (agentStatus(entry) !== 'idle') return { ok: false, reason: 'working' };
        if (images?.length || target !== undefined) return { ok: false, reason: 'not-agent' };
        const binding = entry.externalAgent;
        const sessionId = binding.roleSessionId;
        const confirm = canSend;
        canSend = () => entry.externalAgent === binding && binding.roleSessionId === sessionId &&
          agentStatus(entry) === 'idle' && (!confirm || confirm());
      }
      // Like Orca (MIT), native-chat-runtime-send.ts, an ordinary send goes to this agent's PTY whatever the
      // composer's label says (a session name). Only a send aimed at a subagent's label checks that label.
      const verify = target === undefined ? undefined : active => sameConversation() && active === target;
      const given = canSend;
      const stillSame = target === undefined ? () => sameConversation() && (!given || given()) : canSend;
      const result = await inbox.submitText(text, images, { verify, canSend: stillSame, offerForce, forceToken });
      if (result.ok && entry.codexInput && entry.codexInput.submitted) entry.reportStatus?.(agentStatus(entry));
      return result;
    },
    /** Esc in the chat view: clear only the expected text if the CLI put it back into its composer */
    async chatTakeBack(id, texts) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || !entry.inbox || entry.agent === 'antigravity') return { ok: false, reason: 'not-agent' };
      return entry.inbox.takeBack(texts);
    },
    /** The agent's numbered prompt on screen (permission, question), for the chat view; or null */
    approvalOf(id) {
      const entry = shells.get(id);
      if (!hasAgent(entry)) return null;
      if (entry.agent === 'antigravity') {
        return agentStatus(entry) === 'blocked'
          ? { question: null, detail: [], options: [], signature: 'antigravity-terminal', usesTerminalInput: true }
          : null;
      }
      return entry.inbox?.approvalPrompt() ?? null;
    },
    backgroundShellCountOf(id) {
      const entry = shells.get(id);
      return hasAgent(entry) ? entry.inbox?.backgroundShellCount() ?? null : null;
    },
    /**
     * The agent's screen for a slash command sent from the chat view (agentChat/commandScreen.js): its rows,
     * whether its composer shows, and whether a numbered prompt does; null without an agent
     */
    chatScreen(id) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || !entry.inbox) return null;
      const approval = entry.agent === 'antigravity' ? agentStatus(entry) === 'blocked' : Boolean(entry.inbox.approvalPrompt());
      return { ...entry.inbox.commandRows(), composer: entry.inbox.composerState(), footerRow: entry.inbox.composerFooterRow(), approval };
    },
    noteChatCommandScreen(id, agentId) {
      const entry = shells.get(id);
      if (hasAgent(entry) && entryAgentId(entry) === agentId) entry.inbox?.noteCommandScreen();
    },
    inspectAgent(id, agentId) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || entryAgentId(entry) !== agentId || entry.sleeping) return null;
      if (entry.hookState?.phase === 'ended') return { status: 'ended', statusSource: 'hook', blocked: { kind: 'ended' }, idleFor: null };
      const diagnostic = entry.inbox?.inspectBlock();
      const status = diagnostic?.ticket ? 'blocked' : agentStatus(entry);
      const statusSource = diagnostic?.ticket ? 'screen' : agentStatusSource(entry, status);
      const now = Date.now();
      const turn = entry.hookState?.turn;
      const staleHook = diagnostic && !diagnostic.blocked && status === 'working' && statusSource === 'hook'
        && turn && now - Math.max(turn.startedAt, entry.hookState.seenAt) >= LONG_HOOK_TURN_MS;
      return {
        status, statusSource, ticket: diagnostic?.ticket,
        blocked: diagnostic?.blocked ?? (staleHook ? { kind: 'hook-running' } : null),
        idleFor: status === 'idle' ? Math.max(0, now - entry.activeAt) : null
      };
    },
    /** Answers that prompt with a choice, only if the screen still shows the same prompt */
    async answerApproval(id, key, signature) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || !entry.inbox || entry.agent === 'antigravity') return { ok: false, reason: 'not-agent' };
      return entry.inbox.answerApproval(key, signature);
    },
    /** Answers Claude's AskUserQuestion screen (questions from main's own transcript, answers checked) */
    async answerQuestions(id, questions, answers) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || !entry.questions) return { ok: false, reason: 'not-agent' };
      if (!entry.inbox?.approvalPrompt()?.usesTerminalInput) return { ok: false, reason: 'changed' };
      return entry.questions.answer(questions, answers);
    },
    /** The usage line's picker (agentPicker.js): the whole list the CLI offers (first read, refresh) */
    async pickerList(id, what) {
      const entry = shells.get(id);
      const refused = pickerRefusal(entry);
      if (refused) return refused;
      const result = await entry.picker.list(what);
      tracePickerMiss(entry, result);
      return result;
    },
    /** Applies the choice of that name; `options` back when the whole fresh list was read */
    async pickerApply(id, what, label) {
      const entry = shells.get(id);
      const refused = pickerRefusal(entry);
      if (refused) return refused;
      const result = await entry.picker.apply(what, label);
      if (result.ok && what === 'model') entry.speedControl?.invalidate();
      tracePickerMiss(entry, result);
      // The usage line shows the new model / effort at once (Codex reports it only with its next turn)
      if (result.ok && result.applied) agents?.applyPicked?.(id, result.applied);
      const { applied, ...answer } = result;
      return answer;
    },
    /** Esc: stops the agent's current turn */
    interruptAgent(id) {
      const entry = shells.get(id);
      if (!hasAgent(entry) || (entry.agent === 'antigravity' && agentStatus(entry) === 'blocked')) return false;
      entry.chatInterrupts++;
      entry.userInterruptAt = Date.now();
      if (entry.inbox?.deferProbeInput('\x1b')) return true;
      entry.inbox?.interruptChat();
      try { entry.pty.write('\x1b'); return true; } catch { return false; }
    },
    sleep, wake, stayAwake,
    /** The agents for agentIdle.js: idle or not, since when nothing happened */
    idleAgents: () => [...shells].flatMap(([id, entry]) => (hasAgent(entry) && !entry.sleeping && entry.agent !== 'antigravity' ? [{
      id, kind: entry.agent, external: Boolean(entry.externalAgent?.hadMcp), agentId: entry.externalAgent?.id ?? null,
      // The CLI (typed into the shell) or the shell that runs it (launched by ezShell)
      pid: entry.externalAgent?.pid ?? entry.pty.pid,
      sessionId: entry.externalAgent?.claudeSession?.sessionId ?? null,
      activeAt: entry.activeAt, idle: agentStatus(entry) === 'idle'
    }] : [])),
    /** The shells whose agents sleep, for a window that starts or reloads */
    sleeping: () => [...shells].flatMap(([id, entry]) => (entry.sleeping && entry.sleeping.phase !== 'closing'
      ? [{ id, sleeping: { kind: entry.sleeping.kind, since: entry.sleeping.since, ...(entry.sleeping.phase === 'waking' ? { waking: true } : {}) } }]
      : [])),
    // A message for a sleeping agent wakes it; its inbox then tells it of the message
    wakeInbox: (id) => {
      const entry = shells.get(id);
      if (entry?.sleeping?.phase === 'asleep') wake(id);
      else entry?.inbox?.kick();
    },
    wakeInboxes: () => { for (const entry of shells.values()) entry.inbox?.kick(); },
    isRunning: id => shells.get(id)?.exited === false,
    hasWorkingAgent: ids => ids.some(id => {
      const entry = shells.get(id);
      return hasAgent(entry) && agentStatus(entry) === 'working';
    }),
    count: () => shells.size
  };
}

module.exports = { createLocalShells, defaultShell, requireLocalDirectory, BACKLOG_CHARS };
