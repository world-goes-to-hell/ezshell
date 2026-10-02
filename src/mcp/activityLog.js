// In-memory record of recent MCP requests for the live activity panel.
// Outputs can contain secrets, so nothing here is ever written to disk.
const DEFAULT_MAX = 100
const ACTIVE_STATES = new Set(['waiting', 'running'])
/** Live output is sent to the window in batches, not chunk by chunk */
const OUTPUT_FLUSH_MS = 50

/**
 * Characters of output kept per request (the end of it). A background job can print for an hour;
 * the window keeps the same limit (MAX_OUTPUT_CHARS in renderer/lib/mcpActivity.ts).
 */
const DEFAULT_MAX_OUTPUT_CHARS = 512 * 1024

/** Pieces of output kept per request; output that switches streams all the time would otherwise pile up without end */
const MAX_OUTPUT_PARTS = 2000

/** Drop output from the start until at most `max` characters are left. */
function trimParts(parts, max) {
  const total = parts.reduce((sum, part) => sum + part.text.length, 0)
  if (total <= max) return parts
  let excess = total - max
  let index = 0
  while (excess >= parts[index].text.length) {
    excess -= parts[index].text.length
    index += 1
  }
  const first = parts[index]
  return excess > 0 ? [{ stream: first.stream, text: first.text.slice(excess) }, ...parts.slice(index + 1)] : parts.slice(index)
}

/** At most `max` pieces: the oldest ones become one piece (their text stays, which stream it came from is lost). */
function mergeOldest(parts, max) {
  if (parts.length <= max) return parts
  const cut = parts.length - max + 1
  return [{ stream: 'stdout', text: parts.slice(0, cut).map(part => part.text).join('') }, ...parts.slice(cut)]
}

/**
 * At most `max` items of a newest-first list. The oldest finished ones go first: a request that is
 * still active stays, so it can always be seen and stopped.
 */
function capItems(list, max) {
  let excess = list.length - max
  if (excess <= 0) return list
  return list.reduceRight((kept, item) => {
    if (excess > 0 && !ACTIVE_STATES.has(item.state)) { excess -= 1; return kept }
    return [item, ...kept]
  }, []).slice(0, max)
}

/** Add a piece of output; a piece from the same stream as the last one extends it. */
function joinPart(parts, stream, text) {
  const last = parts[parts.length - 1]
  if (last && last.stream === stream) return [...parts.slice(0, -1), { stream, text: last.text + text }]
  return [...parts, { stream, text }]
}

function createActivityLog({ emit = () => {}, emitOutput = () => {}, now = () => Date.now(), max = DEFAULT_MAX, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS, maxOutputParts = MAX_OUTPUT_PARTS } = {}) {
  let items = []
  const cancellers = new Map()
  /** Output not sent to the window yet, per request id */
  let pendingOutput = new Map()
  let flushTimer = null

  function publish(item) {
    try {
      emit(item)
    } catch {
      // The window may be gone; the list stays available for the next listActivity()
    }
  }

  function begin(fields, { cancel } = {}) {
    const item = { ...fields, startedAt: now(), finishedAt: ACTIVE_STATES.has(fields.state) ? null : now() }
    items = capItems([item, ...items.filter(existing => existing.id !== item.id)], max)
    const kept = new Set(items.map(existing => existing.id))
    for (const id of cancellers.keys()) if (!kept.has(id)) cancellers.delete(id)
    if (cancel && ACTIVE_STATES.has(item.state)) cancellers.set(item.id, cancel)
    publish(item)
    return item.id
  }

  function update(id, patch) {
    const current = items.find(item => item.id === id)
    if (!current) return
    const state = patch.state || current.state
    const finished = !ACTIVE_STATES.has(state)
    const next = { ...current, ...patch, finishedAt: finished ? (current.finishedAt ?? now()) : null }
    items = items.map(item => (item.id === id ? next : item))
    if (finished) {
      cancellers.delete(id)
      // The finished item published below carries all of its output
      pendingOutput.delete(id)
    }
    publish(next)
  }

  function flushOutput() {
    clearTimeout(flushTimer)
    flushTimer = null
    const batch = pendingOutput
    pendingOutput = new Map()
    for (const [id, parts] of batch) {
      try {
        emitOutput({ id, parts })
      } catch {
        // The window may be gone; the item keeps the output for the next listActivity()
      }
    }
  }

  /** Output of a running command, as it arrives. Kept on the item and sent to the window in batches. */
  function appendOutput(id, stream, text) {
    if (typeof text !== 'string' || text === '') return
    const current = items.find(item => item.id === id)
    if (!current || !ACTIVE_STATES.has(current.state)) return
    const joined = joinPart(current.outputParts || [], stream, text)
    const kept = trimParts(joined, maxOutputChars)
    const next = { ...current, outputParts: mergeOldest(kept, maxOutputParts), ...(kept === joined ? {} : { outputTrimmed: true }) }
    items = items.map(item => (item.id === id ? next : item))
    pendingOutput.set(id, joinPart(pendingOutput.get(id) || [], stream, text))
    if (flushTimer === null) flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS)
  }

  function cancel(id) {
    const stop = cancellers.get(id)
    if (!stop) return false
    cancellers.delete(id)
    stop()
    return true
  }

  /** Forget everything (the app locked). Publishes nothing; the window drops its copy on its next snapshot. */
  function clear() {
    items = []
    cancellers.clear()
    pendingOutput = new Map()
    clearTimeout(flushTimer)
    flushTimer = null
  }

  /**
   * The snapshot for a window that (re)subscribes. Output still waiting for its batch is sent first:
   * the snapshot already contains it, and sending it afterwards would show it twice.
   */
  function list() {
    if (pendingOutput.size > 0) flushOutput()
    return items
  }

  return { begin, update, appendOutput, cancel, clear, list }
}

module.exports = { createActivityLog }
