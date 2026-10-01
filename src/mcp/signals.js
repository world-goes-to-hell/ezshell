/** AbortSignal.any() does not exist on Node 18 */
function combineSignals(signals) {
  const controller = new AbortController()
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) { controller.abort(); break }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

module.exports = { combineSignals }
