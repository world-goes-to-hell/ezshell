import { describe, expect, it } from 'vitest'
import { createAgentPicker, readNumberedPicker, readClaudeEffort, appliedFromScreen, PICKER_TITLES } from './agentPicker.js'

// Screens as Claude Code and Codex 0.170 draw them (this PC, 2026-11-20)
const CLAUDE_MODELS = ['Default (recommended)  Opus 5.5 · Best for everyday, complex tasks', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_MODELS = ['GPT-6.2-Sol', 'GPT-6.2-Astra', 'GPT-6.1 Terra']
const CODEX_EFFORTS = ['Low', 'Medium', 'High', 'Extra high']

function claudeModelScreen(selected, current, effort) {
  return [
    '● cctop: loaded',
    '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
    '  Select model',
    '  Your pick is the default for new sessions. For other models, use --model.',
    ...CLAUDE_MODELS.map((model, index) => {
      const [label, description = 'For complex work'] = model.split(/\s{2,}/)
      return `  ${index === selected ? '❯' : ' '} ${index + 1}.  ${label}${index === current ? ' ✔' : ''}             ${description}`
    }),
    '    ▸   More models',
    `  ● ${effort} effort ←/→ to adjust`,
    '  s to use this session only · Enter to save · Esc to cancel'
  ]
}

function claudeEffortScreen(selected) {
  // At max the footer changes: max cannot be a default, Enter applies it to this session
  const footer = CLAUDE_EFFORTS[selected] === 'max'
    ? '  ←/→ to adjust · Enter to use this session only · Esc to cancel'
    : '  ←/→ to adjust · s to use this session only · Enter to save · Esc to cancel'
  const labels = '                        low     medium     high     xhigh      max      Tab to toggle'
  const column = labels.indexOf(CLAUDE_EFFORTS[selected] === 'high' ? ' high ' : CLAUDE_EFFORTS[selected]) + (CLAUDE_EFFORTS[selected] === 'high' ? 2 : 1)
  const rule = '                        ' + '─'.repeat(42)
  return [
    '  Effort',
    '                        Faster                             Smarter',
    rule.slice(0, column) + '▲' + rule.slice(column + 1) + '      Ultracode  off',
    labels,
    footer
  ]
}

const codexModelScreen = (selected, current) => [
  '  Select Model and Effort',
  ...CODEX_MODELS.map((model, index) => `${index === selected ? '›' : ' '} ${index + 1}. ${model}${index === current ? ' (current)' : ''}  Fast model.`),
  '  enter select · esc back'
]
const codexEffortScreen = (model, selected, current) => [
  `  Select Reasoning Level for ${model}`,
  ...CODEX_EFFORTS.map((effort, index) => `${index === selected ? '›' : ' '} ${index + 1}. ${effort}${index === 0 ? ' (default)' : ''}${index === current ? ' (current)' : ''}  Reasoning.`),
  `${CODEX_EFFORTS.length === selected ? '›' : ' '} 5. More reasoning…  Max and Ultra consume usage limits faster`,
  '  enter default · s session · esc back'
]
const COMPOSER = ['› Ask Codex to do anything']

/** A fake CLI: the screen follows the keys it gets, like the real pickers */
function fakeCli(kind, { model = 1, effort = 2, composerEmpty = true, opens = true } = {}) {
  const cli = { kind, view: 'composer', model, effort, sel: 0, applied: [], keys: [], composerEmpty, opens }
  cli.lines = () => {
    if (cli.view === 'claude-model') return claudeModelScreen(cli.sel, cli.model, CLAUDE_EFFORTS[cli.effort][0].toUpperCase() + CLAUDE_EFFORTS[cli.effort].slice(1))
    if (cli.view === 'claude-effort') return claudeEffortScreen(cli.sel)
    if (cli.view === 'codex-model') return codexModelScreen(cli.sel, cli.model)
    if (cli.view === 'codex-effort') return codexEffortScreen(CODEX_MODELS[cli.pending], cli.sel, cli.pending === cli.model ? cli.effort : -1)
    return kind === 'claude' ? ['────────', '❯ ', '────────'] : COMPOSER
  }
  cli.submit = async text => {
    if (!cli.composerEmpty) return { ok: false, reason: 'composer-not-empty' }
    cli.keys.push(text + '⏎')
    if (!cli.opens) return { ok: true }
    if (text === '/model') { cli.view = kind === 'claude' ? 'claude-model' : 'codex-model'; cli.sel = cli.model }
    if (text === '/effort') { cli.view = 'claude-effort'; cli.sel = cli.effort }
    return { ok: true }
  }
  const count = { 'claude-model': CLAUDE_MODELS.length, 'claude-effort': CLAUDE_EFFORTS.length, 'codex-model': CODEX_MODELS.length, 'codex-effort': CODEX_EFFORTS.length + 1 }
  cli.write = data => {
    cli.keys.push(data)
    const up = data === '\x1b[A' || data === '\x1b[D'
    const down = data === '\x1b[B' || data === '\x1b[C'
    if (up || down) { cli.sel = Math.max(0, Math.min(count[cli.view] - 1, cli.sel + (down ? 1 : -1))); return true }
    if (data === '\x1b') {
      if (cli.view === 'codex-effort') { cli.view = 'codex-model'; cli.sel = cli.pending } else cli.view = 'composer'
      return true
    }
    if (data === '\r' && cli.view === 'codex-model') { cli.pending = cli.sel; cli.view = 'codex-effort'; cli.sel = cli.sel === cli.model ? cli.effort : 0; return true }
    if (data === '\r' || data === 's') {
      const atMax = cli.view === 'claude-effort' && CLAUDE_EFFORTS[cli.sel] === 'max'
      if (atMax && data === 's') return true
      const mode = data === 's' || atMax ? 'session' : 'default'
      if (cli.view === 'claude-model') cli.applied.push({ model: cli.sel, mode })
      if (cli.view === 'claude-effort') cli.applied.push({ effort: cli.sel, mode })
      if (cli.view === 'codex-effort') cli.applied.push({ model: cli.pending, effort: cli.sel, mode })
      cli.view = 'composer'
    }
    return true
  }
  return cli
}

function pickerFor(cli, options = {}) {
  const held = []
  const picker = createAgentPicker({
    kind: cli.kind, lines: cli.lines, write: cli.write, submit: cli.submit, hold: value => held.push(value),
    pollMs: 1, stepTimeout: 60, openTimeout: 120, lateTimeout: 60, idleTimeout: 1000, settleMs: 0, quietMs: 1, ...options
  })
  return { picker, held }
}

describe('reading the pickers', () => {
  it('reads Claude\'s model list: the choices, the current one and the selection, without "More models"', () => {
    const screen = readNumberedPicker(claudeModelScreen(2, 1, 'High'), PICKER_TITLES.claudeModel)
    expect(screen.options.map(option => option.label)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'])
    expect(screen.options[0].description).toBe('Opus 5.5 · Best for everyday, complex tasks')
    expect(screen.options.map(option => option.current)).toEqual([false, true, false, false, false])
    expect(screen.selected).toBe(3)
    expect(screen.options.map(option => option.number)).toEqual([1, 2, 3, 4, 5])
  })

  it('reads Codex\'s lists: (current) and (default) marks, without "More reasoning…"', () => {
    const models = readNumberedPicker(codexModelScreen(0, 0), PICKER_TITLES.codexModel)
    expect(models.options.map(option => [option.label, option.current])).toEqual([['GPT-6.2-Sol', true], ['GPT-6.2-Astra', false], ['GPT-6.1 Terra', false]])
    const efforts = readNumberedPicker(codexEffortScreen('GPT-6.2-Sol', 3, 3), PICKER_TITLES.codexEffort)
    expect(efforts.options.map(option => option.label)).toEqual(CODEX_EFFORTS)
    expect(efforts.options[0].isDefault).toBe(true)
    expect(efforts.options[3].current).toBe(true)
    expect(efforts.selected).toBe(4)
  })

  it('reads a list whose descriptions wrap in a narrow pane (Codex at 82 columns)', () => {
    const screen = readNumberedPicker([
      '  Select Model and Effort',
      '',
      '› 1. GPT-6.2-Sol (current)  Fast, go-to model for coding and everyday work.',
      '  2. GPT-6.2-Astra          Our most capable model for complex coding and',
      '                            professional work.',
      '  3. GPT-6.1 Terra          Efficient model that excels at visual understanding',
      '                            and computer use.',
      '  4. GPT-6-Sol              Legacy model for coding and everyday work.',
      '↓',
      '  enter select · esc back'
    ], PICKER_TITLES.codexModel)
    expect(screen.options.map(option => option.label)).toEqual(['GPT-6.2-Sol', 'GPT-6.2-Astra', 'GPT-6.1 Terra', 'GPT-6-Sol'])
    expect(screen.options[2].description).toBe('Efficient model that excels at visual understanding and computer use.')
    expect(screen.more).toBe(true)
  })

  it('reads Claude\'s effort bar from the ▲ over its labels', () => {
    for (let index = 0; index < CLAUDE_EFFORTS.length; index++) {
      const screen = readClaudeEffort(claudeEffortScreen(index))
      expect(screen.options.map(option => option.label)).toEqual(CLAUDE_EFFORTS)
      expect(screen.selected).toBe(index + 1)
    }
  })

  it('reads what the CLI says it applied, the newest line first', () => {
    expect(appliedFromScreen([
      '• Model changed to gpt-6.2-sol xhigh for this session only',
      '• Model changed to gpt-6.2-astra low for this session only',
      '› Ask Codex to do anything'
    ])).toEqual({ model: 'gpt-6.2-astra', effort: 'low' })
    expect(appliedFromScreen(['  ⎿  Set model to Haiku 5.5 for this session only'])).toEqual({ model: 'Haiku 5.5' })
    expect(appliedFromScreen(['  ⎿  Set effort level to max (this session only): Maximum capability'])).toEqual({ effort: 'max' })
    expect(appliedFromScreen(['  ⎿  Kept model as Opus 5.5', '› '])).toBeNull()
  })

  it('finds nothing on other screens', () => {
    expect(readNumberedPicker(COMPOSER, PICKER_TITLES.codexModel)).toBeNull()
    expect(readClaudeEffort(COMPOSER)).toBeNull()
    // A numbered list in an answer is not a picker without its title
    expect(readNumberedPicker(['1. Yes', '2. No'], PICKER_TITLES.claudeModel)).toBeNull()
  })
})

describe('changing the model and effort', () => {
  it('Claude model: opens /model, moves with the arrows and ends with s (this session only)', async () => {
    const cli = fakeCli('claude', { model: 1 })
    const { picker, held } = pickerFor(cli)
    const opened = await picker.open('model')
    expect(opened.ok).toBe(true)
    expect(opened.options.map(option => option.label)).toContain('Sonnet 5.5')
    expect(await picker.choose(opened.token, 3)).toEqual({ ok: true })
    expect(cli.applied).toEqual([{ model: 3, mode: 'session' }])
    expect(cli.keys).toEqual(['/model⏎', '\x1b[B', '\x1b[B', 's'])
    expect(held).toEqual([true, false])
  })

  it('Claude effort: opens /effort and moves the ▲ with ←/→', async () => {
    const cli = fakeCli('claude', { effort: 2 })
    const { picker } = pickerFor(cli)
    const opened = await picker.open('effort')
    expect(opened.options.map(option => option.label)).toEqual(CLAUDE_EFFORTS)
    expect(opened.options[2].current).toBe(true)
    expect(await picker.choose(opened.token, 0)).toEqual({ ok: true })
    expect(cli.applied).toEqual([{ effort: 0, mode: 'session' }])
    expect(cli.keys).toEqual(['/effort⏎', '\x1b[D', '\x1b[D', 's'])
  })

  it('Claude effort max: the footer names Enter as the this-session key there, so it ends with Enter', async () => {
    const cli = fakeCli('claude', { effort: 3 })
    const { picker } = pickerFor(cli)
    const opened = await picker.open('effort')
    expect(await picker.choose(opened.token, 4)).toEqual({ ok: true })
    expect(cli.applied).toEqual([{ effort: 4, mode: 'session' }])
    expect(cli.keys.at(-1)).toBe('\r')
  })

  it('presses no final key when the footer names no this-session key', async () => {
    const cli = fakeCli('claude', { model: 1 })
    const lines = cli.lines
    cli.lines = () => lines().filter(line => !line.includes('session only'))
    const { picker } = pickerFor(cli)
    const opened = await picker.open('model')
    expect(await picker.choose(opened.token, 2)).toEqual({ ok: false, reason: 'changed' })
    expect(cli.keys).not.toContain('s')
    expect(cli.keys).not.toContain('\r')
    expect(cli.applied).toEqual([])
  })

  it('Codex model: Enter on the model, then keeps the current effort in the next list and ends with s', async () => {
    const cli = fakeCli('codex', { model: 0, effort: 3 })
    const { picker } = pickerFor(cli)
    const opened = await picker.open('model')
    expect(await picker.choose(opened.token, 1)).toEqual({ ok: true })
    // A model without the current effort marked: the same name as before (Extra high)
    expect(cli.applied).toEqual([{ model: 1, effort: 3, mode: 'session' }])
    expect(cli.keys.at(-1)).toBe('s')
  })

  it('Codex effort: opens /model, takes the current model with Enter and offers its levels', async () => {
    const cli = fakeCli('codex', { model: 0, effort: 3 })
    const { picker } = pickerFor(cli)
    const opened = await picker.open('effort')
    expect(opened.options.map(option => option.label)).toEqual(CODEX_EFFORTS)
    expect(await picker.choose(opened.token, 1)).toEqual({ ok: true })
    expect(cli.applied).toEqual([{ model: 0, effort: 1, mode: 'session' }])
  })

  it('uses the application cursor keys when the CLI asks for them', async () => {
    const cli = fakeCli('claude', { model: 1 })
    const write = cli.write
    cli.write = data => write(data === '\x1bOB' ? '\x1b[B' : data === '\x1bOA' ? '\x1b[A' : data)
    const { picker } = pickerFor(cli, { appCursor: () => true })
    const opened = await picker.open('model')
    await picker.choose(opened.token, 2)
    expect(cli.keys).toContain('\x1b[B')
  })
})

describe('a remembered list (list, apply by name)', () => {
  it('list reads the whole list and closes the picker again', async () => {
    const cli = fakeCli('codex', { model: 0, effort: 3 })
    const { picker, held } = pickerFor(cli)
    const listed = await picker.list('model')
    expect(listed.ok).toBe(true)
    expect(listed.options.map(option => option.label)).toEqual(CODEX_MODELS)
    expect(cli.view).toBe('composer')
    expect(cli.applied).toEqual([])
    expect(held.at(-1)).toBe(false)
  })

  it('apply finds the name on screen and applies it for this session, returning the fresh list', async () => {
    const cli = fakeCli('claude', { model: 1 })
    const { picker } = pickerFor(cli)
    const result = await picker.apply('model', 'Sonnet 5.5')
    expect(result.ok).toBe(true)
    expect(result.options.map(option => option.label)).toContain('Haiku 5.5')
    expect(cli.applied).toEqual([{ model: 3, mode: 'session' }])
  })

  it('apply matches names as the CLIs print them ("Extra high" for xhigh)', async () => {
    const cli = fakeCli('codex', { model: 0, effort: 1 })
    const { picker } = pickerFor(cli)
    expect((await picker.apply('effort', 'extra high')).ok).toBe(true)
    expect(cli.applied).toEqual([{ model: 0, effort: 3, mode: 'session' }])
  })

  it('apply says "missing" with the fresh list when the CLI no longer offers the name, and backs out', async () => {
    const cli = fakeCli('claude', { model: 1 })
    const { picker } = pickerFor(cli)
    const result = await picker.apply('model', 'Opus 4.1')
    expect(result).toMatchObject({ ok: false, reason: 'missing' })
    expect(result.options.map(option => option.label)).toContain('Opus 5.5')
    expect(cli.view).toBe('composer')
    expect(cli.applied).toEqual([])
  })
})

describe('a short pane', () => {
  it('collects every choice of a list the pane scrolls ("↓ 3 more") and picks by number', async () => {
    const cli = fakeCli('claude', { model: 1 })
    // Three rows fit: the window follows the selection, as Claude draws it in a low pane
    cli.lines = () => {
      if (cli.view !== 'claude-model') return ['────────', '❯ ', '────────']
      const first = Math.max(0, Math.min(cli.sel - 1, CLAUDE_MODELS.length - 3))
      const rows = CLAUDE_MODELS.slice(first, first + 3).map((model, offset) => {
        const index = first + offset
        return `  ${index === cli.sel ? '❯' : ' '} ${index + 1}.  ${model.split(/\s{2,}/)[0]}${index === cli.model ? ' ✔' : ''}     Text`
      })
      const below = CLAUDE_MODELS.length - first - 3
      return ['  Select model', ...rows, ...(below > 0 ? [`    ↓ ${below} more`] : []), '  ● High effort ←/→ to adjust', '  s to use this session only · Enter to save · Esc to cancel']
    }
    const { picker } = pickerFor(cli)
    const opened = await picker.open('model')
    expect(opened.options.map(option => option.label)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'])
    // Back where it was after gathering
    expect(cli.sel).toBe(1)
    expect(await picker.choose(opened.token, 4)).toEqual({ ok: true })
    expect(cli.applied).toEqual([{ model: 4, mode: 'session' }])
  })

  it('closes a picker the CLI draws only after the wait ran out', async () => {
    const cli = fakeCli('codex')
    const submit = cli.submit
    cli.submit = async text => {
      const result = await submit(text)
      const view = cli.view
      cli.view = 'composer'
      setTimeout(() => { cli.view = view }, 160)
      return result
    }
    const { picker, held } = pickerFor(cli)
    expect(await picker.open('model')).toEqual({ ok: false, reason: 'no-picker' })
    expect(cli.view).toBe('composer')
    expect(cli.keys.at(-1)).toBe('\x1b')
    expect(held.at(-1)).toBe(false)
  })
})

describe('refusing and backing out', () => {
  it('passes on why the command could not be entered (a draft in the composer)', async () => {
    const cli = fakeCli('codex', { composerEmpty: false })
    const { picker, held } = pickerFor(cli)
    expect(await picker.open('model')).toEqual({ ok: false, reason: 'composer-not-empty' })
    expect(held).toEqual([])
  })

  it('sends no key when the picker does not appear', async () => {
    const cli = fakeCli('claude', { opens: false })
    const { picker, held } = pickerFor(cli)
    expect(await picker.open('model')).toEqual({ ok: false, reason: 'no-picker' })
    expect(cli.keys).toEqual(['/model⏎'])
    expect(held).toEqual([true, false])
  })

  it('cancel presses Esc until the picker is gone (twice from Codex\'s level list)', async () => {
    const cli = fakeCli('codex', { model: 0, effort: 3 })
    const { picker, held } = pickerFor(cli)
    const opened = await picker.open('effort')
    await picker.cancel(opened.token)
    expect(cli.view).toBe('composer')
    expect(cli.keys.slice(-2)).toEqual(['\x1b', '\x1b'])
    expect(cli.applied).toEqual([])
    expect(held.at(-1)).toBe(false)
  })

  it('refuses a stale token and a second open while one is open', async () => {
    const cli = fakeCli('claude')
    const { picker } = pickerFor(cli)
    const opened = await picker.open('model')
    expect(await picker.open('effort')).toEqual({ ok: false, reason: 'busy' })
    expect(await picker.choose('other', 1)).toEqual({ ok: false, reason: 'changed' })
    expect(await picker.choose(opened.token, 99)).toEqual({ ok: false, reason: 'changed' })
    await picker.cancel(opened.token)
  })

  it('stops and backs out when the screen is no longer the picker it offered (no s to a shell)', async () => {
    const cli = fakeCli('claude', { model: 1 })
    const { picker } = pickerFor(cli)
    const opened = await picker.open('model')
    cli.view = 'composer' // the CLI closed it meanwhile
    expect(await picker.choose(opened.token, 3)).toEqual({ ok: false, reason: 'changed' })
    expect(cli.keys).not.toContain('s')
  })

  it('says "stuck" and backs out when an arrow does not move the selection (a level the model lacks)', async () => {
    const cli = fakeCli('claude', { effort: 2 })
    const write = cli.write
    cli.write = data => (data === '\x1b[C' && cli.sel >= 2 ? (cli.keys.push(data), true) : write(data))
    const { picker } = pickerFor(cli)
    const opened = await picker.open('effort')
    expect(await picker.choose(opened.token, 4)).toEqual({ ok: false, reason: 'stuck' })
    expect(cli.view).toBe('composer')
    expect(cli.applied).toEqual([])
  })

  it('backs out by itself when nothing is chosen in time', async () => {
    const cli = fakeCli('claude')
    const { picker, held } = pickerFor(cli, { idleTimeout: 30 })
    await picker.open('model')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(cli.view).toBe('composer')
    expect(held.at(-1)).toBe(false)
  })
})
