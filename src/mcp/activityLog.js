// In-memory record of recent MCP requests for the live activity panel.
// Outputs can contain secrets, so nothing here is ever written to disk.
const DEFAULT_MAX = 100
const ACTIVE_STATES = new Set(['waiting', 'running'])

function createActivityLog({ emit = () => {}, now = () => Date.now(), max = DEFAULT_MAX } = {}) {
  let items = []
  const cancellers = new Map()

  function publish(item) {
    try {
      emit(item)
    } catch {
      // The window may be gone; the list stays available for the next listActivity()
    }
  }

  function begin(fields, { cancel } = {}) {
    const item = { ...fields, startedAt: now(), finishedAt: ACTIVE_STATES.has(fields.state) ? null : now() }
    items = [item, ...items.filter(existing => existing.id !== item.id)].slice(0, max)
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
    if (finished) cancellers.delete(id)
    publish(next)
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
  }

  return { begin, update, cancel, clear, list: () => items }
}

module.exports = { createActivityLog }
