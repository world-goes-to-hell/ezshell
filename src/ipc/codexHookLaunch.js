const { HOOK_COMMANDS } = require('../agentHookReport.js')
const { CODEX_HOOK_EVENTS } = require('./agentHookEvent.js')
const fs = require('node:fs')
const path = require('node:path')
const { sameOrInside } = require('../localFiles/roots.js')
const { isLocalFilePath } = require('../localKeyPath.js')
const CODEX_FIRST_PROMPT_WAIT_MS = 10_000

// Avoid native PowerShell splitting quoted TOML at spaces or expanding its dollar signs.
function tomlCommand(command) {
  const encoded = command.replace(/[\s"\\&]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
  return '"' + encoded + '"'
}

const CODEX_HOOK_ARGS = CODEX_HOOK_EVENTS.flatMap(event => [
  '-c',
  "hooks." + event + "=[{hooks=[{type='command',command=" + tomlCommand(HOOK_COMMANDS.codex) +
    ',command_windows=' + tomlCommand(HOOK_COMMANDS.codexWindows) +
    ',timeout=5,async=' + (event !== 'Stop') + '}]}]'
])

function injectCodexHooks(mode, automatic = false) {
  return mode === 'approved' || (!automatic && mode === 'pending')
}

function quoteCodexHookArgs() {
  return CODEX_HOOK_ARGS.map(arg => "'" + arg.replace(/'/g, "'\"'\"'") + "'").join(' ')
}

const POWERSHELL_CODEX_HOOK_ARGS = String.raw`
function Get-EzShellCodexHookArgs($native, [bool]$automatic) {
    if (!$env:EZSHELL_CODEX_HOOK_MODE_FILE -or !$env:EZSHELL_CODEX_HOOK_ARGS) { return }
    try { $mode = [IO.File]::ReadAllText($env:EZSHELL_CODEX_HOOK_MODE_FILE).Trim() } catch { return }
    if ($mode -cne 'approved' -and ($automatic -or $mode -cne 'pending')) { return }
    $hookArgs = ConvertFrom-Json -InputObject $env:EZSHELL_CODEX_HOOK_ARGS -ErrorAction SilentlyContinue
    if ($PSVersionTable.PSVersion -lt [version]'7.3' -or $PSNativeCommandArgumentPassing -eq 'Legacy' -or $native.Extension -in '.cmd','.bat') {
        $hookArgs = $hookArgs | ForEach-Object { $_ -replace '"','\"' }
    }
    $hookArgs
}
`

function readCodexHookReview(lines) {
  const text = lines.join(' ').replace(/\s+/g, ' ')
  if (isCodexHookReviewTable(text)) return null
  if (!text.includes('Hooks need review') || !text.includes('Continue without trusting')) return null
  const count = /\b(\d+) hooks? (?:are|is) new or changed\b/.exec(text)?.[1]
  if (!count || !Number.isSafeInteger(Number(count)) || Number(count) < 1) return null
  const declineSelected = lines.some(line => /^\s*[❯›>▶]\s*3\.\s+Continue without trusting\b/u.test(line))
  return { count: Number(count), injectedCount: CODEX_HOOK_EVENTS.length, declineSelected }
}

function isCodexHookReviewTable(text) {
  return /t trust all\s*[·•]\s*enter review\s*[·•]\s*esc close/i.test(text) ||
    /\bEvent\s+Installed\s+Active\s+Review\b/.test(text)
}

function isCodexHookTrustScreen(lines) {
  return Boolean(readCodexHookReview(lines)) || isCodexHookReviewTable(lines.join(' ').replace(/\s+/g, ' '))
}

function codexProjectHooksPossible(directory) {
  if (!directory || !isLocalFilePath(directory)) return true
  try {
    const cwd = fs.realpathSync(directory)
    const folders = []
    for (let folder = cwd; ; folder = path.dirname(folder)) {
      folders.push(folder)
      if (fs.lstatSync(path.join(folder, '.git'), { throwIfNoEntry: false })) break
      if (path.dirname(folder) === folder) {
        folders.length = 1
        break
      }
    }
    return folders.some(folder => {
      const settings = path.join(folder, '.codex')
      const info = fs.lstatSync(settings, { throwIfNoEntry: false })
      if (!info) return false
      if (!info.isDirectory() || !sameOrInside(folder, fs.realpathSync(settings))) return true
      if (fs.lstatSync(path.join(settings, 'hooks.json'), { throwIfNoEntry: false })) return true
      const config = path.join(settings, 'config.toml')
      const file = fs.lstatSync(config, { throwIfNoEntry: false })
      if (!file) return false
      if (!file.isFile() || file.size > 128 * 1024) return true
      return /^\s*(?:\[+\s*["']?hooks\b|hooks\s*=)/m.test(fs.readFileSync(config, 'utf8'))
    })
  } catch { return true }
}

function observeCodexHookReview({ cols, rows, onReviewChange, projectHooks = () => true, mayDecline, onDecline }) {
  const { Terminal } = require('@xterm/headless')
  const screen = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  const submit = /^(?:\r|\n|\x1b\[13(?:;1)?u)$/
  const escape = /^(?:\x1b|\x1b\[27(?:;1)?u)$/
  let review = null
  let closed = false
  let draft = ''
  let submitted = false
  let timer

  function setReview(next) {
    if (next?.count === review?.count && next?.declineSelected === review?.declineSelected) return
    review = next && { ...next, projectHooks: projectHooks() }
    draft = ''
    onReviewChange(review)
  }

  function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    screen.dispose()
    setReview(null)
  }

  function decline() {
    clearTimeout(timer)
    timer = undefined
    if (mayDecline() && onDecline()) close()
  }

  return {
    get review() { return review },
    close,
    turnStarted() {
      if (closed || timer || !submitted || !mayDecline()) return
      timer = setTimeout(decline, CODEX_FIRST_PROMPT_WAIT_MS)
      timer.unref?.()
    },
    resize(cols, rows) { if (!closed) screen.resize(cols, rows) },
    write(data) {
      if (closed) return
      screen.write(data, () => {
        if (closed) return
        const buffer = screen.buffer.active
        const lines = Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
        setReview(readCodexHookReview(lines))
      })
    },
    input(data, mode) {
      if (closed) return
      if (review) {
        if (data === '3' || escape.test(data) || (review.declineSelected && submit.test(data))) decline()
        return
      }
      if (mode !== 'pending') return
      if (submit.test(data)) {
        if (draft && !draft.startsWith('/')) submitted = true
        draft = ''
      } else if (escape.test(data) || data === '\x03' || data === '\x15') {
        draft = ''
      } else if (data === '\x7f' || data === '\b') {
        draft = draft.slice(0, -1)
      } else {
        const text = (/^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)?.[1] ?? (data.startsWith('\x1b') ? '' : data)).trim()
        draft = (draft + text).slice(0, 512)
      }
    }
  }
}

module.exports = { CODEX_HOOK_ARGS, POWERSHELL_CODEX_HOOK_ARGS, injectCodexHooks, quoteCodexHookArgs,
  isCodexHookTrustScreen, codexProjectHooksPossible, observeCodexHookReview }
