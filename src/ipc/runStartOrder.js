const http = require('node:http')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

const MAX_STAGES = 50
const ORDER_ERROR = '단계와 실행 구성 목록을 확인해 주세요.'
const DEFAULT_OPTIONS = { timeoutSeconds: 300, onTimeout: 'pause', reverseStop: true, askDependencies: true }
const HEALTH_INTERVAL_MS = 30_000
const HEALTH_TIMEOUT_MS = 3_000
const MAX_HEALTH_CHECKS = 4

function loopbackUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\p{Cc}]/u.test(value)
      || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?]|$)/i.test(value)) return null
  try {
    const url = new URL(value)
    return url.hash || url.port === '0' ? null : url
  } catch { return null }
}

function healthUrl(value) {
  const url = loopbackUrl(value)
  return url?.protocol === 'http:' ? url : null
}

function validateGate(gate) {
  if (gate?.kind === 'none' || gate?.kind === 'ready') return { kind: gate.kind }
  if (gate?.kind === 'log') {
    if (typeof gate.value !== 'string' || !gate.value.trim() || Array.from(gate.value).length > 200
      || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(gate.value)) throw new Error('로그 문구는 제어 문자 없이 한 줄에 200자까지 입력해 주세요.')
    return { kind: 'log', value: gate.value }
  }
  if (gate?.kind === 'url') {
    const url = healthUrl(gate.value)
    if (!url) throw new Error('헬스 URL에는 http://127.0.0.1, http://localhost, http://[::1] 주소만 쓸 수 있습니다.')
    return { kind: 'url', value: url.href }
  }
  throw new Error('다음 단계로 넘어가는 기준을 골라 주세요.')
}

function legacyStartOrder(presets) {
  const included = presets.filter(preset => preset.inAll)
  return { ...DEFAULT_OPTIONS, stages: included.map((preset, index) => ({
    ids: [preset.id], gate: { kind: included[index + 1]?.waitReady ? 'ready' : 'none' }
  })) }
}

function validateStartOrder(input, presets) {
  if (!input || !Array.isArray(input.stages) || input.stages.length > MAX_STAGES) throw new Error(ORDER_ERROR)
  const ids = new Set(presets.map(preset => preset.id))
  const stages = input.stages.map(stage => {
    if (!Array.isArray(stage?.ids) || !stage.ids.length || stage.ids.length > MAX_STAGES) throw new Error(ORDER_ERROR)
    for (const id of stage.ids) if (!ids.delete(id)) throw new Error(ORDER_ERROR)
    return { ids: [...stage.ids], gate: validateGate(stage.gate) }
  })
  const { timeoutSeconds, onTimeout, reverseStop, askDependencies } = input
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('기다리는 시간은 1~3600초로 입력해 주세요.')
  if (!['pause', 'continue'].includes(onTimeout) || typeof reverseStop !== 'boolean' || typeof askDependencies !== 'boolean') {
    throw new Error('기동 순서 옵션을 확인해 주세요.')
  }
  return { stages, timeoutSeconds, onTimeout, reverseStop, askDependencies }
}

function restoreStartOrder(input, presets) {
  if (!Array.isArray(input?.stages) || input.stages.length > MAX_STAGES) throw new Error(ORDER_ERROR)
  const known = new Set(presets.map(preset => preset.id))
  const stages = input.stages.map(stage => {
    if (!Array.isArray(stage?.ids) || stage.ids.length > MAX_STAGES) throw new Error(ORDER_ERROR)
    return { ...stage, ids: stage.ids.filter(id => known.has(id)) }
  }).filter(stage => stage.ids.length)
  return reconcileStartOrder(validateStartOrder({ ...input, stages }, presets), presets)
}

/** Preset edits keep existing steps and add newly included presets at the end. */
function reconcileStartOrder(order, presets) {
  if (!order) return legacyStartOrder(presets)
  const remaining = new Set(presets.filter(preset => preset.inAll).map(preset => preset.id))
  const stages = order.stages.map(stage => ({ ...stage, ids: stage.ids.filter(id => remaining.delete(id)) })).filter(stage => stage.ids.length)
  for (const id of remaining) stages.push({ ids: [id], gate: { kind: 'none' } })
  return { ...order, stages }
}

/** The same ordered stages work for all presets or a subset, such as a single start with prerequisites. */
function selectStartStages(order, ids, presetIds = []) {
  if (!ids) return order.stages
  const selected = new Set(ids)
  const stages = order.stages.map(stage => ({ ...stage, ids: stage.ids.filter(id => selected.delete(id)) })).filter(stage => stage.ids.length)
  for (const id of presetIds) if (selected.delete(id)) stages.push({ ids: [id], gate: { kind: 'none' } })
  return stages
}

function stopStages(order, presets) {
  const included = new Set(order.stages.flatMap(stage => stage.ids))
  const outside = presets.filter(preset => !included.has(preset.id)).map(preset => preset.id)
  return order.reverseStop ? [outside, ...order.stages.map(stage => stage.ids).reverse()] : [presets.map(preset => preset.id)]
}

function loopbackHosts({ hostname }) {
  return hostname === 'localhost' ? ['127.0.0.1', '::1'] : [hostname.replace(/^\[|\]$/g, '')]
}

function checkHttp(url, host, signal) {
  return new Promise(resolve => {
    const probe = http.get({ host, port: url.port || 80, path: url.pathname + url.search, headers: { Host: url.host },
      agent: false, signal }, response => {
      resolve(response.statusCode >= 200 && response.statusCode < 300)
      response.destroy()
    })
    probe.once('error', () => resolve(false))
  })
}

async function healthy(value, signal) {
  const url = healthUrl(value)
  if (!url || signal.aborted) return false
  const checks = loopbackHosts(url).map(host => checkHttp(url, host, AbortSignal.any([signal, AbortSignal.timeout(850)])))
  return (await Promise.all(checks)).some(Boolean)
}

function runHealthTarget(gate, address) {
  if (gate?.kind === 'url') {
    const url = healthUrl(gate.value)
    return url && { kind: 'url', value: url.href }
  }
  if (gate?.kind === 'ready') {
    const url = loopbackUrl(address)
    return url && { kind: 'port', value: url.origin }
  }
  return null
}

function checkPort(url, host, signal) {
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  return new Promise(resolve => {
    const socket = net.connect({ host, port, signal })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function probeRunHealth(target, signal) {
  const check = target.kind === 'url' ? checkHttp : checkPort
  const url = target.kind === 'url' ? healthUrl(target.value) : loopbackUrl(target.value)
  if (!url) return false
  // Use literal loopback addresses and try one socket at a time. HTTP redirects stay unread.
  for (const host of loopbackHosts(url)) {
    if (signal.aborted) return false
    if (await check(url, host, signal)) return true
  }
  return false
}

function createRunHealthMonitor({ onChange, now = Date.now, probe = probeRunHealth }) {
  const entries = new Map()
  let timer
  let checking = false
  let closed = false

  async function check(run, entry) {
    const controller = new AbortController()
    entry.controller = controller
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true }))
    let responsive
    try { responsive = await Promise.race([probe(entry.target, controller.signal), aborted]) }
    catch { responsive = false }
    finally { clearTimeout(timeout) }
    if (entries.get(run) !== entry) return
    entry.controller = undefined
    if (responsive && !controller.signal.aborted) {
      if (entry.failures >= 2) onChange(run, undefined)
      entry.failures = 0
    } else if (++entry.failures === 2) onChange(run, { since: now() })
  }

  async function checkAll() {
    if (checking) return
    checking = true
    const queue = [...entries][Symbol.iterator]()
    const worker = async () => {
      for (const [run, entry] of queue) if (entries.get(run) === entry) await check(run, entry)
    }
    try { await Promise.all(Array.from({ length: Math.min(MAX_HEALTH_CHECKS, entries.size) }, worker)) }
    finally { checking = false }
  }

  function setTarget(run, target) {
    if (closed) return false
    const current = entries.get(run)
    if (current?.target.kind === target?.kind && current?.target.value === target?.value) return false
    current?.controller?.abort()
    if (target) entries.set(run, { target, failures: 0 })
    else entries.delete(run)
    if (entries.size && !timer) {
      timer = setInterval(checkAll, HEALTH_INTERVAL_MS)
      timer.unref?.()
    } else if (!entries.size) {
      clearInterval(timer)
      timer = undefined
    }
    return true
  }

  function close() {
    for (const run of entries.keys()) setTarget(run, null)
    closed = true
  }

  return { setTarget, close }
}

/**
 * Start stages in parallel groups, guarding earlier services until the last group has launched.
 * The controller owns the cursor across pauses and can rewind it for retry.
 */
async function runStartStages(batch, { start, active, failed, meets, publish, signal, check = () => {}, now = Date.now, probe = healthy, pollMs = 160 }) {
  const { stages, ignored, startedIds } = batch
  const deadBefore = index => {
    for (let prior = 0; prior < index; prior++) {
      const ids = stages[prior].ids.filter(id => !ignored.has(id) && failed(id))
      if (ids.length) return { reason: 'exited', index: prior, ids }
    }
    return null
  }
  while (batch.index < stages.length) {
    signal.throwIfAborted()
    check()
    const index = batch.index
    const { gate } = stages[index]
    const fault = deadBefore(index)
    if (fault) return fault
    const ids = stages[index].ids.filter(id => !ignored.has(id))
    const targets = ids.filter(id => !startedIds.has(id) || failed(id))
    publish({ status: 'starting', index })
    const results = await Promise.allSettled(targets.map(id => start(id)))
    signal.throwIfAborted()
    const failures = []
    results.forEach((result, at) => {
      if (result.status === 'fulfilled') startedIds.add(targets[at])
      else failures.push(targets[at])
    })
    if (failures.length) return { reason: 'startFailed', index, ids: failures, error: results.find(result => result.status === 'rejected').reason }
    const earlier = deadBefore(index)
    if (earlier) return earlier
    const exited = ids.filter(failed)
    if (exited.length) return { reason: 'exited', index, ids: exited }
    if (ids.some(active) && index + 1 < stages.length && gate.kind !== 'none' && !batch.skippedGates.has(index)) {
      const started = now()
      const deadline = started + batch.timeoutSeconds * 1000
      let shown = ids.filter(active)
      publish({ status: 'waiting', index, gate, since: started, ids: shown })
      while (true) {
        signal.throwIfAborted()
        check()
        const earlier = deadBefore(index)
        if (earlier) return earlier
        const exited = ids.filter(failed)
        if (exited.length) return { reason: 'exited', index, ids: exited }
        const running = ids.filter(active)
        if (!running.length) break
        const pending = gate.kind === 'url'
          ? !await probe(gate.value, signal) && running
          : running.filter(id => !meets(id, gate))
        signal.throwIfAborted()
        if (!pending || !pending.length) break
        if (shown.length !== pending.length || pending.some((id, at) => id !== shown[at])) {
          shown = pending
          publish({ status: 'waiting', index, gate, since: started, ids: pending })
        }
        const remaining = deadline - now()
        if (remaining <= 0) {
          if (batch.onTimeout === 'pause') return { reason: 'timeout', index, ids: pending }
          break
        }
        await delay(Math.min(pollMs, remaining), undefined, { signal })
      }
    }
    batch.index++
  }
  return null
}

module.exports = { legacyStartOrder, validateStartOrder, restoreStartOrder, reconcileStartOrder, selectStartStages, stopStages, runStartStages,
  runHealthTarget, probeRunHealth, createRunHealthMonitor }
