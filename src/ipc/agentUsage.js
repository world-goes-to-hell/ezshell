// Usage of an agent ezShell launched (subscription windows, context, model), shown in the app's
// status bar instead of lines in the terminal. Only these numbers and the model name ever reach the
// app: no paths, no conversation, no credentials.
// Claude Code gives it to its status line command (src/ipc/agentUsageReport.js); Codex writes it to its
// session file (src/ipc/codexUsageWatcher.js).

const MAX_MODEL = 60
const FIVE_HOURS = 300
const WEEK_MINUTES = 10080

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const percent = value => {
  const n = number(value)
  return n === null ? null : Math.min(100, Math.max(0, Math.round(n * 10) / 10))
}
const text = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_MODEL) : null)
/** Reasoning effort: one plain word (low, medium, high, xhigh, max, minimal, ...) */
const effortWord = value => (typeof value === 'string' && /^[a-z][a-z-]{0,11}$/.test(value.trim()) ? value.trim() : null)
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The CLI's session id (to resume it after a restart), lower case, or null */
const sessionIdOf = value => (typeof value === 'string' && SESSION_ID.test(value) ? value.toLowerCase() : null)
/** Unix seconds from the CLIs → milliseconds */
const fromSeconds = value => {
  const n = number(value)
  return n !== null && n > 0 ? Math.round(n * 1000) : null
}

const windowOf = (used, resetsAt) => {
  const p = percent(used)
  return p === null ? null : { percent: p, resetsAt }
}

/** Claude Code's status line input → usage, or null when it is not an object */
function claudeUsageFromStatus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const context = input.context_window
  const limits = input.rate_limits
  const contextPercent = percent(context?.used_percentage)
  return {
    agent: 'claude',
    model: text(input.model?.display_name) ?? text(input.model?.id),
    // Only present when the model supports reasoning effort
    effort: effortWord(input.effort?.level),
    sessionId: sessionIdOf(input.session_id),
    context: contextPercent === null ? null : { percent: contextPercent, size: number(context?.context_window_size) },
    fiveHour: windowOf(limits?.five_hour?.used_percentage, fromSeconds(limits?.five_hour?.resets_at)),
    sevenDay: windowOf(limits?.seven_day?.used_percentage, fromSeconds(limits?.seven_day?.resets_at))
  }
}

/**
 * A Codex `token_count` event payload → usage. Its windows are "primary"/"secondary"; which one is
 * the 5-hour and which the weekly window is read from their length.
 */
function codexUsageFromTokenCount(payload, model, effort = null, sessionId = null) {
  if (!payload || typeof payload !== 'object') return null
  const result = { agent: 'codex', model: text(model), effort: effortWord(effort), sessionId: sessionIdOf(sessionId), context: null, fiveHour: null, sevenDay: null }
  for (const entry of [payload.rate_limits?.primary, payload.rate_limits?.secondary]) {
    const minutes = number(entry?.window_minutes)
    const window = windowOf(entry?.used_percent, fromSeconds(entry?.resets_at))
    if (!window || minutes === null) continue
    if (minutes <= FIVE_HOURS * 1.5 && !result.fiveHour) result.fiveHour = window
    else if (minutes >= WEEK_MINUTES * 0.5 && !result.sevenDay) result.sevenDay = window
  }
  const size = number(payload.info?.model_context_window)
  const used = number(payload.info?.last_token_usage?.total_tokens)
  if (size && size > 0 && used !== null) result.context = { percent: percent((used / size) * 100), size }
  return result
}

const sanitizeWindow = value => {
  const p = percent(value?.percent)
  if (p === null) return null
  const resetsAt = number(value?.resetsAt)
  return { percent: p, resetsAt: resetsAt !== null && resetsAt > 1e12 ? resetsAt : null }
}

/** What the main process keeps from a report: known fields only, and only for the reporting agent's kind */
function sanitizeUsage(value, kind) {
  if (!value || typeof value !== 'object' || value.agent !== kind) return null
  const contextPercent = percent(value.context?.percent)
  const size = number(value.context?.size)
  return {
    agent: kind,
    model: text(value.model),
    effort: effortWord(value.effort),
    sessionId: sessionIdOf(value.sessionId),
    context: contextPercent === null ? null : { percent: contextPercent, size: size !== null && size > 0 ? size : null },
    fiveHour: sanitizeWindow(value.fiveHour),
    sevenDay: sanitizeWindow(value.sevenDay)
  }
}

const sameUsage = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

module.exports = { claudeUsageFromStatus, codexUsageFromTokenCount, sanitizeUsage, sameUsage }
