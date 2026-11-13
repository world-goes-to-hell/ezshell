// Queue of "may Claude run this?" questions for the user. One dialog at a time;
// no answer within the timeout means no. `onClose(id, outcome)` is told whenever a shown question
// ends, however it ends (`dismiss` is not called when the user answered in the dialog itself).
// `minTimeoutMs()` lengthens every question's limit while it gives a larger number: the user may
// be answering from a phone (remote access), which takes longer than turning to the dialog.
const crypto = require('crypto')

const DEFAULT_TIMEOUT_MS = 60 * 1000

function createApprovalBroker({ show, dismiss = () => {}, onClose = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, minTimeoutMs = () => 0, newId = () => crypto.randomUUID(), now = () => Date.now() }) {
  const queue = []
  let active = null

  function finish(item, outcome) {
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
    item.resolve(outcome)
  }

  function reportClosed(id, outcome) {
    try {
      onClose(id, outcome)
    } catch {
      // onClose threw; the question is over either way
    }
  }

  function closeActive(outcome, closeDialog) {
    if (!active) return
    const { item, timer } = active
    active = null
    clearTimeout(timer)
    finish(item, outcome)
    if (closeDialog) {
      try {
        dismiss(item.id)
      } catch {
        // dismiss threw; outcome already delivered to caller
      }
    }
    reportClosed(item.id, outcome)
    showNext()
  }

  /** The limit of one question: its own, or the longer one while answers may come from afar */
  function limitOf(item) {
    let least = 0
    try {
      least = Number(minTimeoutMs()) || 0
    } catch {
      // minTimeoutMs threw; the question keeps its own limit
    }
    return Math.max(item.timeoutMs, least)
  }

  function showNext() {
    while (!active && queue.length > 0) {
      const item = queue.shift()
      if (item.signal && item.signal.aborted) { finish(item, 'cancelled'); continue }
      const limit = limitOf(item)
      const shown = { ...item.details, id: item.id, expiresAt: now() + limit }
      let delivered
      try {
        delivered = show(shown)
      } catch {
        finish(item, 'denied')
        continue
      }
      if (!delivered) { finish(item, 'denied'); continue }
      active = { item, shown, timer: setTimeout(() => closeActive('expired', true), limit) }
    }
  }

  function cancel(id) {
    if (active && active.item.id === id) { closeActive('cancelled', true); return }
    const index = queue.findIndex(item => item.id === id)
    if (index >= 0) finish(queue.splice(index, 1)[0], 'cancelled')
  }

  /** `timeoutMs` gives this request its own time limit (a file change takes longer to read than a command). */
  function request(details, { signal, timeoutMs: ownTimeoutMs } = {}) {
    return new Promise((resolve) => {
      const hasOwnLimit = Number.isFinite(ownTimeoutMs) && ownTimeoutMs > 0
      const item = { id: newId(), details, resolve, signal, onAbort: null, timeoutMs: hasOwnLimit ? ownTimeoutMs : timeoutMs }
      if (signal) {
        if (signal.aborted) { resolve('cancelled'); return }
        item.onAbort = () => cancel(item.id)
        signal.addEventListener('abort', item.onAbort, { once: true })
      }
      queue.push(item)
      showNext()
    })
  }

  /** `closeDialog`: the answer did not come from the dialog (a remote device), so the dialog is closed too */
  function respond(id, approved, { closeDialog = false } = {}) {
    if (!active || active.item.id !== id) return false
    if (typeof approved !== 'boolean') return false
    closeActive(approved === true ? 'approved' : 'denied', closeDialog === true)
    return true
  }

  function cancelAll() {
    const waiting = queue.splice(0, queue.length)
    if (active) {
      const { item, timer } = active
      active = null
      clearTimeout(timer)
      finish(item, 'cancelled')
      try {
        dismiss(item.id)
      } catch {
        // dismiss threw; outcome already delivered to caller
      }
      reportClosed(item.id, 'cancelled')
    }
    waiting.forEach(item => finish(item, 'cancelled'))
  }

  return {
    request,
    respond,
    cancelAll,
    /** The question being asked now, as it was shown (for a device that connects while it waits); null when none */
    current: () => (active ? active.shown : null),
    pendingCount: () => queue.length + (active ? 1 : 0)
  }
}

module.exports = { createApprovalBroker }
