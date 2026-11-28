// An agent's state from its window title (OSC 0/2), as src/localShell.js reads it. Shared with the CLI check
// (scripts/agent-cli-check.cjs, docs/plan/2026-11-28-agent-cli-check.md) so it tests the app's own rules.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.

// A spinner frame on its own in the title means the agent is working: braille dots (Codex, older
// Claude Code) or half/quarter circles (Claude Code since 2026: ◐◑, idle shows ✳). Recorded from the
// real CLIs; Claude Code sends no program status report, so its title is all there is.
const WORKING_TITLE = /(?:^|\s)[⠁-⣿◐-◓◴-◷](?:\s|$)/u
const SHELL_TITLE = /(?:^|[\\/])(?:cmd|powershell|pwsh)\.exe(?:\s|$)/i

/** 'blocked', 'starting', 'working' or 'idle'; null for an empty title or the shell's own */
function titleStatusOf(value) {
  const title = String(value ?? '').trim()
  if (!title || SHELL_TITLE.test(title)) return null
  if (/^\[\s*[!.]\s*\]\s*Action Required\b/i.test(title)) return 'blocked'
  if (/^Starting\b/i.test(title)) return 'starting'
  return WORKING_TITLE.test(title) || /^(?:Working|Thinking)\b/i.test(title) ? 'working' : 'idle'
}

module.exports = { titleStatusOf, WORKING_TITLE }
