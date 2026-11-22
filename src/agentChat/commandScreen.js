// What a slash command sent from the chat view did, read off the agent's screen (the headless copy main
// keeps: agentInboxWake.js). User request, 2026-11-21: every slash command should work from the chat.
// - The empty composer is back: the command ran. Codex records no slash command in its transcript, so what
//   it printed (`/status`, `/diff` …) is the lines that appeared above the composer.
// - A numbered prompt shows: the chat's question card takes it (approvalPrompt).
// - No composer stays: the command opened a screen of its own (`/config`, `/resume`, `/mcp` …). The view
//   then hands the pane to the real terminal until the composer is back.

const STEP_MS = 150
// The same screen this long: the CLI has settled
const SETTLE_MS = 450
const TIMEOUT_MS = 4000
const MAX_OUTPUT_LINES = 80
const MAX_OUTPUT_CHARS = 8000

const CODEX_PROMPT = /^\s*›[  ]/u

/** The rows above the composer (Codex's history), trailing blank rows dropped */
function historyAbove(lines) {
  let composer = -1
  for (let row = lines.length - 1; row >= 0; row--) {
    if (CODEX_PROMPT.test(lines[row])) { composer = row; break }
  }
  const rows = (composer >= 0 ? lines.slice(0, composer) : lines.slice()).map(row => row.replace(/\s+$/u, ''))
  while (rows.length && !rows[rows.length - 1]) rows.pop()
  return rows
}

/**
 * The lines a command printed above Codex's composer: the history before it, scrolled up by some rows,
 * is the start of the history after it, and what follows is new (a cleared screen: all of it). Null when
 * nothing new came.
 */
function printedLines(before, after, command = '') {
  const old = historyAbove(before)
  const now = historyAbove(after)
  let fresh = null
  for (let shift = 0; shift <= old.length; shift++) {
    const kept = old.length - shift
    if (kept > now.length) continue
    let same = true
    for (let row = 0; row < kept && same; row++) same = old[shift + row] === now[row]
    if (same) { fresh = now.slice(kept); break }
  }
  if (!fresh) return null
  // The command itself, as the CLI echoes it ("› /status")
  const typed = command.trim()
  if (typed) {
    const echo = fresh.findIndex(row => row.trim().replace(/^[›>❯]\s*/u, '') === typed)
    if (echo >= 0 && echo < 3) fresh = fresh.slice(echo + 1)
  }
  while (fresh.length && !fresh[0].trim()) fresh.shift()
  while (fresh.length && !fresh[fresh.length - 1].trim()) fresh.pop()
  if (!fresh.length) return null
  const clipped = fresh.slice(0, MAX_OUTPUT_LINES)
  let text = clipped.join('\n')
  if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS)
  return clipped.length < fresh.length || text.length < clipped.join('\n').length ? text + '\n…' : text
}

/**
 * Waits until the screen settles after the command's Enter.
 * read(): { lines, composer: 'empty' | 'draft' | null, approval: boolean } or null (no agent any more)
 * Resolves { state: 'done', output? } | { state: 'approval' } | { state: 'screen' } | { state: 'gone' }.
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
    last = screen
    const next = `${screen.composer}|${screen.approval}|${screen.lines.join('\n')}`
    if (next !== signature) { signature = next; since = now() }
    const settled = now() - since >= SETTLE_MS
    const over = now() - start >= timeoutMs
    if (screen.approval && (settled || over)) return { state: 'approval' }
    if (screen.composer === 'empty' && (settled || over)) {
      const output = kind === 'codex' && before ? printedLines(before, screen.lines, command) : null
      return output ? { state: 'done', output } : { state: 'done' }
    }
    if (screen.composer === null && (settled || over)) return { state: 'screen' }
    // Our line still in the composer (the CLI has not taken it yet), or still drawing
    if (over) return last.composer === null ? { state: 'screen' } : { state: 'done' }
  }
}

module.exports = { watchCommand, printedLines, historyAbove }
