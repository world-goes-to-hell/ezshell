// When the running app looks for a new version: at start, on a timer, and when its window comes back
// after a while. These checks are "quiet": the window hears about them only if an update is found
// (no "checking" spinner, no "up to date" or network error every half hour).

function createUpdateChecker({ check, now = Date.now, focusGapMs }) {
  let lastCheckAt = 0
  let stage = 'idle'
  let quiet = false

  /** Resolves true when a check ran; false when an update is already downloading or downloaded */
  async function run() {
    if (stage === 'downloading' || stage === 'downloaded') return false
    lastCheckAt = now()
    quiet = true
    try {
      await check()
    } catch {
      // Offline or GitHub unreachable: the next check tries again
    } finally {
      quiet = false
    }
    return true
  }

  return {
    run,
    /** The window got focus: check only if the last check was at least `focusGapMs` ago */
    onFocus: () => (now() - lastCheckAt >= focusGapMs ? run() : Promise.resolve(false)),
    /** 'idle' | 'available' | 'downloading' | 'downloaded', from the updater's events */
    setStage: (next) => { stage = next },
    /** True while a quiet check runs: its "checking", "not available" and error events are not shown */
    isQuiet: () => quiet
  }
}

module.exports = { createUpdateChecker }
