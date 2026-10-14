// Asks the user in the main window whether to trust a host key. The renderer only answers with the
// request id and a decision; what gets saved is decided in main from the refused key it kept.
const crypto = require('crypto')

const DEFAULT_TIMEOUT_MS = 120 * 1000

/**
 * `send(request)` delivers the question and returns false when there is no window to show it in.
 * `onDismiss(id)` is told when a question is withdrawn (timeout, dismissAll) so the window can close it.
 * `prompt(info)` resolves with 'trust' or 'reject'; it never rejects.
 */
function createHostKeyPrompter({ send, onDismiss = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  /** id → { key, resolvers, timer } */
  const pending = new Map()
  /** host:port:fingerprint → id, so several connections to one server share a question */
  const byKey = new Map()

  function settle(id, decision) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    byKey.delete(entry.key)
    clearTimeout(entry.timer)
    entry.resolvers.forEach(resolve => resolve(decision))
  }

  function withdraw(id) {
    if (!pending.has(id)) return
    settle(id, 'reject')
    onDismiss(id)
  }

  function prompt(info) {
    const key = `${info.host}:${info.port}:${info.status}:${info.fingerprint}`
    const sharedId = byKey.get(key)
    if (sharedId) {
      return new Promise(resolve => { pending.get(sharedId).resolvers.push(resolve) })
    }
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const entry = { key, resolvers: [resolve], timer: null }
      pending.set(id, entry)
      byKey.set(key, id)
      let delivered = false
      try {
        delivered = send({ ...info, id }) !== false
      } catch (err) {
        console.error('Failed to show the host key prompt:', err.message)
      }
      if (!delivered) { settle(id, 'reject'); return }
      entry.timer = setTimeout(() => withdraw(id), timeoutMs)
    })
  }

  function respond(id, decision) {
    settle(id, decision === 'trust' ? 'trust' : 'reject')
  }

  function dismissAll() {
    ;[...pending.keys()].forEach(withdraw)
  }

  return { prompt, respond, dismissAll }
}

module.exports = { createHostKeyPrompter }
