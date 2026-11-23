const SELECTED_COMMAND = /^\s*›\s+\/(fast|ultrafast)\s{2,}\S/u
const TIER_NOTICE = /^\s*[•●]\s+Service tier set to (priority|fast|default|standard|ultrafast|flex)\s*$/iu
const MODEL_NOTICE = /^\s*[•●]\s+Model changed to (\S+)/iu
const MODEL_FOOTER = /^(gpt-[\w.-]+(?:\s+(?:astra|sol|terra|luna|codex))?)\s+(?:default|none|minimal|low|light|medium|high|xhigh|extra high|max|ultra)(?:\s+(fast|priority|ultrafast|flex))?$/i
const TIER_SEGMENT = /^(Fast|Priority|Standard|Default|Ultrafast|Flex)$/
const PROBE_RETRY_MS = 1500

const speedOf = tier => tier === 'priority' ? 'fast' : tier === 'default' || !tier ? 'standard' : tier
const notices = lines => lines.flatMap(line => TIER_NOTICE.exec(line)?.[1].toLowerCase() ?? [])

function hasCodexSpeedChoice(lines, speed) {
  return lines.some(line => SELECTED_COMMAND.exec(line)?.[1] === speed)
}

function codexSpeedFooter(lines) {
  const composer = lines.findLastIndex(line => /^\s*›(?:\s|$)/u.test(line))
  if (composer < 0) return null
  for (const line of lines.slice(composer + 1)) {
    const segments = line.split(/[·│|]/u).map(segment => segment.trim())
    const match = segments.map(segment => MODEL_FOOTER.exec(segment)).find(Boolean)
    if (!match) continue
    // The CLI can show the speed as its own status line item (e.g. “gpt-6.2-sol medium · Fast”).
    const tier = match[2] ?? segments.find(segment => TIER_SEGMENT.test(segment))
    return { model: match[1].toLowerCase().replace(/\s+/g, '-'), speed: speedOf(tier?.toLowerCase()) }
  }
  return null
}

/** This shell's selected speed and whether its current Codex model exposes Ultrafast. */
function createCodexSpeed({ lines, submit, probe, hold, isLive, timeout = 4500, pollMs = 40 }) {
  let pending = false
  let speed = null
  let model = null
  let ultrafastAvailable = null
  let probeAfter = 0
  let revision = 0
  let lastVisibleNotice
  let probeInFlight = null

  function invalidate() {
    ultrafastAvailable = null
    probeAfter = 0
    revision++
  }

  function read(screen = lines()) {
    const last = notices(screen).at(-1)
    if (last && last !== lastVisibleNotice) {
      lastVisibleNotice = last
      speed = speedOf(last)
    }
    const footer = codexSpeedFooter(screen)
    const visibleModel = footer?.model ?? screen.flatMap(line => MODEL_NOTICE.exec(line)?.[1].toLowerCase() ?? []).at(-1)
    if (visibleModel) {
      if (model && visibleModel !== model) invalidate()
      model = visibleModel
    }
    if (footer) speed = footer.speed
    return { speed, ultrafastAvailable: ultrafastAvailable ?? (speed === 'ultrafast') }
  }

  async function detectUltrafast() {
    if (pending || ultrafastAvailable !== null || Date.now() < probeAfter || !isLive()) return
    pending = true
    const started = revision
    try {
      probeInFlight = probe()
      const result = await probeInFlight
      if (isLive() && revision === started && result.ok) ultrafastAvailable = result.available
    } finally {
      if (revision === started) probeAfter = Date.now() + PROBE_RETRY_MS
      probeInFlight = null
      pending = false
    }
  }

  async function toggle(target) {
    if (pending) return { ok: false, reason: 'busy' }
    pending = true
    let held = false
    try {
      const beforeScreen = lines()
      const before = notices(beforeScreen)
      const beforeFooter = codexSpeedFooter(beforeScreen)
      const previous = read(beforeScreen).speed
      const expected = previous === target ? 'standard' : target
      const result = await submit(target)
      if (!result.ok) {
        if (target === 'ultrafast' && result.reason === 'speed-unavailable') ultrafastAvailable = false
        return result
      }
      if (!isLive()) return { ok: false, reason: 'not-agent' }
      hold(true)
      held = true
      const end = Date.now() + timeout
      do {
        if (!isLive()) return { ok: false, reason: 'not-agent' }
        const screen = lines()
        const current = notices(screen)
        const last = current.at(-1)
        const footer = codexSpeedFooter(screen)
        if (last && (last !== before.at(-1) || current.length > before.length)) {
          lastVisibleNotice = last
          speed = speedOf(last)
        } else if (previous !== null && footer?.speed === expected &&
            (!beforeFooter || beforeFooter.model === footer.model)) {
          speed = footer.speed
        } else {
          await new Promise(resolve => { const timer = setTimeout(resolve, pollMs); timer.unref?.() })
          continue
        }
        if (target === 'ultrafast') ultrafastAvailable = true
        return { ok: true }
      } while (Date.now() < end)
      return { ok: false, reason: 'speed-unconfirmed' }
    } finally {
      if (held) hold(false)
      pending = false
    }
  }

  return { read, toggle, detectUltrafast, invalidate, pendingProbe: () => probeInFlight }
}

module.exports = { createCodexSpeed, hasCodexSpeedChoice, codexSpeedFooter }
