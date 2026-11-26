// What a slash command sent from the chat view did, read off the agent's screen (the headless copy main
// keeps: agentInboxWake.js). User request, 2026-11-21: every slash command should work from the chat.
// - The empty composer is back: the command ran. Codex records no slash command in its transcript, so what
//   it printed (`/status`, `/diff` …) is the history between its command echo and the composer.
// - A numbered prompt shows: the chat's question card takes it (approvalPrompt).
// - No composer stays: the command opened a screen of its own (`/config`, `/resume`, `/mcp` …). The view
//   then hands the pane to the real terminal until the composer is back.

const STEP_MS = 150
// The same screen this long: the CLI has settled
const SETTLE_MS = 450
const TIMEOUT_MS = 4000
const MAX_OUTPUT_LINES = 80
const MAX_OUTPUT_CHARS = 8000

const CODEX_PROMPT = /^\s*›(?:\s|$)/u
const ECHO_PROMPT = /^[›>❯]\s*/u

const isClaudeLogin = (kind, command) => kind === 'claude' && command?.trim() === '/login'

function claudeLoginStage({ lines, wraps }) {
  const rows = []
  for (const [index, line] of lines.entries()) {
    if (wraps[index] && rows.length) rows[rows.length - 1] += line
    else rows.push(line)
  }
  trimHistory(rows)
  const heading = rows.findLastIndex(row => /^\s*Login\s*$/i.test(row))
  // Wide and split panes both keep the dialog near the end of the visible screen.
  const tail = rows.slice(Math.max(heading + 1, rows.length - 12))
  const composer = tail.findLastIndex((row, index) => index > 0 && /^\s*[❯>]\s/u.test(row + ' ') &&
    /^\s*─{8,}/u.test(tail[index - 1]))
  const dialog = tail.slice(composer + 1).join('\n')
  if (/^\s*[✓✔]?\s*Login successful\.\s+Press Enter to continue\s*$/im.test(dialog)) return 'continue'
  if (heading >= 0 && /(?:Select login method|Paste code here if prompted|Waiting for (?:browser|authentication)|Browser (?:didn.t|not) open)/i.test(dialog)) return 'active'
  return null
}

function historyAbove({ lines, wraps = [] }, joinWrapped = false) {
  let composer = -1
  for (let row = lines.length - 1; row >= 0; row--) {
    if (!wraps[row] && CODEX_PROMPT.test(lines[row])) { composer = row; break }
  }
  const rows = []
  for (let row = 0; row < (composer < 0 ? lines.length : composer); row++) {
    if (joinWrapped && wraps[row] && !rows.length) continue
    if (joinWrapped && wraps[row]) rows[rows.length - 1] += lines[row]
    else rows.push(lines[row])
  }
  return trimHistory(rows.map(row => row.trimEnd()))
}

function trimHistory(rows) {
  while (rows.length && !rows[rows.length - 1]) rows.pop()
  return rows
}

function overlap(old, now) {
  let kept = Math.min(old.length, now.length)
  while (kept && !old.slice(-kept).every((row, index) => row === now[index])) kept--
  return kept
}

function readCommandOutput(before, after, command = '') {
  const typed = command.trim()
  const isEcho = row => Boolean(typed) && row.trim().replace(ECHO_PROMPT, '') === typed
  const old = historyAbove(before, true)
  const now = historyAbove(after, true)
  const kept = overlap(old, now)
  const newRows = now.slice(kept)
  if (!newRows.length && old.length) return null
  const echo = newRows.findLastIndex(isEcho)
  if (echo >= 0) {
    const fresh = newRows.slice(echo + 1)
    const previousEcho = old.findLastIndex(isEcho)
    const anchored = now.slice(0, kept).some(Boolean)
    // A wider redraw can bring back an echo that was above the viewport.
    const firstLine = fresh.findIndex(Boolean)
    if (!anchored && previousEcho < 0 && firstLine >= 0) {
      const body = fresh.slice(firstLine)
      if (overlap(old, body) === body.length) return null
    }
    // When a redraw obscures the overlap, a retained echo may still belong to the previous result.
    const ambiguous = previousEcho >= 0 && !anchored
      && newRows.filter(isEcho).length <= old.filter(isEcho).length
    if (!ambiguous) return formatOutput(fresh, ECHO_PROMPT.test(newRows[echo].trim()))
    const previousOutput = old.slice(previousEcho + 1)
    if (previousOutput.length && previousOutput.every((row, index) => row === fresh[index])) return null
  }

  const oldRows = historyAbove(before)
  const visibleRows = historyAbove(after)
  const fresh = visibleRows.slice(overlap(oldRows, visibleRows))
  const visibleEcho = fresh.findIndex(isEcho)
  return formatOutput(visibleEcho >= 0 && visibleEcho < 3 ? fresh.slice(visibleEcho + 1) : fresh, false)
}

function formatOutput(fresh, echoVerified) {
  while (fresh.length && !fresh[0]) fresh.shift()
  if (!fresh.length) return null
  const text = fresh.slice(0, MAX_OUTPUT_LINES).join('\n')
  const clipped = text.slice(0, MAX_OUTPUT_CHARS)
  const output = fresh.length > MAX_OUTPUT_LINES || text.length > clipped.length ? clipped + '\n…' : clipped
  return { output, echoVerified }
}

/**
 * Waits until the screen settles after the command's Enter.
 * Reads visible rows and their soft-wrap flags. An empty composer lets us report any output
 * and whether a new prompt-marked echo identified it.
 */
async function watchCommand({ read, kind, before, command, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, timeoutMs = TIMEOUT_MS }) {
  const start = now()
  let signature = null
  let since = start
  let last = null
  for (;;) {
    await sleep(STEP_MS)
    const screen = read()
    if (!screen) return { state: 'gone' }
    if (isClaudeLogin(kind, command)) return { state: 'screen', screen: 'claude-login' }
    last = screen
    const next = `${screen.composer}|${screen.approval}|${screen.wraps?.join(',')}|${screen.lines.join('\n')}`
    if (next !== signature) { signature = next; since = now() }
    const settled = now() - since >= SETTLE_MS
    const over = now() - start >= timeoutMs
    if (screen.approval && (settled || over)) return { state: 'approval' }
    if (screen.composer === 'empty' && (settled || over)) {
      const result = kind === 'codex' && before ? readCommandOutput(before, screen, command) : null
      return { state: 'done', ...result }
    }
    if (screen.composer === null && (settled || over)) return { state: 'screen' }
    // Our line still in the composer (the CLI has not taken it yet), or still drawing
    if (over) return last.composer === null ? { state: 'screen' } : { state: 'done' }
  }
}

function claudeQueueVisible(screen) {
  const lines = screen?.lines ?? []
  // The hint can replace the prompt or appear below the composer and wrap in a narrow pane.
  const start = Math.min(screen?.footerRow ?? 0, Math.max(0, lines.length - 8))
  const footer = lines.slice(start).join(' ').replace(/\s+/g, ' ')
  return /(?:\bpress (?:up(?: arrow)?|↑)|↑(?= to\b)) .{0,72}?\bqueued messages?\b/i.test(footer)
}

module.exports = { watchCommand, readCommandOutput, claudeQueueVisible, claudeLoginStage }
