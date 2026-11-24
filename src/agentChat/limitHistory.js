// Claude's 5-hour and weekly windows over time, from the status line reports the app gets while it runs
// (agentMessages' `agent-usage`). A Claude transcript has no limits, so the percent one question took is
// the reading at its last answer less the one before it started (turnUsage.js limitsUsed). Readings are
// the account's: kept per kind, not per agent, so a question of a newly started Claude has a reading
// from before it. Only numbers are kept, in memory, and only when they change.

const { limitsUsed } = require('./turnUsage.js')

const MAX_READINGS = 5000

const windowOf = value => (value && Number.isFinite(value.percent)
  ? { percent: value.percent, resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null }
  : null)
const sameWindow = (a, b) => (a?.percent ?? null) === (b?.percent ?? null) && (a?.resetsAt ?? null) === (b?.resetsAt ?? null)

function createLimitHistory({ now = () => Date.now(), max = MAX_READINGS } = {}) {
  const readings = []

  /** The latest reading at or before a time, or undefined */
  function readingAt(at) {
    for (let index = readings.length - 1; index >= 0; index--) {
      if (readings[index].at <= at) return readings[index]
    }
    return undefined
  }

  return {
    /** A usage report (agentUsage.js shape) */
    record(usage, at = now()) {
      const fiveHour = windowOf(usage?.fiveHour)
      const sevenDay = windowOf(usage?.sevenDay)
      if (!fiveHour && !sevenDay) return
      const last = readings.at(-1)
      if (last && sameWindow(last.fiveHour, fiveHour) && sameWindow(last.sevenDay, sevenDay)) return
      readings.push({ at, fiveHour, sevenDay })
      if (readings.length > max) readings.splice(0, readings.length - max)
    },
    /** Compare the usage readings at `from` and `to` (ms), if a baseline is available. */
    between(from, to) {
      if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined
      return limitsUsed(readingAt(from), readingAt(to))
    }
  }
}

module.exports = { createLimitHistory }
