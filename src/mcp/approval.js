// Queue of "may Claude run this?" questions for the user. One dialog at a time;
// no answer within the timeout means no.
const crypto = require('crypto')

const DEFAULT_TIMEOUT_MS = 60 * 1000

function createApprovalBroker({ show, dismiss = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, newId = () => crypto.randomUUID(), now = () => Date.now() }) {
  const queue = []
  let active = null

  function finish(item, outcome) {
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
    item.resolve(outcome)
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
    showNext()
  }

  function showNext() {
    while (!active && queue.length > 0) {
      const item = queue.shift()
      if (item.signal && item.signal.aborted) { finish(item, 'cancelled'); continue }
      let delivered
      try {
        delivered = show({ ...item.details, id: item.id, expiresAt: now() + timeoutMs })
      } catch {
        finish(item, 'denied')
        continue
      }
      if (!delivered) { finish(item, 'denied'); continue }
      active = { item, timer: setTimeout(() => closeActive('expired', true), timeoutMs) }
    }
  }

  function cancel(id) {
    if (active && active.item.id === id) { closeActive('cancelled', true); return }
    const index = queue.findIndex(item => item.id === id)
    if (index >= 0) finish(queue.splice(index, 1)[0], 'cancelled')
  }

  function request(details, { signal } = {}) {
    return new Promise((resolve) => {
      const item = { id: newId(), details, resolve, signal, onAbort: null }
      if (signal) {
        if (signal.aborted) { resolve('cancelled'); return }
        item.onAbort = () => cancel(item.id)
        signal.addEventListener('abort', item.onAbort, { once: true })
      }
      queue.push(item)
      showNext()
    })
  }

  function respond(id, approved) {
    if (!active || active.item.id !== id) return false
    if (typeof approved !== 'boolean') return false
    closeActive(approved === true ? 'approved' : 'denied', false)
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
    }
    waiting.forEach(item => finish(item, 'cancelled'))
  }

  return { request, respond, cancelAll, pendingCount: () => queue.length + (active ? 1 : 0) }
}

module.exports = { createApprovalBroker }
