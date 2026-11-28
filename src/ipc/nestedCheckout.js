// Smart and force checkout for a nested repository (2026-11-27 user request, IntelliJ's "Git checkout problem").
// A plain `git switch` already carries edits the target branch does not touch. When Git refuses because an edit
// would be overwritten, the user can put the edits aside (stash), switch and apply them again, or switch to the
// target's version while the edits stay in a stash as a backup. Nothing here throws edits away for good.
// See docs/plan/2026-11-27-nested-smart-checkout.md.
const { optionalGit, trimLine } = require('./nestedGit.js')

const MODES = new Set(['smart', 'force'])
const MAX_FILES = 200
const LOCAL_CHANGES = /Your local changes to the following files would be overwritten by checkout:\r?\n((?:\t[^\r\n]*\r?\n?)+)/
const UNTRACKED = /untracked working tree files would be overwritten/i
const INDEX_CONFLICT = /conflicts in index|try without --index/i
// Git creates stash commits with the user's identity; a PC with none set still gets a stash.
const FALLBACK_IDENTITY = ['-c', 'user.name=ezShell', '-c', 'user.email=ezshell@localhost']

/** Files Git named when it refused to switch over local edits, or null for any other failure */
function overwrittenFiles(stderr) {
  if (UNTRACKED.test(stderr ?? '')) return null
  const found = LOCAL_CHANGES.exec(stderr ?? '')
  if (!found) return null
  const files = found[1].split(/\r?\n/).filter(line => line.startsWith('\t')).map(line => line.slice(1)).filter(Boolean)
  return files.length ? files.slice(0, MAX_FILES) : null
}

function createStashSteps(directory, runGit) {
  const stashTop = async (ref = 'refs/stash') =>
    trimLine(await optionalGit(directory, ['rev-parse', '--verify', '--quiet', ref], runGit)) || null

  async function identity() {
    try {
      await runGit(directory, ['var', 'GIT_COMMITTER_IDENT'])
      return []
    } catch { return FALLBACK_IDENTITY }
  }

  /** Stash tracked edits (staged included). Untracked files stay where they are. Returns the stash commit or null. */
  async function putAside(message) {
    const before = await stashTop()
    await runGit(directory, [...await identity(), 'stash', 'push', '--quiet', '--message', message])
    const after = await stashTop()
    return after && after !== before ? after : null
  }

  // Only the entry this checkout made, and only while it is still the newest one.
  async function drop(commit) {
    if (await stashTop('stash@{0}') === commit) await runGit(directory, ['stash', 'drop', '--quiet', 'stash@{0}'])
  }

  async function unmerged() {
    const output = await runGit(directory, ['diff', '--name-only', '--diff-filter=U', '-z'])
    return output.split('\0').filter(Boolean).slice(0, MAX_FILES)
  }

  /** Apply the stash again, staged edits staged. Returns the files left with conflict markers. */
  async function applyAgain(commit) {
    try {
      await runGit(directory, ['stash', 'apply', '--index', '--quiet', commit])
      return []
    } catch (error) {
      const conflicts = await unmerged()
      if (conflicts.length) return conflicts
      if (!INDEX_CONFLICT.test(error.stderr ?? '')) throw error
    }
    try {
      await runGit(directory, ['stash', 'apply', '--quiet', commit])
      return []
    } catch (error) {
      const conflicts = await unmerged()
      if (conflicts.length) return conflicts
      throw error
    }
  }

  return { putAside, drop, applyAgain }
}

/**
 * Switch with local edits. `switchNow` runs `git switch` and throws a user-facing error when it fails.
 * smart: stash → switch → apply → drop (kept when applying conflicts).
 * force: stash → switch, and the stash stays as a backup of what the switch replaced.
 * When the switch fails the edits go back onto the original branch exactly as they were.
 */
async function checkoutWithChanges({ directory, runGit, mode, from, to, switchNow }) {
  const steps = createStashSteps(directory, runGit)
  const message = mode === 'smart' ? `ezShell 스마트 체크아웃: ${from} → ${to}` : `ezShell 강제 체크아웃 백업: ${from} → ${to}`
  const commit = await steps.putAside(message)
  try {
    await switchNow()
  } catch (error) {
    if (commit && !(await steps.applyAgain(commit)).length) await steps.drop(commit)
    throw error
  }
  if (!commit) return mode === 'smart' ? { kind: 'smart', conflicts: [] } : { kind: 'force' }
  if (mode === 'force') return { kind: 'force', stash: message }
  const conflicts = await steps.applyAgain(commit)
  if (conflicts.length) return { kind: 'smart', conflicts, stash: message }
  await steps.drop(commit)
  return { kind: 'smart', conflicts: [] }
}

module.exports = { MODES, overwrittenFiles, checkoutWithChanges }
