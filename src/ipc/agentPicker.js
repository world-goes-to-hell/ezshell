// Changing a local agent's model or effort from the usage line (docs/plan/2026-11-20-agent-model-effort-picker.md).
// Neither CLI takes the choice as an argument: main enters the command, reads the picker the CLI draws,
// offers its choices to the window, then presses the keys the user's choice needs. Every key goes only
// while that very picker is on screen, and the last one is the footer's this-session-only key: the other
// would make the choice the user's default for new sessions.

/** The picker screens, by their title line */
const PICKER_TITLES = {
  claudeModel: /^\s*Select model\s*$/,
  codexModel: /^\s*Select Model and Effort\s*$/,
  codexEffort: /^\s*Select Reasoning Level\b/
}
// The key that applies the choice to this session only, as the picker's footer names it. Claude's max
// effort cannot be a default, so there Enter is the session key ("Enter to use this session only").
const SESSION_KEYS = [
  { hint: /\bs to use this session only\b/, key: 's' },
  { hint: /\bEnter to use this session only\b/, key: '\r' },
  { hint: /\bs session\b/, key: 's' }
]
// "❯ 2.  Opus 5.5 ✔   For complex work", "› 4. Extra high (current)  Extra high reasoning depth"
const OPTION = /^\s*([❯›>])?\s*(\d+)\.\s+(\S.*?)\s*$/u
// A list too long for the pane scrolls: Claude "↓ 3 more", Codex "↓"
const MORE_BELOW = /^\s*↓/u
const EFFORT_WORDS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/**
 * A numbered picker under its title, as far as the pane shows it: { options: [{ number, label, description,
 * current, isDefault }], selected (the number marked), numbers (every row's number), more } or null.
 * Choices are known by their number, not their row: a short pane scrolls the list.
 */
function readNumberedPicker(lines, title) {
  let top = -1
  lines.forEach((line, index) => { if (title.test(line)) top = index })
  if (top < 0) return null
  const options = []
  const numbers = []
  let selected = null
  let started = false
  let more = false
  for (const line of lines.slice(top + 1)) {
    const match = OPTION.exec(line)
    if (!match) {
      if (!started) continue
      // A description too long for a narrow pane goes on under it, indented: "and computer use."
      const continued = /^\s{4,}\S/.test(line) && !MORE_BELOW.test(line)
      if (continued) {
        const last = options.at(-1)
        if (last && last.number === numbers.at(-1)) last.description = `${last.description} ${line.trim()}`.trim()
        continue
      }
      more = MORE_BELOW.test(line)
      break
    }
    started = true
    const number = Number(match[2])
    numbers.push(number)
    if (match[1]) selected = number
    const [label, ...rest] = match[3].split(/\s{2,}/)
    // "More reasoning…" opens another list: not offered
    if (/…$/.test(label.trim())) continue
    options.push({
      number,
      label: label.replace(/\s*\((?:current|default)\)/g, '').replace(/\s*✔/u, '').trim(),
      description: rest.join(' ').trim(),
      current: /\(current\)|✔/u.test(label),
      isDefault: /\(default\)/.test(label)
    })
  }
  return options.length ? { options, selected, numbers, more } : null
}

/** Claude's /effort bar: the level words and the ▲ over the chosen one (numbered 1… from the left) */
function readClaudeEffort(lines) {
  const top = lines.findIndex(line => /^\s*Effort\s*$/.test(line))
  if (top < 0) return null
  for (let row = top + 1; row < lines.length; row++) {
    const words = [...lines[row].matchAll(/\S+/g)].filter(word => EFFORT_WORDS.has(word[0].toLowerCase()))
    if (words.length < 2) continue
    const marker = lines.slice(top, row).reverse().find(line => line.includes('▲'))
    if (!marker) return null
    const column = marker.indexOf('▲')
    const distance = word => (column >= word.index && column < word.index + word[0].length ? 0 : Math.abs(word.index + word[0].length / 2 - column))
    let selected = 0
    words.forEach((word, index) => { if (distance(word) < distance(words[selected])) selected = index })
    // The bar opens on the level in use: `current` is right when the picker has just opened
    const options = words.map((word, index) => ({ number: index + 1, label: word[0], description: '', current: index === selected, isDefault: false }))
    return { options, selected: selected + 1, numbers: options.map(option => option.number), more: false }
  }
  return null
}

const readers = {
  claudeModel: lines => readNumberedPicker(lines, PICKER_TITLES.claudeModel),
  claudeEffort: readClaudeEffort,
  codexModel: lines => readNumberedPicker(lines, PICKER_TITLES.codexModel),
  codexEffort: lines => readNumberedPicker(lines, PICKER_TITLES.codexEffort)
}
const sameName = (a, b) => a.toLowerCase().replace(/[\s-]/g, '') === b.toLowerCase().replace(/[\s-]/g, '')

// What the CLI says it applied, the newest line on screen: the usage line takes it at once (Codex's own
// report changes only with its next turn). "• Model changed to gpt-6.2-astra low for this session only",
// "⎿  Set model to Haiku 5.5 for this session only", "⎿  Set effort level to max (this session only): …"
const APPLIED = [
  { pattern: /Model changed to (\S+) ([a-z][a-z-]{0,11})\b/, read: match => ({ model: match[1], effort: match[2] }) },
  { pattern: /Set model to (.+?) for this session only/, read: match => ({ model: match[1].trim() }) },
  { pattern: /Set effort level to ([a-z][a-z-]{0,11}) \(this session only\)/, read: match => ({ effort: match[1] }) }
]

/** The model / effort the newest confirmation line on screen names, or null */
function appliedFromScreen(lines) {
  for (let row = lines.length - 1; row >= 0; row--) {
    for (const { pattern, read } of APPLIED) {
      const match = pattern.exec(lines[row])
      if (match) return read(match)
    }
  }
  return null
}

/**
 * One shell's picker. lines(): the agent's screen now; write(keys) → bool; submit(command) → { ok, reason }
 * (into the empty composer, Enter once drawn); hold(on): keep the inbox wake and chat lines out meanwhile;
 * appCursor(): the CLI asked for application cursor keys.
 */
function createAgentPicker({
  kind, lines, write, submit, hold, appCursor = () => false,
  pollMs = 40, stepTimeout = 1500, openTimeout = 8000, lateTimeout = 5000, idleTimeout = 60_000, settleMs = 400, quietMs = 90
}) {
  const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
  let state = null
  let counter = 0

  async function until(check, timeout = stepTimeout) {
    const end = Date.now() + timeout
    for (;;) {
      const value = check()
      if (value) return value
      if (Date.now() >= end) return null
      await sleep(pollMs)
    }
  }
  // A picker drawn over another (Codex's levels back to its models) is repainted in pieces: read once the
  // screen has stopped changing, or the two lists mix ("GPT-6.1-Solt)", then "Medium")
  async function settle() {
    let last = lines().join('\n')
    for (let tries = 0; tries < 20; tries++) {
      await sleep(quietMs)
      const now = lines().join('\n')
      if (now === last) return
      last = now
    }
  }
  const read = name => readers[name](lines())
  const anyPicker = () => Object.keys(readers).find(name => readers[name](lines()))
  const arrow = direction => (appCursor() ? '\x1bO' : '\x1b[') + direction
  const keysOf = name => (name === 'claudeEffort' ? ['D', 'C'] : ['A', 'B'])

  /**
   * Moves the selection of picker `name` to choice `number`, one key at a time, each seen on screen: 'ok',
   * 'gone' (the picker left the screen) or 'stuck' (the key did not move it: a level the model lacks)
   */
  async function moveTo(name, number) {
    const [back, forward] = keysOf(name)
    for (let step = 0; step < 60; step++) {
      const screen = read(name)
      if (!screen || screen.selected === null) return 'gone'
      if (screen.selected === number) return 'ok'
      const before = screen.selected
      if (!write(arrow(number > before ? forward : back))) return 'gone'
      const moved = await until(() => { const now = read(name); return !now || now.selected !== before })
      if (!moved) return read(name) ? 'stuck' : 'gone'
      await settle()
    }
    return 'stuck'
  }

  /**
   * Every choice of a list the pane scrolls: down to its end, gathering rows by number, then back to where
   * the selection was. A list that fits is read as it is.
   */
  async function collect(name) {
    await settle()
    const first = read(name)
    if (!first) return null
    const all = new Map(first.options.map(option => [option.number, option]))
    if (!first.more) return { options: first.options, start: first.selected }
    const [, forward] = keysOf(name)
    let current = first
    for (let step = 0; step < 60 && (current.more || current.selected !== Math.max(...current.numbers)); step++) {
      const before = current.selected
      if (!write(arrow(forward))) return null
      if (!(await until(() => { const now = read(name); return now && now.selected !== before }))) break
      await settle()
      const next = read(name)
      if (!next) return null
      for (const option of next.options) if (!all.has(option.number)) all.set(option.number, option)
      current = next
    }
    if ((await moveTo(name, first.selected)) !== 'ok') return null
    return { options: [...all.values()].sort((a, b) => a.number - b.number), start: first.selected }
  }

  /** A key only while that picker shows; then waits for the screen to leave it */
  async function press(name, key) {
    if (!read(name) || !write(key)) return false
    return Boolean(await until(() => !read(name)))
  }

  /** Ends with the footer's this-session-only key; presses nothing when the footer names none */
  async function finishWithSession(name) {
    const screen = lines().join('\n')
    const session = SESSION_KEYS.find(({ hint }) => hint.test(screen))
    if (!read(name) || !session) return false
    return press(name, session.key)
  }

  // Right after the picker closes the CLI is still drawing its composer back (an open at once found the
  // cursor off the prompt start): the picker counts as open until the screen has had this long
  async function release() {
    if (!state) return
    clearTimeout(state.timer)
    await sleep(settleMs)
    state = null
    hold(false)
  }

  async function backOut() {
    for (let tries = 0; tries < 3 && anyPicker(); tries++) {
      const before = anyPicker()
      if (!write('\x1b')) break
      await until(() => anyPicker() !== before)
    }
  }

  /** Whether the choices on screen are still the ones offered (same label under each number) */
  function sameChoices(screen) {
    return Boolean(screen) && screen.options.every(option => state.labels.get(option.number) === option.label)
  }

  const publicOptions = options => options.map(({ label, description, current }) => ({ label, description, current }))

  return {
    /**
     * Enters the command and returns the choices: { ok, token, options, complete } or { ok: false, reason }.
     * `collectAll: false` reads only what the pane shows (applying a known name needs no more); `complete`
     * says whether the list is the whole one.
     */
    async open(what, { collectAll = true } = {}) {
      if (state) return { ok: false, reason: 'busy' }
      if (what !== 'model' && what !== 'effort') return { ok: false, reason: 'changed' }
      const command = kind === 'claude' && what === 'effort' ? '/effort' : '/model'
      const entered = await submit(command)
      if (!entered.ok) return entered
      const token = `p${++counter}-${Date.now()}`
      state = { token, what, busy: true, timer: null }
      hold(true)
      const first = kind === 'claude' ? (what === 'model' ? 'claudeModel' : 'claudeEffort') : 'codexModel'
      const fail = async reason => { await backOut(); await release(); return { ok: false, reason } }
      // A CLI with a long conversation can take seconds to draw it
      if (!(await until(() => read(first), openTimeout))) {
        // Drawn after all, later: closed, never left open on the screen
        if (await until(anyPicker, lateTimeout)) await backOut()
        return fail('no-picker')
      }
      let name = first
      if (kind === 'codex') {
        // The levels belong to a model: the current model's list shows the current level
        const models = read('codexModel')
        const current = models.options.find(option => option.current)?.number ?? models.selected
        if (current === null || (await moveTo('codexModel', current)) !== 'ok' || !(await press('codexModel', '\r'))) return fail('changed')
        if (!(await until(() => read('codexEffort')))) return fail('changed')
        await settle()
        state.effort = read('codexEffort').options.find(option => option.current)?.label ?? null
        if (what === 'model') {
          // Back to the models (Esc on the levels goes back one list)
          if (!(await press('codexEffort', '\x1b')) || !(await until(() => read('codexModel')))) return fail('changed')
        } else {
          name = 'codexEffort'
        }
      }
      await settle()
      const visible = read(name)
      if (!visible) return fail('changed')
      const list = collectAll ? await collect(name) : { options: visible.options }
      if (!list) return fail('changed')
      const complete = collectAll || !visible.more
      Object.assign(state, {
        name, options: list.options, labels: new Map(list.options.map(option => [option.number, option.label])), complete, busy: false
      })
      state.timer = setTimeout(() => { void this.cancel(token) }, idleTimeout)
      state.timer.unref?.()
      return { ok: true, token, options: publicOptions(list.options), complete }
    },

    /** The whole list, then the picker closed again (the menu's refresh): { ok, options } or { ok: false, reason } */
    async list(what) {
      const opened = await this.open(what)
      if (!opened.ok) return opened
      await this.cancel(opened.token)
      return { ok: true, options: opened.options }
    },

    /**
     * Applies the choice of that name (the menu shows a remembered list): { ok, applied?, options? } or
     * { ok: false, reason, options? }. `options` is the whole fresh list when it was read; 'missing' when the
     * CLI no longer offers that name.
     */
    async apply(what, label) {
      const opened = await this.open(what, { collectAll: false })
      if (!opened.ok) return opened
      const find = () => state.options.findIndex(option => sameName(option.label, label))
      let index = find()
      if (index < 0 && !state.complete) {
        state.busy = true
        const list = await collect(state.name)
        if (!list) { await backOut(); await release(); return { ok: false, reason: 'changed' } }
        Object.assign(state, { options: list.options, labels: new Map(list.options.map(option => [option.number, option.label])), complete: true, busy: false })
        index = find()
      }
      const fresh = state.complete ? publicOptions(state.options) : null
      if (index < 0) {
        await this.cancel(opened.token)
        return { ok: false, reason: 'missing', ...(fresh ? { options: fresh } : {}) }
      }
      const result = await this.choose(opened.token, index)
      return fresh ? { ...result, options: fresh } : result
    },

    /** Picks choice `index` of what open offered: { ok } or { ok: false, reason } */
    async choose(token, index) {
      if (!state || state.token !== token || state.busy) return { ok: false, reason: 'changed' }
      const { name } = state
      const screen = read(name)
      const valid = Number.isInteger(index) && index >= 0 && index < state.options.length
      if (!valid || !sameChoices(screen)) {
        if (!sameChoices(screen)) { await backOut(); await release() }
        return { ok: false, reason: 'changed' }
      }
      state.busy = true
      clearTimeout(state.timer)
      const fail = async (reason = 'changed') => { await backOut(); await release(); return { ok: false, reason } }
      const moved = await moveTo(name, state.options[index].number)
      if (moved !== 'ok') return fail(moved === 'stuck' ? 'stuck' : 'changed')
      if (name === 'codexModel') {
        if (!(await press('codexModel', '\r')) || !(await until(() => read('codexEffort')))) return fail()
        await settle()
        const levels = read('codexEffort').options
        const level = levels.find(option => option.current)
          ?? (state.effort && levels.find(option => sameName(option.label, state.effort)))
          ?? levels.find(option => option.isDefault)
        if (level && (await moveTo('codexEffort', level.number)) !== 'ok') return fail()
        if (!(await finishWithSession('codexEffort'))) return fail()
      } else if (!(await finishWithSession(name))) {
        return fail()
      }
      await settle()
      const applied = appliedFromScreen(lines())
      await release()
      return applied ? { ok: true, applied } : { ok: true }
    },

    /** Closes the picker without a choice */
    async cancel(token) {
      if (!state || state.token !== token || state.busy) return
      state.busy = true
      await backOut()
      await release()
    },

    isOpen: () => state !== null
  }
}

module.exports = { createAgentPicker, readNumberedPicker, readClaudeEffort, appliedFromScreen, PICKER_TITLES }
