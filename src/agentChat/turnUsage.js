// The tokens one question used (2026-11-21 user request: show them in the chat view, Claude and Codex).
// A turn is owned by the user item that started it; the transcript's usage lines that follow add to it
// and the owner is sent again with `usage` ({ input, cached, output, durationMs?, limits?, lastAt? }).
// The view draws it at the end of the turn.
//
// Parts are keyed so that a line read twice counts once: Claude repeats one answer's usage on each of its
// block lines (`message.id`), Codex repeats a `token_count` event with the same running total.
//
// Limits: how many percent of the 5-hour and weekly windows the turn took, the window's value at its end
// less the one before it started. Codex writes the windows in its `token_count` events (limits()); a
// Claude transcript has none, chats.js adds them from the status line reports (limitHistory.js). The
// windows are the account's: another session running at the same time adds to them too.
//
// Reading earlier parts of the file (the view scrolled up) goes backwards, one part at a time: the lines
// at the start of a part belong to the last question of the part before it. They wait in `lead` and go
// to that question once its part is read (beginOlder / endOlder around each part).

const count = value => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
/** A window's end time moving by more than this is a new window (the old one was reset) */
const RESET_SLACK_MS = 60 * 1000

const blank = () => ({ parts: new Map(), durationMs: undefined, after: undefined, lastAt: undefined })

/** `from` is the newer of the two: its last limits win */
function mergeInto(target, from) {
  for (const [key, usage] of from.parts) if (!target.parts.has(key)) target.parts.set(key, usage)
  if (from.durationMs !== undefined) target.durationMs = (target.durationMs ?? 0) + from.durationMs
  if (from.after) target.after = from.after
  if (from.lastAt !== undefined) target.lastAt = Math.max(target.lastAt ?? 0, from.lastAt)
}

/** Compare two readings ({ percent, resetsAt }) of the same kind of limit. */
function windowUsage(before, after) {
  if (!before || !after || !Number.isFinite(before.percent) || !Number.isFinite(after.percent)) return undefined
  const reset = before.resetsAt && after.resetsAt && after.resetsAt - before.resetsAt > RESET_SLACK_MS
  const used = reset ? after.percent : after.percent - before.percent
  return {
    before: before.percent,
    after: after.percent,
    used: Math.max(0, Math.round(used * 10) / 10),
    ...(reset ? { reset: true } : {})
  }
}

/** { fiveHour?, sevenDay? } comparisons between two readings, or undefined */
function limitsUsed(before, after) {
  if (!before || !after) return undefined
  const fiveHour = windowUsage(before.fiveHour, after.fiveHour)
  const sevenDay = windowUsage(before.sevenDay, after.sevenDay)
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  return { ...(fiveHour !== undefined ? { fiveHour } : {}), ...(sevenDay !== undefined ? { sevenDay } : {}) }
}

function summary(turn) {
  const total = { input: 0, cached: 0, output: 0 }
  for (const usage of turn.parts.values()) {
    total.input += usage.input
    total.cached += usage.cached
    total.output += usage.output
  }
  const limits = limitsUsed(turn.before, turn.after)
  return {
    ...total,
    ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
    ...(limits ? { limits } : {}),
    ...(turn.lastAt !== undefined ? { lastAt: turn.lastAt } : {})
  }
}

function createTurnUsage() {
  let live = null
  let older = null
  let lead = blank()
  let partLead = null
  // The last window readings seen: in what is appended, and in the earlier part being read
  let liveLast = undefined
  let partLast = undefined

  const inPart = isOlder => isOlder && Boolean(partLead)
  const owner = isOlder => (inPart(isOlder) ? older ?? partLead : live ?? lead)
  /** The owner item with its usage now, or null while no question owns the lines */
  const sent = turn => (turn?.item && turn.parts.size ? { ...turn.item, usage: summary(turn) } : null)

  return {
    /** A user item that starts a turn */
    start(item, { older: isOlder = false } = {}) {
      const turn = { item, ...blank(), before: inPart(isOlder) ? partLast : liveLast }
      if (inPart(isOlder)) older = turn
      else live = turn
    },
    /** One usage part (`at`: the line's time); the owner item to send again, or null */
    add(key, usage, { older: isOlder = false, at = null } = {}) {
      const turn = owner(isOlder)
      turn.parts.set(String(key), { input: count(usage.input), cached: Math.min(count(usage.cached), count(usage.input)), output: count(usage.output) })
      if (Number.isFinite(at)) turn.lastAt = Math.max(turn.lastAt ?? 0, at)
      return sent(turn)
    },
    /** The windows as they are now ({ fiveHour, sevenDay } of { percent, resetsAt }); the owner to send again, or null */
    limits(reading, { older: isOlder = false } = {}) {
      if (!reading?.fiveHour && !reading?.sevenDay) return null
      if (inPart(isOlder)) partLast = reading
      else liveLast = reading
      const turn = owner(isOlder)
      turn.after = reading
      return sent(turn)
    },
    /**
     * The turn took this long (the CLI writes it when a turn ends). Added up: a turn the agent starts by
     * itself (a finished background task) has no question of its own and counts for the one before.
     */
    duration(ms, { older: isOlder = false } = {}) {
      if (!(count(ms) > 0)) return null
      const turn = owner(isOlder)
      turn.durationMs = (turn.durationMs ?? 0) + count(ms)
      return sent(turn)
    },
    beginOlder() {
      partLead = blank()
      partLast = undefined
      older = null
    },
    /** End of an earlier part: its last question gets the lines that waited; [item] or [] */
    endOlder() {
      if (!partLead) return []
      let out = []
      if (older) {
        mergeInto(older, lead)
        lead = partLead
        // No question in what was read before: this one is the latest, the lines appended next are its own
        if (!live) live = older
        const item = sent(older)
        if (item) out = [item]
      } else {
        mergeInto(partLead, lead)
        lead = partLead
      }
      partLead = null
      older = null
      return out
    }
  }
}

module.exports = { createTurnUsage, limitsUsed }
