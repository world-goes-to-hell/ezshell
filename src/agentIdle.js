// Agents left idle in local shells use memory for nothing: a Claude Code CLI holds 450-900MB and each of
// its MCP servers about 100MB more (measured on this PC, 2026-11-21). Two steps, both set in the app's
// settings (user request, 2026-11-21):
// - after a while idle, the CLI and its children give back their working set (Windows EmptyWorkingSet):
//   nothing changes for them, the pages come back when they run again;
// - after longer, the CLI is closed (`/exit`, `/quit`) and its shell kept: the pane shows it asleep, and
//   it is resumed in the same shell (`claude --resume <id>`, `codex resume <id>`) from the pane or when a
//   message comes for it. Only an agent typed into a shell: one ezShell launched is the shell itself.
// Never while it works, asks for approval, has text in its composer or runs a shell of its own (a
// background command would die with it).

const { execFile } = require('child_process')

const TICK_MS = 30 * 1000
const MAX_MINUTES = 24 * 60
/** A refusal (busy in the background, no session id, text in its composer) is looked at again after this many minutes */
const RETRY_MINUTES = 5
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A child of the CLI by these names is a command it runs (Claude: Git Bash, Codex: PowerShell) */
const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'powershell', 'pwsh'])
/** Shells started this soon after the CLI are MCP servers' wrappers (see runsCommand) */
const STARTUP_MS = 60 * 1000
const SAFE_VALUE = /^[A-Za-z0-9][\w.:-]{0,79}$/

const processName = name => String(name ?? '').toLowerCase().replace(/\.exe$/, '')

/** The CLI and every process under it */
function descendants(tree, pid) {
  const found = [pid]
  for (let index = 0; index < found.length; index++) {
    for (const [child, entry] of tree) if (entry.parent === found[index] && !found.includes(child)) found.push(child)
  }
  return found
}

/**
 * Whether the CLI runs a command of its own now (a background task): closing it would end that. A shell
 * it started with itself is an MCP server's wrapper, not a command: ezShell's own messages MCP runs in
 * powershell.exe (/bin/sh elsewhere), and every agent typed into a shell has one. So only a shell that
 * started later counts, and one whose start time is not known.
 */
function runsCommand(tree, pid) {
  const cli = tree.get(pid)
  for (const entry of tree.values()) {
    if (entry.parent !== pid || !SHELL_NAMES.has(processName(entry.name))) continue
    if (!cli?.startedAt || !entry.startedAt || entry.startedAt - cli.startedAt > STARTUP_MS) return true
  }
  return false
}

const WINDOWS_PROCESS_LIST = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { $t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; "{0} {1} {2} {3}" -f $_.ProcessId,$_.ParentProcessId,$t,$_.Name }'

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in seconds, or null */
function elapsedSeconds(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text)
  if (!match) return null
  const [, days = 0, hours = 0, minutes, seconds] = match
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)
}

/** Every process: pid → { parent, name, startedAt (ms, 0 when not known) } */
function processList({ platform = process.platform, run = execFile, now = Date.now } = {}) {
  const [file, args] = platform === 'win32'
    ? [`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_LIST]]
    : ['/bin/ps', ['-axo', 'pid=,ppid=,etime=,comm=']]
  return new Promise((resolve, reject) => {
    run(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error)
      const processes = new Map()
      const time = now()
      for (const line of String(stdout).split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
        if (!match) continue
        const started = platform === 'win32' ? Number(match[3]) : (elapsedSeconds(match[3]) === null ? 0 : time - elapsedSeconds(match[3]) * 1000)
        processes.set(Number(match[1]), { parent: Number(match[2]), name: match[4], startedAt: Number.isFinite(started) ? started : 0 })
      }
      resolve(processes)
    })
  })
}

/** Splits a command line into words, with "double" quotes */
function words(commandLine) {
  const found = []
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  let match
  while ((match = pattern.exec(String(commandLine ?? '')))) found.push(match[1] ?? match[2])
  return found
}

// The options of the closed CLI that the resumed one needs to work as before: how much it may do on its
// own and the model it was started with. Only these, with plain values (they go into a shell line).
const KEPT = {
  claude: { flags: ['--dangerously-skip-permissions'], values: ['--permission-mode', '--model'] },
  codex: { flags: ['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--search'], values: ['--sandbox', '-s', '--ask-for-approval', '-a', '--model', '-m'] }
}

/** The kept options from the closed CLI's command line, in order */
function launchFlags(kind, commandLine) {
  const kept = KEPT[kind]
  if (!kept) return []
  const all = words(commandLine)
  const out = []
  for (let index = 0; index < all.length; index++) {
    const word = all[index]
    const [name, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    if (kept.flags.includes(name) && inline === undefined) {
      if (!out.includes(name)) out.push(name)
    } else if (kept.values.includes(name)) {
      const value = inline ?? all[++index]
      if (SAFE_VALUE.test(value ?? '')) out.push(name, value)
    }
  }
  return out
}

/** The line typed into the shell to resume: the session id and the kept options only */
function resumeCommand(kind, sessionId, flags = []) {
  if (!SESSION_ID.test(sessionId ?? '')) throw new Error('이어서 실행할 세션이 올바르지 않습니다.')
  const options = launchFlags(kind, flags.join(' '))
  const tail = options.length ? ' ' + options.join(' ') : ''
  return kind === 'codex' ? `codex resume ${sessionId}${tail}` : `claude --resume ${sessionId}${tail}`
}

/** Hands the working set of these processes back to Windows (each one that can be opened) */
function trimWorkingSets(pids, { platform = process.platform, run = execFile } = {}) {
  const ids = pids.filter(pid => Number.isSafeInteger(pid) && pid > 0)
  if (platform !== 'win32' || !ids.length) return Promise.resolve(false)
  const script = [
    "Add-Type -Namespace EzShell -Name Memory -MemberDefinition '[DllImport(\"psapi.dll\")] public static extern bool EmptyWorkingSet(IntPtr process);'",
    `foreach ($id in @(${ids.join(',')})) { try { $p = [Diagnostics.Process]::GetProcessById($id); [void][EzShell.Memory]::EmptyWorkingSet($p.Handle) } catch {} }`
  ].join('; ')
  const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  return new Promise(resolve => {
    run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true }, error => resolve(!error))
  })
}

/** A process's command line, or '' */
function processCommandLine(pid, { platform = process.platform, run = execFile } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve('')
  const [file, args] = platform === 'win32'
    ? [`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]]
    : ['/bin/ps', ['-o', 'args=', '-p', String(pid)]]
  return new Promise(resolve => {
    run(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()))
  })
}

/**
 * @param {object} deps
 * @param {{ idleAgents(): object[], sleep(id: string, options: object): Promise<{ ok: boolean }> }} deps.shells localShell.js
 * @param {(agent: object) => string | null} deps.sessionOf the CLI's session id (usage report, Codex watcher)
 */
function createAgentIdle({
  shells, sessionOf, processTree = processList, commandLine = processCommandLine, trim = trimWorkingSets,
  now = () => Date.now(), tickMs = TICK_MS, minuteMs = 60 * 1000
}) {
  let config = { trimMinutes: 0, sleepMinutes: 0 }
  let timer = null
  let running = false
  /** shell id → the activity it was trimmed for (once per idle stretch) */
  const trimmed = new Map()
  /** shell id → { activeAt, at } of a refused sleep */
  const refused = new Map()

  async function tick() {
    if (running) return
    running = true
    try {
      const time = now()
      let tree = null
      const treeNow = async () => (tree ??= await processTree())
      for (const agent of shells.idleAgents()) {
        if (!agent.idle) continue
        const idleMs = time - agent.activeAt
        const sleepMs = config.sleepMinutes * minuteMs
        const refusal = refused.get(agent.id)
        const retry = !refusal || refusal.activeAt !== agent.activeAt || time - refusal.at >= RETRY_MINUTES * minuteMs
        if (sleepMs && agent.external && idleMs >= sleepMs && retry) {
          const sessionId = sessionOf(agent)
          const busy = sessionId && runsCommand(await treeNow(), agent.pid)
          const result = sessionId && !busy
            ? await shells.sleep(agent.id, { sessionId, flags: launchFlags(agent.kind, await commandLine(agent.pid)) })
            : { ok: false }
          if (result.ok) refused.delete(agent.id)
          else refused.set(agent.id, { activeAt: agent.activeAt, at: time })
          continue
        }
        if (config.trimMinutes && idleMs >= config.trimMinutes * minuteMs && trimmed.get(agent.id) !== agent.activeAt) {
          trimmed.set(agent.id, agent.activeAt)
          await trim(descendants(await treeNow(), agent.pid))
        }
      }
    } catch {
      // The process list could not be read: next tick
    } finally {
      running = false
    }
  }

  const minutes = value => (Number.isInteger(value) && value > 0 ? Math.min(value, MAX_MINUTES) : 0)

  return {
    /** { trimMinutes, sleepMinutes }: 0 turns a step off */
    configure(next) {
      config = { trimMinutes: minutes(next?.trimMinutes), sleepMinutes: minutes(next?.sleepMinutes) }
      const on = config.trimMinutes || config.sleepMinutes
      if (on && !timer) {
        timer = setInterval(() => void tick(), tickMs)
        timer.unref?.()
      } else if (!on && timer) {
        clearInterval(timer)
        timer = null
      }
      return config
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick
  }
}

module.exports = { createAgentIdle, launchFlags, resumeCommand, runsCommand, descendants, trimWorkingSets, processCommandLine, processList, elapsedSeconds, words }
