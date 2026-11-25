import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { readFileSync, readdirSync } from 'node:fs'
import { createAgentInboxWake, PROMPT, BUSY_PROMPT, REMIND_PROMPT } from './agentInboxWake.js'
import { watchCommand } from '../agentChat/commandScreen.js'

const paste = '\x1b[200~' + PROMPT + '\x1b[201~'
const busyPaste = '\x1b[200~' + BUSY_PROMPT + '\x1b[201~'
const remindPaste = '\x1b[200~' + REMIND_PROMPT + '\x1b[201~'
const claudeDraft = text => '\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(70) + '\r\n> ' + text
const codexDraft = text => '\x1b[?2004h\x1b[2J\x1b[H› ' + text
const paintedClaudeDraft = text => '\x1b[?2004h\x1b[?25l\x1b[2J\x1b[20;1H' +
  '─'.repeat(70) + '\r\n❯\u00a0' + text + '\x1b[7m \x1b[0m\r\n' +
  '─'.repeat(70) + '\r\n  ⏵⏵ auto mode on'

let wake
function setup(kind = 'claude', cols = 100, onApprovalChange, onDraftBlockChange, wakeRecovery, rows = 24) {
  const write = vi.fn(() => true)
  // ids: unread (wake for these); open: not answered yet, read or not
  // busy: not waiting for input; running: busy with a task (not starting up or asking for approval)
  const state = { busy: false, running: true, unknown: false, ids: [], open: [] }
  wake = createAgentInboxWake({
    kind, cols, rows, quietMs: 60,
    isUnknown: () => state.unknown,
    pendingMessages: () => state.ids,
    unhandledMessages: () => state.open,
    isHookWorking: () => state.hookWorking === true,
    messageSeenAt: id => state.seen?.get(id),
    isWorking: () => state.busy,
    isRunningTask: () => state.busy && state.running,
    write, onApprovalChange, onDraftBlockChange, wakeRecovery
  })
  return { write, state }
}

afterEach(() => wake?.close())

describe('actual Codex and Claude PTY frames', () => {
  const directory = new URL('./fixtures/agent-inbox-pty/', import.meta.url)
  const fixtures = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => ({
    name, ...JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
  }))
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const configure = fixture => setup(fixture.kind, fixture.cols, undefined, undefined, undefined, fixture.rows)
  const paint = async (phase, suffix = '') => {
    wake.writeOutput(phase.frame + suffix)
    await vi.advanceTimersByTimeAsync(80)
  }

  it.each(fixtures.flatMap(fixture => ['pasted', 'atStart'].map(phase => ({ ...fixture, phase }))))(
    'submits the whole notice from the current editor in $name ($phase)', async fixture => {
    const { write, state } = configure(fixture)
    const { submittedNotice, phases } = fixture
    state.ids = ['unread']
    state.busy = submittedNotice === BUSY_PROMPT
    if (submittedNotice !== REMIND_PROMPT) {
      await paint(phases.idle)
      expect(write.mock.calls).toEqual([[state.busy ? busyPaste : paste]])
    }
    await paint(phases[fixture.phase])
    await vi.advanceTimersByTimeAsync(7000)
    expect(write.mock.calls.map(([data]) => data).filter(data => data === '\r')).toEqual(['\r'])
    expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: true } })
    state.ids.push('arrived-after-enter')
    await paint(phases[fixture.phase])
    expect(write.mock.calls.map(([data]) => data).filter(data => data === '\r')).toEqual(['\r'])
  })

  it.each(fixtures)('submits an exact strict chat paste in $name with the caret away from the end', async fixture => {
    const { write } = configure(fixture)
    await paint(fixture.phases.idle)
    const sent = wake.submitText(fixture.submittedNotice, undefined, { strict: true })
    await paint(fixture.phases.atStart)
    await vi.advanceTimersByTimeAsync(1700)
    await expect(sent).resolves.toEqual({ ok: true })
    expect(write.mock.calls).toEqual([['\x1b[200~' + fixture.submittedNotice + '\x1b[201~'], ['\r']])
  })

  it.each(fixtures.flatMap(fixture => ['warningDetail', 'updatePrompt', 'settingsWarning'].filter(name => fixture.phases[name])
    .map(phase => ({ ...fixture, phase }))))('writes nothing into $phase in $name and resumes after the editor returns', async fixture => {
    const { write, state } = configure(fixture)
    state.ids = ['unread']
    await paint(fixture.phases[fixture.phase])
    await vi.advanceTimersByTimeAsync(6100)
    expect(write).not.toHaveBeenCalled()
    expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: fixture.phase === 'settingsWarning' ? 'approval' : 'cli-screen' } })
    if (fixture.submittedNotice === REMIND_PROMPT) {
      await paint(fixture.phases.atStart)
      expect(write.mock.calls).toEqual([['\r']])
      return
    }
    await paint(fixture.phases.idle)
    expect(write.mock.calls).toEqual([[paste]])
    await paint(fixture.phases[fixture.phase])
    await vi.advanceTimersByTimeAsync(6100)
    expect(write.mock.calls).toEqual([[paste]])
    await paint(fixture.phases.atStart)
    expect(write.mock.calls).toEqual([[paste], ['\r']])
  })

  it.each(fixtures.filter(fixture => fixture.phases.queued))('leaves the queue in $name alone until the new notice is drawn', async fixture => {
    const { write, state } = configure(fixture)
    state.ids = ['unread']
    state.busy = true
    await paint(fixture.phases.idle)
    expect(write.mock.calls).toEqual([[busyPaste]])
    state.hookWorking = true
    await paint(fixture.phases.queued)
    await vi.advanceTimersByTimeAsync(6100)
    expect(write.mock.calls).toEqual([[busyPaste]])
    state.hookWorking = false
    await paint(fixture.phases.atStart)
    expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
  })

  const claudeQueues = fixtures.filter(fixture => fixture.kind === 'claude' && fixture.phases.queued)

  it.each(claudeQueues)('pastes into the empty Claude queue composer in $name and waits for the new notice before Enter', async fixture => {
    const { write, state } = configure(fixture)
    state.busy = true
    state.ids = ['unread']
    await paint(fixture.phases.queued)
    await vi.advanceTimersByTimeAsync(1700)
    expect(wake.composerState()).toBe('empty')
    expect(wake.inspectBlock()).toEqual({ blocked: null })
    expect(write.mock.calls).toEqual([[busyPaste]])
    await paint(fixture.phases.atStart)
    expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
  })

  it.each(claudeQueues)('lets the chat send into the empty Claude queue composer in $name', async fixture => {
    const { write, state } = configure(fixture)
    state.busy = true
    await paint(fixture.phases.queued)
    const sent = wake.submitText(BUSY_PROMPT)
    await vi.advanceTimersByTimeAsync(900)
    expect(write.mock.calls).toEqual([[busyPaste]])
    await paint(fixture.phases.atStart)
    await vi.advanceTimersByTimeAsync(750)
    await expect(sent).resolves.toEqual({ ok: true })
    expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
  })

  it.each(claudeQueues)('preserves user input matching the Claude queue hint in $name', async fixture => {
    const { write, state } = configure(fixture)
    state.busy = true
    await paint(fixture.phases.queued)
    wake.userInput('\x1b[A')
    state.ids = ['unread']
    await paint(fixture.phases.queued)
    expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: false } })
    expect(write).not.toHaveBeenCalled()
  })

  it.each(claudeQueues)('treats the hint text as a draft without a nearby Claude queue item in $name', async fixture => {
    const { write, state } = configure(fixture)
    state.busy = true
    state.ids = ['unread']
    const { frame, lines } = fixture.phases.queued
    const queueRow = lines.findIndex(line => line.trimStart().startsWith('⎿  Queued'))
    await paint({ frame }, `\x1b7\x1b[${queueRow + 1};1H\x1b[2K\x1b8`)
    expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: false } })
    expect(write).not.toHaveBeenCalled()
  })

  it.each(claudeQueues)('does not use Stop to resume ahead of the native queue in $name', async fixture => {
    const { write, state } = configure(fixture)
    state.busy = state.hookWorking = true
    state.ids = ['unread']
    await paint(fixture.phases.queued)
    expect(wake.prepareStopWake({ promptId: 'turn', startedAt: 1 }, vi.fn())).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it.each(fixtures)('does not resubmit terminal history in $name after the CLI consumes the notice', async fixture => {
    const { write, state } = configure(fixture)
    state.ids = ['new-unread']
    await paint(fixture.phases.enter)
    if (fixture.phases.queueDrained) await paint(fixture.phases.queueDrained)
    await vi.advanceTimersByTimeAsync(2400)
    expect(write.mock.calls.map(([data]) => data)).not.toContain('\r')
  })

  it.each(['', '  Session activity · new status widget', '  Activity notice\r\n  Another hint below it'])(
    'finishes the warning-free bounded Codex editor beneath arbitrary surrounding text %j', async footer => {
      const fixture = fixtures.find(item => item.name === 'codex-59x15-warning-wrapped.json')
      const { write, state } = configure(fixture)
      state.ids = ['unread']
      await paint(fixture.phases.idle)
      await paint(fixture.phases.atStart, `\x1b7\x1b[7;1H\x1b[2K${footer}\x1b8`)
      await vi.advanceTimersByTimeAsync(2000)
      expect(write.mock.calls).toEqual([[paste], ['\r']])
    }
  )

  it('does not submit a matching first block when more draft text remains after an internal blank line', async () => {
    const fixture = fixtures.find(item => item.name === 'codex-59x15-warning-wrapped.json')
    const { write, state } = configure(fixture)
    state.ids = ['unread']
    await paint(fixture.phases.idle)
    const extra = '\x1b[7;1H\x1b[2K  retained user draft\x1b[9;1H  89% context left\x1b[4;3H'
    await paint(fixture.phases.atStart, extra)
    await vi.advanceTimersByTimeAsync(2000)
    expect(write.mock.calls).toEqual([[paste]])
  })

  it('uses the native Codex editor boundaries when both cursor and footer are elsewhere', async () => {
    const fixture = fixtures.find(item => item.name === 'codex-59x15-warning-wrapped.json')
    const { write, state } = configure(fixture)
    state.ids = ['unread']
    await paint(fixture.phases.idle)
    await paint(fixture.phases.atStart, '\x1b[7;1H\x1b[2K  Other terminal status\x1b[1;1H')
    expect(write.mock.calls).toEqual([[paste], ['\r']])
  })

  it.each(fixtures.filter(item => item.submittedNotice === PROMPT))('leaves the native draft in $name after keyboard input', async fixture => {
    const { write, state } = configure(fixture)
    state.ids = ['unread']
    await paint(fixture.phases.idle)
    wake.userInput('\x1b[H')
    await paint(fixture.phases.atStart)
    await vi.advanceTimersByTimeAsync(6100)
    expect(write.mock.calls).toEqual([[paste]])
    expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: false } })
  })
})

it.each([
  ['unnumbered', ' ❯ No, exit\r\n   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'],
  ['numbered and wrapped', ' ❯ 1. Yes, I trust this\r\n   folder\r\n   2. No, exit', ' Enter to confirm ·\r\n Esc to cancel']
])('keeps the %s Claude folder trust screen in the live terminal until its composer returns', async (_, choices, footer) => {
  const onApprovalChange = vi.fn()
  const { write, state } = setup('claude', 100, onApprovalChange)
  state.ids = ['one']
  wake.writeOutput(claudeDraft('') + '\r\n' + [
    '─'.repeat(70), ' Accessing workspace:', '', ' C:\\temp\\fresh-workspace', '',
    ' Quick safety check: Is this a project you created or one you trust?', '',
    ' Security guide', '', choices, '', footer, '\x1b[2;3H'
  ].join('\r\n'))
  await vi.waitFor(() => expect(onApprovalChange).toHaveBeenLastCalledWith(true))
  expect(wake.approvalPrompt()).toMatchObject({ terminalOnly: 'folder-trust', options: [] })
  expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'folder-trust' }, ticket: expect.any(Symbol) })
  expect(wake.composerState()).toBeNull()
  await expect(wake.submitText('Question')).resolves.toMatchObject({ ok: false, reason: 'approval' })
  await expect(wake.submitText('Question', undefined, { strict: true })).resolves.toMatchObject({ ok: false, reason: 'approval' })
  await expect(wake.answerApproval('1', wake.approvalPrompt().signature)).resolves.toMatchObject({ ok: false, reason: 'changed' })
  expect(write).not.toHaveBeenCalled()

  wake.writeOutput(claudeDraft(''))
  await vi.waitFor(() => expect(onApprovalChange).toHaveBeenLastCalledWith(false))
  expect(wake.approvalPrompt()).toBeNull()
  await vi.waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith(paste))
})

describe('official stop inbox wake', () => {
  it('holds the busy paste, commits confirmed messages, and lets an expired notice go to the idle composer', async () => {
    vi.useFakeTimers()
    const { write, state } = setup()
    const stop = { event: 'Stop', promptId: 'turn', sessionId: 'session', startedAt: 100 }
    state.ids = ['one', 'two']
    state.open = [...state.ids]
    state.busy = state.hookWorking = true
    wake.writeOutput(claudeDraft(''))
    try {
      await vi.advanceTimersByTimeAsync(100)
      expect(write).not.toHaveBeenCalled()
      expect(wake.prepareStopWake(stop, vi.fn())).toBe(PROMPT)
      expect(wake.prepareStopWake({ ...stop, startedAt: 101 }, vi.fn())).toBeNull()
      wake.stopWakeReport({ ...stop, event: 'PreToolUse', startedAt: 102 })
      expect(wake.prepareStopWake({ ...stop, startedAt: 103 }, vi.fn())).toBeNull()
      state.ids.push('three')
      const onUnconfirmed = vi.fn(() => { state.busy = state.hookWorking = false })
      expect(wake.prepareStopWake({ ...stop, startedAt: 104 }, onUnconfirmed)).toBe(PROMPT)
      await vi.advanceTimersByTimeAsync(14_999)
      expect(write).not.toHaveBeenCalled()
      expect(onUnconfirmed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(50)
      expect(onUnconfirmed).toHaveBeenCalledOnce()
      expect(write).toHaveBeenCalledExactlyOnceWith(paste)
    } finally { wake.close(); vi.useRealTimers() }
  })

  it('does not block Stop while the Claude user queue is visible', async () => {
    const { state } = setup()
    state.ids = ['one']
    state.busy = state.hookWorking = true
    wake.writeOutput(paintedClaudeDraft('') + '\r\nPress up to edit queued messages')
    await vi.waitFor(() => expect(wake.screenLines().join(' ')).toContain('Press up to edit queued messages'))
    expect(wake.prepareStopWake({ promptId: 'turn' }, vi.fn())).toBeNull()
  })

  it('keeps the Claude reservation while the title spinner continues beyond 30 seconds', async () => {
    vi.useFakeTimers()
    const { state, write } = setup()
    state.ids = ['one']
    state.busy = state.hookWorking = true
    let spinner = true
    const onUnconfirmed = vi.fn(() => { state.busy = state.hookWorking = false })
    wake.writeOutput(claudeDraft(''))
    try {
      expect(wake.prepareStopWake({ promptId: 'turn', startedAt: 1 }, onUnconfirmed, () => spinner)).toBe(PROMPT)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(onUnconfirmed).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      spinner = false
      await vi.advanceTimersByTimeAsync(5100)
      expect(onUnconfirmed).toHaveBeenCalledOnce()
      expect(write).toHaveBeenCalledExactlyOnceWith(paste)
    } finally { wake.close(); vi.useRealTimers() }
  })

  it('confirms a Codex stop continuation when the same session submits a new turn', () => {
    const { state } = setup('codex')
    state.ids = ['one']
    const stop = { promptId: 'first', sessionId: 'same', startedAt: 1 }
    expect(wake.prepareStopWake(stop, vi.fn())).toBe(PROMPT)
    const next = { ...stop, promptId: 'second', startedAt: 2, event: 'UserPromptSubmit' }
    wake.stopWakeReport(next)
    state.open = ['one']
    expect(wake.prepareStopWake({ ...next, startedAt: 3 }, vi.fn())).toBeNull()
  })
})

it.each([
  'Hooks need review\r\n10 hooks are new or changed.\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without trusting',
  'Event          Installed    Active    Review\r\nStop           1            1         Pending\r\nt trust all · enter review · esc close'
])('keeps Codex hook trust screens terminal-only', async frame => {
  const { write, state } = setup('codex')
  state.ids = ['one']
  wake.writeOutput(codexDraft('') + `\r\n${frame}\x1b[1;3H`)
  await vi.waitFor(() => expect(wake.screenLines().join(' ')).toContain(frame.split('\r\n')[0]))
  expect(wake.approvalPrompt()).toBeNull()
  expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'hook-trust' }, ticket: expect.any(Symbol) })
  expect(wake.composerState()).toBeNull()
  await expect(wake.submitText('Question')).resolves.toMatchObject({ ok: false, reason: 'approval' })
  await expect(wake.submitText('Question', undefined, { strict: true })).resolves.toMatchObject({ ok: false, reason: 'approval' })
  expect(write).not.toHaveBeenCalled()
})

it.each([
  { kind: 'codex', command: '/model', lines: [
    '🔌  MCP Tools', '  • ezshell-cli-mcp: connected (7 tools)', '',
    '  Select Model and Effort', '› 1. GPT-6.2-Sol (current)  Fast model.',
    '  2. GPT-6.2-Astra          For complex work.', '  ↓', '  enter select · esc back'
  ] },
  { kind: 'codex', command: '/model', cols: 35, lines: [
    '  Select Reasoning Level for GPT-6.2-Sol', '  1. Low (default)', '› 2. Medium (current)',
    '  3. High', '  enter default · s session · esc back'
  ] },
  { kind: 'claude', command: '/model', lines: [
    '  Select model', '  Your pick is the default for new sessions.', '  ❯ 1. Opus 5.5 ✔',
    '    2. Sonnet 5.5', '    3. Haiku 5.5', '  ● High effort ←/→ to adjust',
    '  s to use this session only · Enter to save · Esc to cancel'
  ] },
  { kind: 'claude', command: '/effort', lines: [
    '  Effort', '      Faster             Smarter', '      ──────────▲────────────',
    '      low     medium     high     max', '  ←/→ to adjust · Enter to use this session only · Esc to cancel'
  ] }
])('hands the $kind $command picker to the terminal', async ({ kind, command, cols, lines }) => {
  const { write } = setup(kind, cols)
  wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + lines.join('\r\n'))
  await vi.waitFor(() => expect(wake.commandRows().lines.join('')).toContain(lines.at(-1)))
  let time = 0
  await expect(watchCommand({
    kind, command,
    read: () => ({ ...wake.commandRows(), composer: wake.composerState(), approval: Boolean(wake.approvalPrompt()) }),
    now: () => time, sleep: async ms => { time += ms }
  })).resolves.toEqual({ state: 'screen' })
  await expect(wake.submitText('A new chat message')).resolves.toMatchObject({ ok: false, reason: 'no-composer' })
  expect(write).not.toHaveBeenCalled()
})

it('preserves the last cell and continuation flag of a wrapped command row', async () => {
  setup('codex', 7)
  wake.writeOutput(codexDraft('/mcp verbose'))
  await vi.waitFor(() => {
    const { lines, wraps } = wake.commandRows()
    expect(lines.slice(0, 2)).toEqual(['› /mcp ', 'verbose'])
    expect(wraps.slice(0, 2)).toEqual([false, true])
  })
})

it('inspects draft origin, a native menu and distinct occurrences of the same approval without writing', async () => {
  const { write } = setup('codex')
  const draw = async lines => {
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + lines.join('\r\n'))
    await vi.waitFor(() => expect(wake.screenLines().map(row => row.trim())).toContain(lines.at(-1).trim()))
  }
  await draw(['› private draft'])
  expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: false } })
  await draw(['› '])
  const sent = wake.submitText('App draft')
  await draw(['› App draft'])
  const writes = write.mock.calls.length
  expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: true } })
  expect(write.mock.calls).toHaveLength(writes)
  wake.userInput('\x1b')
  await expect(sent).resolves.toMatchObject({ ok: false, reason: 'interrupted' })
  write.mockClear()
  await draw(['  Select Model and Effort', '› 1. Model A', '  2. Model B', '  enter select · esc back'])
  expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'cli-screen' } })
  await draw(['CLI settings', 'Esc to close'])
  wake.noteCommandScreen()
  expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'cli-screen' } })
  await draw(['› '])
  wake.noteCommandScreen()
  await draw(['plain terminal output'])
  expect(wake.inspectBlock().blocked).toBeNull()
  const question = ['Would you like to run this?', '  $ private command', '› 1. Yes', '  2. No', 'Press enter to confirm or esc to cancel']
  await draw(question)
  const first = wake.inspectBlock()
  expect(first).toMatchObject({ blocked: { kind: 'approval', question: question[0], options: ['Yes', 'No'] }, ticket: expect.any(Symbol) })
  expect(wake.inspectBlock().ticket).toBe(first.ticket)
  await draw(['› '])
  expect(wake.inspectBlock().blocked).toBeNull()
  await draw(question)
  expect(wake.inspectBlock().ticket).not.toBe(first.ticket)
  expect(write).not.toHaveBeenCalled()
})

describe('wake an idle agent with unread messages', () => {
  describe('Codex inbox notices in the live composer', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())
    const warning = '                                                 89% context left · ⚠ 1 warning · f2 to view'
    const frame = (text, column = text.length + 3, gap = '\r\n\r\n') => codexDraft(text + gap + warning) + `\x1b[1;${column}H`
    async function paint(text) {
      wake.writeOutput(text)
      await vi.advanceTimersByTimeAsync(80)
    }

    it('does not count the warning footer against a freshly pasted notice', async () => {
      const { write, state } = setup('codex')
      state.ids = ['one']
      await paint(frame(''))
      await paint(frame(PROMPT, undefined, '\r\n'))
      expect(write.mock.calls).toEqual([[paste], ['\r']])
      state.ids.push('two')
      await paint(frame(PROMPT))
      await vi.advanceTimersByTimeAsync(2000)
      expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: true } })
      expect(write.mock.calls).toEqual([[paste], ['\r']])
    })

    it.each([PROMPT, BUSY_PROMPT, REMIND_PROMPT])('recovers an exact notice with unread mail after rebuilding its observer', async text => {
      const { write, state } = setup('codex', 140)
      state.ids = ['one']
      wake.writeOutput(frame(text))
      await vi.advanceTimersByTimeAsync(5)
      expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: true } })
      await vi.advanceTimersByTimeAsync(200)
      state.ids.push('two')
      await paint(frame(text))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(write.mock.calls).toEqual([['\r']])
    })

    it('still announces unread mail after finishing a reminder from a previous turn', async () => {
      const { write, state } = setup('codex', 140)
      state.ids = ['one']
      await paint(frame(REMIND_PROMPT))
      expect(write.mock.calls).toEqual([['\r']])
      await paint(frame(''))
      await vi.advanceTimersByTimeAsync(1700)
      expect(write.mock.calls).toEqual([['\r'], [paste]])
    })

    it('submits the whole current editor while the Codex caret is parked at the start', async () => {
      const { write, state } = setup('codex')
      state.ids = ['one']
      await paint(frame(''))
      await paint(frame(PROMPT, 3))
      await vi.advanceTimersByTimeAsync(5500)
      expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: true } })
      expect(write.mock.calls).toEqual([[paste], ['\r']])
      await paint(frame(PROMPT))
      expect(write.mock.calls).toEqual([[paste], ['\r']])
    })

    it('does not submit again after the observer of the same shell restarts before the draft clears', async () => {
      const wakeRecovery = { blocked: false }
      const first = setup('codex', 100, undefined, undefined, wakeRecovery)
      first.state.ids = ['one']
      await paint(frame(''))
      await paint(frame(PROMPT))
      expect(first.write.mock.calls).toEqual([[paste], ['\r']])
      wake.close()
      const next = setup('codex', 100, undefined, undefined, wakeRecovery)
      next.state.ids = ['one', 'two']
      await paint(frame(PROMPT))
      expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: true } })
      expect(next.write).not.toHaveBeenCalled()
      await paint(frame(''))
      expect(next.write.mock.calls).toEqual([[paste]])
    })

    it('cannot adopt the notice after user input, without unread mail, or on a shell or confirmation screen', async () => {
      const { write, state } = setup('codex')
      await paint(frame(PROMPT))
      expect(write).not.toHaveBeenCalled()
      state.ids = ['one']
      await paint(frame(PROMPT) + '\r\nPS D:\\dev> ')
      await paint(frame(PROMPT) + '\r\nDo you want to proceed?\r\n› 1. Yes\r\n  2. No\r\nEnter to confirm · Esc to cancel')
      expect(write).not.toHaveBeenCalled()
      wake.userInput('\x1b[D')
      await paint(frame(PROMPT))
      expect(write).not.toHaveBeenCalled()
      expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: false } })
    })

    it('reports a blocked unread inbox once after a minute and clears the notice when the draft clears', async () => {
      const onDraftBlockChange = vi.fn()
      const { write, state } = setup('codex', 100, undefined, onDraftBlockChange)
      state.ids = ['one']
      await paint(frame('User draft'))
      await vi.advanceTimersByTimeAsync(59_000)
      expect(onDraftBlockChange).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1200)
      expect(onDraftBlockChange.mock.calls).toEqual([[true]])
      state.ids.push('two')
      await paint(frame('User draft with changes'))
      await vi.advanceTimersByTimeAsync(65_000)
      expect(onDraftBlockChange.mock.calls).toEqual([[true]])
      expect(write).not.toHaveBeenCalled()
      await paint(frame(''))
      expect(onDraftBlockChange.mock.calls).toEqual([[true], [false]])
      expect(write.mock.calls).toEqual([[paste]])
    })
  })

  it('waits for the exact rendered draft before submitting and batches all pending messages', async () => {
    const { write, state } = setup()
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    state.ids.push('second')
    wake.writeOutput(claudeDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('enters a line that fills the row exactly, with the cursor ConPTY leaves on the last cell', async () => {
    // "> " and the line take the whole row; ConPTY repaints with the cursor on the last column
    const cols = PROMPT.length + 2
    const { write, state } = setup('claude', cols)
    const screen = text => '\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(cols - 4) + '\r\n> ' + text
    state.ids.push('first')
    wake.writeOutput(screen(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    wake.writeOutput(screen(PROMPT) + `\x1b[2;${cols}H`)
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
  })

  it('does not take a cursor before the last character of a shorter line for the end', async () => {
    const { write, state } = setup('claude', 100)
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    // The cursor one cell back, inside the line: not ours to enter
    wake.writeOutput(claudeDraft(PROMPT) + `\x1b[2;${PROMPT.length + 2}H`)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(write.mock.calls).toEqual([[paste]])
  })

  it('wakes Claude when it paints its composer cursor and leaves the terminal cursor in the footer', async () => {
    const { write, state } = setup()
    state.ids.push('first')
    wake.writeOutput(paintedClaudeDraft('a user draft'))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(write).not.toHaveBeenCalled()
    wake.writeOutput(paintedClaudeDraft(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    wake.writeOutput(paintedClaudeDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
  })

  it('wakes Claude for a follow-up when its empty composer shows a dim prompt suggestion', async () => {
    const { write, state } = setup()
    state.ids = ['first']
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    wake.writeOutput(claudeDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))

    const draft = '로고를 조금 더 크게 키워줘'
    const composer = text => claudeDraft(text + '\r\n' + '─'.repeat(70) + '\r\n  ⏵⏵ bypass permissions on\x1b[2;3H')
    state.ids = ['follow-up']
    wake.writeOutput(composer(draft))
    await vi.waitFor(() => expect(wake.composerState()).toBe('draft'))
    expect(write).toHaveBeenCalledTimes(2)

    wake.writeOutput(composer(`\x1b[2m${draft}\x1b[22m`))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r'], [paste]]), { timeout: 3000 })
    wake.writeOutput(claudeDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r'], [paste], ['\r']]))
  })

  it('wakes unfocused Claude after the user deletes their draft and a dim hint returns', async () => {
    const { write, state } = setup()
    const unfocused = text => claudeDraft(text) + '\r\n' + '─'.repeat(70) + '\r\n  ⏵⏵ auto mode on'
    wake.userInput('x')
    wake.userInput('\x7f')
    state.ids.push('first')
    wake.writeOutput(unfocused('\x1b[2mTry "fix lint errors"\x1b[22m'))
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    wake.writeOutput(unfocused(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
  })

  it('keeps queued messages while a user draft is open', async () => {
    const { write, state } = setup('codex')
    state.ids.push('first')
    wake.userInput('manual draft')
    wake.writeOutput(codexDraft('manual draft') + '\x1b[1;3H')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(write).not.toHaveBeenCalled()

    wake.writeOutput(codexDraft(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    wake.writeOutput(codexDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
  })

  it('does not press Enter when a confirmation screen has focus after pasting', async () => {
    const { write, state } = setup()
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(paste))
    wake.writeOutput(claudeDraft(PROMPT) + '\r\nDo you want to allow this?\r\n❯ 1. Yes')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(write.mock.calls).toEqual([[paste]])
  })

  it('does not submit a painted composer when a choice prompt has appeared below it', async () => {
    const { write, state } = setup()
    state.ids.push('first')
    wake.writeOutput(paintedClaudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(paste))
    wake.writeOutput(paintedClaudeDraft(PROMPT) + '\r\nDo you want to allow this?\r\n❯ 1. Yes')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(write.mock.calls).toEqual([[paste]])
  })

  it('waits until the user finishes composing keyboard input', async () => {
    const { write, state } = setup()
    wake.setComposing(true)
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(write).not.toHaveBeenCalled()
    wake.setComposing(false)
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(paste))
  })

  it('tells a busy agent at once, so it can confirm and say what it finishes first', async () => {
    const { write, state } = setup()
    state.busy = true
    state.ids.push('first')
    state.open.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[busyPaste]]))
    // Submitted while it still works: Claude Code hands the line to the running task
    wake.writeOutput(claudeDraft(BUSY_PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[busyPaste], ['\r']]))
  })

  it('waits while the agent is starting up or its state is unknown', async () => {
    const { write, state } = setup()
    state.busy = true
    state.running = false
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(write).not.toHaveBeenCalled()
    state.busy = false
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
  })

  it('wakes a fresh agent whose state was never reported once its empty composer stays quiet', async () => {
    // A CLI just started, before its first turn, has told nothing about its state (seen with three agents)
    const { write, state } = setup('codex')
    state.busy = true
    state.running = false
    state.unknown = true
    state.ids.push('first')
    wake.writeOutput(codexDraft(''))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(write).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste]]))
    wake.writeOutput(codexDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
  })

  it('does not wake an unknown agent while its screen keeps changing', async () => {
    const { write, state } = setup('codex')
    state.busy = true
    state.running = false
    state.unknown = true
    state.ids.push('first')
    for (let i = 0; i < 6; i++) {
      wake.writeOutput(codexDraft(''))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('does not put the busy notice over a draft the user is typing', async () => {
    const { write, state } = setup('codex')
    state.busy = true
    state.ids.push('first')
    wake.userInput('my own words')
    wake.writeOutput(codexDraft('my own words'))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(write).not.toHaveBeenCalled()
  })

  it('reminds once when the task is over and the put-off request is still open', async () => {
    const { write, state } = setup()
    state.busy = true
    state.ids.push('first')
    state.open.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(busyPaste))
    wake.writeOutput(claudeDraft(BUSY_PROMPT))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('\r'))
    // It read the message (no longer unread), but has not answered yet
    state.ids = []
    await new Promise(resolve => setTimeout(resolve, 1600))
    state.busy = false
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(remindPaste))
    wake.writeOutput(claudeDraft(REMIND_PROMPT))
    await vi.waitFor(() => expect(write.mock.calls.filter(call => call[0] === '\r')).toHaveLength(2))
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 1700))
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(write.mock.calls.filter(call => call[0] === remindPaste)).toHaveLength(1)
  }, 10000)

  it('does not remind when the put-off request was answered during the task', async () => {
    const { write, state } = setup()
    state.busy = true
    state.ids.push('first')
    state.open.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(busyPaste))
    wake.writeOutput(claudeDraft(BUSY_PROMPT))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('\r'))
    state.ids = []
    state.open = []
    await new Promise(resolve => setTimeout(resolve, 1600))
    state.busy = false
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(write).not.toHaveBeenCalledWith(remindPaste)
  }, 10000)

  it('still presses Enter on its pasted line when the agent read the message meanwhile', async () => {
    const { write, state } = setup()
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(paste))
    // The agent read its inbox in a running turn before Enter.
    state.ids = []
    wake.writeOutput(claudeDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
  })

  it('keeps its pasted line and presses Enter once the agent is idle again, however long that takes', async () => {
    const { write, state } = setup()
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(paste))
    state.busy = true
    state.running = false
    wake.writeOutput(claudeDraft(PROMPT))
    await new Promise(resolve => setTimeout(resolve, 1700))
    wake.writeOutput(claudeDraft(PROMPT))
    expect(write.mock.calls).toEqual([[paste]])
    state.busy = false
    wake.writeOutput(claudeDraft(PROMPT))
    await vi.waitFor(() => expect(write.mock.calls).toEqual([[paste], ['\r']]))
  }, 10000)

  describe('recovering a wake notice after a redraw', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const cols = 64
    const split = BUSY_PROMPT.lastIndexOf(' ', cols - 2)
    const continuation = '  ' + BUSY_PROMPT.slice(split + 1)
    const wrapped = BUSY_PROMPT.slice(0, split) + '\r\n' + continuation

    async function paint(frame) {
      wake.writeOutput(frame)
      await vi.advanceTimersByTimeAsync(50)
    }

    async function startBusyCodex() {
      const { write, state } = setup('codex', cols)
      state.busy = true
      state.ids = ['first']
      await paint(codexDraft(''))
      expect(write.mock.calls).toEqual([[busyPaste]])
      state.ids = []
      return { write, state }
    }

    it.each([
      ['the caret stays on the prompt row', codexDraft(wrapped + '\r\n\r\n  Working') + '\x1b[1;3H'],
      ['the composer briefly disappears', codexDraft('') + '\x1b[2J\x1b[H  Working']
    ])('submits once and wakes for later mail after %s at the deadline', async (_layout, frame) => {
      const { write, state } = await startBusyCodex()
      state.hookWorking = true
      await paint(frame)
      await vi.advanceTimersByTimeAsync(1600)
      expect(write.mock.calls).toEqual([[busyPaste]])

      state.busy = false
      state.hookWorking = false
      await paint(codexDraft(wrapped))
      await vi.advanceTimersByTimeAsync(250)
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
      await paint(codexDraft(wrapped))
      await vi.advanceTimersByTimeAsync(1600)
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])

      state.ids = ['follow-up']
      await paint(codexDraft(''))
      await paint(codexDraft(PROMPT))
      expect(write.mock.calls).toEqual([[busyPaste], ['\r'], [paste], ['\r']])
    })

    it('withholds Enter at a shell prompt even while the CLI is reported live and cancels recovery on user input', async () => {
      const { write, state } = await startBusyCodex()
      state.busy = false
      await paint(codexDraft(wrapped + '\r\n\r\nPS C:\\dev> '))
      await vi.advanceTimersByTimeAsync(1600)
      expect(write.mock.calls).toEqual([[busyPaste]])

      wake.userInput(' extra words')
      await paint(codexDraft(wrapped + ' extra words'))
      await paint(codexDraft(wrapped))
      expect(write.mock.calls).toEqual([[busyPaste]])
    })

    it('does not submit a history row after the notice has been absent for thirty seconds', async () => {
      const { write, state } = await startBusyCodex()
      await paint(codexDraft('') + '\x1b[2J\x1b[H  Working')
      await vi.advanceTimersByTimeAsync(30_000)
      state.busy = false
      // Codex has painted the previous line in history with the caret there before drawing the empty editor.
      await paint(codexDraft(wrapped + '\r\n\r\n  Conversation history') + `\x1b[2;${continuation.length + 1}H`)
      await paint(codexDraft(''))
      expect(write.mock.calls).toEqual([[busyPaste]])
    })

    it('does not send Enter for a history line above a newly drawn empty editor during recovery', async () => {
      const { write, state } = await startBusyCodex()
      await paint(codexDraft('') + '\x1b[2J\x1b[H  Working')
      await vi.advanceTimersByTimeAsync(1700)
      state.busy = false
      await paint(codexDraft(wrapped + '\r\n\r\n› ') + `\x1b[2;${continuation.length + 1}H`)
      await vi.advanceTimersByTimeAsync(250)
      expect(write.mock.calls).toEqual([[busyPaste]])
    })

    it('keeps a notice after five seconds when there is insufficient evidence of the active editor', async () => {
      const { write, state } = await startBusyCodex()
      state.busy = false
      await paint(codexDraft(wrapped) + '\x1b[5;1H')
      await vi.advanceTimersByTimeAsync(5500)
      expect(write.mock.calls).toEqual([[busyPaste]])
      expect(wake.inspectBlock()).toMatchObject({ blocked: { kind: 'draft', ours: true } })
      await paint(codexDraft(wrapped))
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
    })

    it('keeps a visible notice while a task runs longer than the hidden recovery window', async () => {
      const { write, state } = await startBusyCodex()
      state.hookWorking = true
      await paint(codexDraft(wrapped) + '\x1b[1;3H')
      await vi.advanceTimersByTimeAsync(35_000)
      expect(write.mock.calls).toEqual([[busyPaste]])

      state.busy = false
      state.hookWorking = false
      await paint(codexDraft(wrapped))
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
    })

    it.each([1, 125])('keeps a visible notice when redraw interrupts recovery %i times', async redraws => {
      const { write, state } = await startBusyCodex()
      state.hookWorking = true
      await paint(codexDraft('') + '\x1b[2J\x1b[H  Working')
      await vi.advanceTimersToNextTimerAsync()
      await paint(codexDraft(wrapped + '\r\n\r\n  Working') + '\x1b[1;3H')
      await vi.advanceTimersByTimeAsync(190)

      // Leave the screen write unacknowledged across each recovery timer, then let the parser
      // finish normally. The notice stays visible and there is no inbox event to start a new check.
      const writeFrame = Terminal.prototype.write
      const screenWrite = vi.spyOn(Terminal.prototype, 'write')
      try {
        for (let i = 0; i < redraws; i++) {
          let parsed
          screenWrite.mockImplementationOnce(function (data, callback) {
            writeFrame.call(this, data, () => { parsed = callback })
          })
          wake.writeOutput('\x1b7\x1b[4;1H  ⠋ Working\x1b8')
          await vi.advanceTimersByTimeAsync(20)
          expect(parsed).toBeTypeOf('function')
          parsed()
          await vi.advanceTimersByTimeAsync(230)
        }
      } finally {
        screenWrite.mockRestore()
      }
      expect(write.mock.calls).toEqual([[busyPaste]])

      state.busy = false
      state.hookWorking = false
      await paint(codexDraft(wrapped))
      await vi.advanceTimersByTimeAsync(300)
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
    })

    it('checks whether the notice is visible after the picker releases the editor', async () => {
      const { write, state } = await startBusyCodex()
      await paint(codexDraft('') + '\x1b[2J\x1b[H  Working')
      await vi.advanceTimersByTimeAsync(1600)
      wake.setHeld(true)
      await paint(codexDraft(wrapped))
      await vi.advanceTimersByTimeAsync(35_000)
      expect(write.mock.calls).toEqual([[busyPaste]])

      state.busy = false
      wake.setHeld(false)
      await vi.advanceTimersByTimeAsync(50)
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
    })

    it('waits for a confirmation screen to close and then enters the notice once', async () => {
      const { write, state } = await startBusyCodex()
      state.busy = false
      await paint(codexDraft(wrapped + '\r\n\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEnter to confirm · Esc to cancel')
        + `\x1b[2;${continuation.length + 1}H`)
      await vi.advanceTimersByTimeAsync(6000)
      expect(write.mock.calls).toEqual([[busyPaste]])

      await paint(codexDraft(wrapped))
      await vi.advanceTimersByTimeAsync(250)
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
      await paint(codexDraft(wrapped))
      await vi.advanceTimersByTimeAsync(1600)
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
    })

    it('recovers Claude’s ruled notice after it temporarily disappears', async () => {
      const { write, state } = setup('claude', 120)
      state.busy = true
      state.ids = ['first']
      await paint(paintedClaudeDraft(''))
      expect(write.mock.calls).toEqual([[busyPaste]])
      state.ids = []
      await paint('\x1b[2J\x1b[H  Working')
      await vi.advanceTimersByTimeAsync(1600)
      expect(write.mock.calls).toEqual([[busyPaste]])

      state.busy = false
      await paint(paintedClaudeDraft(BUSY_PROMPT))
      await vi.advanceTimersByTimeAsync(250)
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
      await paint(paintedClaudeDraft(BUSY_PROMPT))
      expect(write.mock.calls).toEqual([[busyPaste], ['\r']])
    })

    it('does not enter a matching first row when the visible draft continues below it', async () => {
      const { write, state } = setup('codex', cols)
      state.ids = ['first']
      await paint(codexDraft(''))
      expect(write.mock.calls).toEqual([[paste]])
      await paint(codexDraft(PROMPT + '\r\n  additional draft text') + `\x1b[1;${PROMPT.length + 3}H`)
      await vi.advanceTimersByTimeAsync(1600)
      expect(write.mock.calls).toEqual([[paste]])
    })
  })

  it('discards a staged submit when the user types or the session loses inbox access', async () => {
    const { write, state } = setup()
    state.ids.push('first')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(paste))
    wake.userInput('manual')
    state.ids = []
    wake.writeOutput(claudeDraft(PROMPT))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(write.mock.calls).toEqual([[paste]])
  })
})

describe('a line sent from the chat view (submitText)', () => {
  it('checks the subagent target before pasting and again before pressing Enter', async () => {
    const { write } = setup('claude', 100)
    const screen = (target, text = '') => '\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(65) + ` ${target} ─\r\n> ${text}\r\n${'─'.repeat(70)}\x1b[2;${3 + text.length}H`
    const verify = active => active === 'Inspect chat layout'
    wake.writeOutput(screen('Another task'))
    await vi.waitFor(() => expect(wake.inputTarget()).toBe('Another task'))
    await expect(wake.submitText('Check the narrow pane', undefined, { verify })).resolves.toMatchObject({ ok: false, reason: 'target-changed' })
    expect(write).not.toHaveBeenCalled()
    wake.writeOutput(screen('Inspect chat layout'))
    await vi.waitFor(() => expect(wake.inputTarget()).toBe('Inspect chat layout'))
    const sent = wake.submitText('Check the narrow pane', undefined, { verify })
    wake.writeOutput(screen('Another task', 'Check the narrow pane'))
    await expect(sent).resolves.toMatchObject({ ok: false, reason: 'target-changed' })
    expect(write.mock.calls).toEqual([['\x1b[200~Check the narrow pane\x1b[201~']])
  })
  // Like Orca (MIT), native-chat-runtime-send.ts: an ordinary send is aimed at the PTY, not at the label
  // Claude draws on its composer rule (a session name, 2026-11-24 user report: "CLI의 입력 대상이 바뀌었습니다")
  it('sends an ordinary line even when the label on the composer rule changes before Enter', async () => {
    const { write } = setup('claude', 100)
    const screen = (target, text = '') => '\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(65) + ` ${target} ─\r\n> ${text}\r\n${'─'.repeat(70)}\x1b[2;${3 + text.length}H`
    wake.writeOutput(screen('운영 도메인 전환'))
    await vi.waitFor(() => expect(wake.inputTarget()).toBe('운영 도메인 전환'))
    const sent = wake.submitText('Check the narrow pane')
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('\x1b[200~Check the narrow pane\x1b[201~'))
    wake.writeOutput(screen('배포 확인', 'Check the narrow pane'))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(write.mock.calls).toEqual([['\x1b[200~Check the narrow pane\x1b[201~'], ['\r']])
  })

  it('finds the composer under a session name too long for the rule (Claude draws no dashes then)', async () => {
    setup('claude', 60)
    const name = '운영 도메인 test.mbris.kr에서 mbris.kr 전환 작업과 배포 …'
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + ` ${name} ─\r\n❯ \r\n${'─'.repeat(60)}\x1b[2;3H`)
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    expect(wake.inputTarget()).toBe(name)
  })

  it('does not take a line of text that merely ends in a dash for the composer rule', async () => {
    setup('claude', 60)
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + ' a note ─\r\n❯ \r\n' + 'plain footer\x1b[2;3H')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(wake.composerState()).toBeNull()
  })

  function chatSetup(kind = 'claude', state = { busy: false }, { isLive, isBlocked } = {}) {
    const write = vi.fn(() => true)
    const rawWrite = vi.fn(() => true)
    wake = createAgentInboxWake({
      kind, cols: 100, rows: 24, quietMs: 60,
      pendingMessages: () => [],
      isWorking: () => state.busy,
      isRunningTask: () => state.busy,
      write, rawWrite, isLive, isBlocked
    })
    return { write, rawWrite }
  }

  it('does not send Fast as a model prompt when the CLI does not offer the choice', async () => {
    const { rawWrite } = chatSetup('codex')
    wake.writeOutput(codexDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText('/fast', undefined, { codexSpeed: 'fast' })
    wake.writeOutput(codexDraft('/fast'))
    await vi.waitFor(() => expect(rawWrite).toHaveBeenLastCalledWith('\x7f'.repeat(5), false), { timeout: 2500 })
    wake.writeOutput(codexDraft(''))
    await expect(sent).resolves.toEqual({ ok: false, reason: 'speed-unavailable' })
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~/fast\x1b[201~', false], ['\x7f'.repeat(5), false]])
  })

  it('reads the native Ultrafast choice and clears the probe before forwarding typing', async () => {
    const { rawWrite } = chatSetup('codex')
    wake.writeOutput(codexDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const probe = wake.submitText('/ultrafas', undefined, { codexSpeed: 'ultrafast', probe: true })
    expect(wake.deferProbeInput('\r')).toBe(true)
    wake.writeOutput(codexDraft('/ultrafast     toggle faster responses\r\n\r\n› /ultrafas'))
    await vi.waitFor(() => expect(rawWrite).toHaveBeenLastCalledWith('\x7f'.repeat(9), false))
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~/ultrafas\x1b[201~', false], ['\x7f'.repeat(9), false]])
    wake.writeOutput(codexDraft(''))
    await expect(probe).resolves.toEqual({ ok: true, available: true })
    expect(rawWrite).toHaveBeenLastCalledWith('\r')
  })

  it('leaves a terminal draft alone when its caret is at the beginning', async () => {
    const { rawWrite } = chatSetup('codex')
    wake.userInput('a draft')
    wake.writeOutput(codexDraft('a draft\x1b[1;3H'))
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(wake.submitText('/ultrafas', undefined, { codexSpeed: 'ultrafast', probe: true }))
      .resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('pastes into the empty composer and presses Enter only once the text is drawn', async () => {
    const { write, rawWrite } = chatSetup()
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText('두 줄\n보내기')
    await vi.waitFor(() => expect(rawWrite.mock.calls).toEqual([['\x1b[200~두 줄\n보내기\x1b[201~']]))
    wake.writeOutput(claudeDraft('두 줄') + '\r\n  보내기')
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls.at(-1)).toEqual(['\r'])
    expect(write).not.toHaveBeenCalled()
  })

  it('also sends while the agent works (Claude takes the line for its next turn)', async () => {
    const { rawWrite } = chatSetup('codex', { busy: true })
    wake.writeOutput(codexDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText('그다음 이것도')
    await vi.waitFor(() => expect(rawWrite).toHaveBeenCalledTimes(1))
    wake.writeOutput(codexDraft('그다음 이것도'))
    await expect(sent).resolves.toEqual({ ok: true })
  })

  it('accepts the placeholder the CLI shows for a long paste', async () => {
    const { rawWrite } = chatSetup()
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText('긴 글\n'.repeat(40))
    await vi.waitFor(() => expect(rawWrite).toHaveBeenCalledTimes(1))
    wake.writeOutput(claudeDraft('[Pasted text #1 +40 lines]'))
    await expect(sent).resolves.toEqual({ ok: true })
  })

  it('types nothing when no agent composer is on screen (a shell prompt must never get the text)', async () => {
    const { rawWrite } = chatSetup()
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[HPS C:\\work> ')
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(wake.submitText('rm -rf ~')).resolves.toEqual({ ok: false, reason: 'no-composer' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('leaves a draft the user is writing alone', async () => {
    const { rawWrite } = chatSetup()
    wake.writeOutput(claudeDraft('쓰던 글'))
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(wake.submitText('새 글')).resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('takes no chat line while a model / effort picker is open, and shows its screen as lines', async () => {
    const { rawWrite } = chatSetup()
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    wake.setHeld(true)
    await expect(wake.submitText('보낼 글')).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(rawWrite).not.toHaveBeenCalled()
    expect(wake.screenLines().some(line => line.startsWith('> '))).toBe(true)
    wake.setHeld(false)
  })

  it('finds Claude\'s composer out of focus (no cursor drawn, terminal cursor in the footer)', async () => {
    const { rawWrite } = chatSetup()
    // Rules around a one-row composer, the terminal cursor parked on the footer, nothing in inverse
    const unfocused = text => '\x1b[?2004h\x1b[2J\x1b[20;1H' + '─'.repeat(70) + '\r\n❯ ' + text + '\r\n' + '─'.repeat(70) + '\r\n  ⏵⏵ auto mode on'
    wake.writeOutput(unfocused('\x1b[2mTry "fix lint errors"\x1b[22m'))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText('보낼 글')
    await vi.waitFor(() => expect(rawWrite).toHaveBeenCalledWith('\x1b[200~보낼 글\x1b[201~'))
    wake.writeOutput(unfocused('보낼 글'))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite).toHaveBeenLastCalledWith('\r')
  })

  it('takes a draft in an out-of-focus Claude composer for a draft', async () => {
    const { rawWrite } = chatSetup()
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[20;1H' + '─'.repeat(70) + '\r\n❯ 쓰던 글\r\n' + '─'.repeat(70) + '\r\n  ⏵⏵ auto mode on')
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(wake.submitText('새 글')).resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('verifies the whole multiline attachment draft when Claude has no visible caret', async () => {
    const { rawWrite } = chatSetup()
    const rule = '─'.repeat(70)
    const unfocused = text => '\x1b[?2004h\x1b[2J\x1b[16;1H' + rule + '\r\n❯ ' + text + '\r\n' + rule + '\r\n\r\n  ⏵⏵ auto mode on'
    wake.writeOutput(unfocused(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const text = '첨부 이미지를 열어 확인해 주세요.\nC:\\Temp\\one.png\nC:\\Temp\\two.png\n\n이미지를 비교해 줘.'
    const sent = wake.submitText(text)
    expect(rawWrite).toHaveBeenCalledWith('\x1b[200~' + text + '\x1b[201~')
    wake.writeOutput(unfocused('첨부 이미지를 열어 확인해 주세요.\r\n  C:\\Temp\\one.png'))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(rawWrite).toHaveBeenCalledTimes(1)
    wake.writeOutput(unfocused(text.replace(/\n/g, '\r\n  ')))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite).toHaveBeenLastCalledWith('\r')
  })

  it('reads the ruled Claude editor even when ConPTY parks the cursor on the prompt row', async () => {
    const { rawWrite } = chatSetup()
    const rule = '─'.repeat(70)
    const unfocused = (text, column) => '\x1b[?2004h\x1b[2J\x1b[H' + rule + '\r\n❯ ' + text
      + '\r\n' + rule + '\r\n\r\n  ⏵⏵ auto mode on' + '\x1b[2;' + column + 'H'
    const text = '첨부 이미지를 열어 확인해 주세요.\nC:\\Temp\\one.png\nC:\\Temp\\two.png\n\n이거 뭔지 알아?'
    // Claude erases the visual caret on blur, leaving the physical cursor on the last cell.
    wake.writeOutput(unfocused('', 100))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText(text)
    expect(rawWrite).toHaveBeenCalledTimes(1)
    // This repaint leaves the physical cursor ahead of the summary instead of at its end.
    wake.writeOutput(unfocused('[Pasted text #1 +4 lines]', 3))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite).toHaveBeenLastCalledWith('\r')
  })

  it('submits only when Claude draws all attached images and the matching text', async () => {
    const { rawWrite } = chatSetup()
    const body = '이미지전송 테스트'
    const paste = 'C:\\Temp\\one.png\nC:\\Temp\\two.png\n\n' + body
    const rule = '─'.repeat(70)
    const rendered = (tokens, text) => claudeDraft(tokens + '\r\n  ' + text)
      + '\r\n' + rule + '\r\n  ⏵⏵ auto mode on'
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText(paste, { count: 2, text: body })
    for (const [tokens, text] of [
      ['[Image #3]', body],
      ['[Image #3] [Image #3]', body],
      ['[Image #3] [Image #4]', '다른 메시지']
    ]) {
      wake.writeOutput(rendered(tokens, text))
      await new Promise(resolve => setTimeout(resolve, 45))
      expect(rawWrite).toHaveBeenCalledTimes(1)
    }
    wake.writeOutput(rendered('[Image #3] [Image #4]', body))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite).toHaveBeenLastCalledWith('\r')
  })

  it('attaches three Codex images one at a time and verifies the wrapped question', async () => {
    const { rawWrite } = chatSetup('codex')
    wake.resize(36, 11)
    const files = ['C:\\Temp\\one.png', 'C:\\Temp\\two.png', 'C:\\Temp\\three.png']
    const body = '이미지 첨부 테스트'
    const part = index => '\x1b[200~' + files[index] + '\x1b[201~'
    const labels = '[Image #7] [Image #8] [Image #9]'
    wake.writeOutput(codexDraft(''))
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const sent = wake.submitText(body, { files })
    expect(rawWrite.mock.calls).toEqual([[part(0)]])

    wake.writeOutput(codexDraft('[Image #7]'))
    await vi.waitFor(() => expect(rawWrite).toHaveBeenLastCalledWith(part(1)))
    wake.writeOutput(codexDraft('[Image #7] [Image #7]'))
    await new Promise(resolve => setTimeout(resolve, 45))
    expect(rawWrite).toHaveBeenCalledTimes(2)
    wake.writeOutput(codexDraft('[Image #7] [Image #8]'))
    await vi.waitFor(() => expect(rawWrite).toHaveBeenLastCalledWith(part(2)))
    wake.writeOutput(codexDraft(labels))
    await vi.waitFor(() => expect(rawWrite).toHaveBeenLastCalledWith('\x1b[200~' + body + '\x1b[201~'))

    // The cursor column follows the question, but ConPTY reports the prompt row.
    const wrapped = text => codexDraft(labels + '\r\n  ' + text + '\r\n\r\n  gpt-5.2 default · /work\x1b[1;21H')
    wake.writeOutput(wrapped('다른 글'))
    await new Promise(resolve => setTimeout(resolve, 45))
    expect(rawWrite).toHaveBeenCalledTimes(4)
    wake.writeOutput(wrapped(body))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls).toEqual([[part(0)], [part(1)], [part(2)], ['\x1b[200~' + body + '\x1b[201~'], ['\r']])
  })

  it('sends a Codex image by itself after the native image label appears', async () => {
    const { rawWrite } = chatSetup('codex')
    wake.writeOutput(codexDraft(''))
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const sent = wake.submitText('', { files: ['C:\\Temp\\one.png'] })
    wake.writeOutput(codexDraft('[Image #1]'))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~C:\\Temp\\one.png\x1b[201~'], ['\r']])
  })

  it('stops staging Codex images if the user types in the terminal', async () => {
    const { rawWrite } = chatSetup('codex')
    wake.writeOutput(codexDraft(''))
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const sent = wake.submitText('봐 줘', { files: ['C:\\Temp\\one.png'] })
    wake.userInput('a')
    wake.writeOutput(codexDraft('[Image #1]'))
    await expect(sent).resolves.toEqual({ ok: false, reason: 'target-changed' })
    expect(rawWrite).toHaveBeenCalledTimes(1)
  })

  describe('sending a paste when the terminal settles', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const bracketedPaste = text => '\x1b[200~' + text + '\x1b[201~'
    const ruledClaude = (cols, lines, focused = true) => {
      const rule = '─'.repeat(cols - 1)
      const input = lines.map((line, index) => (index === 0 ? '❯\u00a0' : '  ') + line)
      if (focused) input[input.length - 1] += '\x1b[7m \x1b[0m'
      return '\x1b[?2004h\x1b[2J\x1b[H' + [rule, ...input, rule, '  idle'].join('\r\n')
    }

    async function paint(frame) {
      wake.writeOutput(frame)
      await vi.advanceTimersByTimeAsync(1)
    }

    it.each([
      ['a session name at the right edge', ' 화성시 임시 조치 방안', '❯ '],
      ['a prompt without a gap', ' 화성시 임시 조치 방안 ─', '❯'],
      ['both changes', ' 화성시 임시 조치 방안', '❯']
    ])('submits the Claude draft after /config redraws %s', async (_layout, title, promptGlyph) => {
      const { rawWrite } = chatSetup()
      const rule = '─'.repeat(90)
      const text = '프로젝트에 적용한 프레임워크 버전이 뭐야?'
      const frame = (top, editor) => '\x1b[?2004h\x1b[2J\x1b[H'
        + ['❯ /config', '  Set Prompt suggestions to off', '', top, editor, rule, '  ⏵⏵ auto mode on'].join('\r\n')
      await paint(frame(rule, '❯ ') + '\x1b[5;3H')
      const sent = wake.submitText(text)
      const top = '─'.repeat(67) + title
      await paint(frame(top, promptGlyph + text + ' ') + '\x1b[5;65H')
      expect(wake.composerState()).toBe('draft')
      expect(wake.inputTarget()).toBe('화성시 임시 조치 방안')
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it('requires a Claude footer before using a title without a trailing rule', async () => {
      const { rawWrite } = chatSetup()
      const rule = '─'.repeat(80)
      await paint('\x1b[?2004h\x1b[2J\x1b[H' + [`${rule} some output`, '❯ ', rule, 'other output'].join('\r\n') + '\x1b[2;3H')
      await expect(wake.submitText('My new question')).resolves.toEqual({ ok: false, reason: 'no-composer' })
      expect(rawWrite).not.toHaveBeenCalled()
    })

    const graySuggestion = '\x1b[38;2;190;190;190mSuggested follow-up\x1b[0m'
    const caretAtStart = '\x1b[2;3H'
    const forcedClear = '\x15'.repeat(29) + '\x0b'.repeat(29)
    const imageBody = '[첨부이미지 1] [첨부이미지 2] Compare the two images.\nCheck both.'
    const imagePaste = 'C:\\Temp\\one.png\nC:\\Temp\\two.png\n\n' + imageBody
    const twoImages = { count: 2, text: imageBody }

    it.each([true, false])('submits Claude images and a body chip after clearing (empty redraw: %s)', async redraw => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['[Image #1] [Pasted text #2 +3 lines]']))
      const { forceToken } = await wake.submitText(imagePaste, twoImages, { offerForce: true })
      const sent = wake.submitText(imagePaste, twoImages, { forceToken })
      if (redraw) await paint(ruledClaude(100, ['']))
      await vi.advanceTimersByTimeAsync(redraw ? 250 : 5300)
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste(imagePaste)]])
      await paint(ruledClaude(100, ['[Image #3] [Image #4][Pasted text #5 +1 lines]']))
      await vi.advanceTimersByTimeAsync(1100)
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste(imagePaste)], ['\r']])
      await expect(sent).resolves.toEqual({ ok: true })
    })

    it('submits an ordinary Claude image paste when Claude collapses the body', async () => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['']))
      const sent = wake.submitText(imagePaste, twoImages)
      await paint(ruledClaude(100, ['[Image #1] [Image #2][Pasted text #3 +1 lines]']))
      await vi.advanceTimersByTimeAsync(750)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(imagePaste)], ['\r']])
      await expect(sent).resolves.toEqual({ ok: true })
    })

    it.each([
      '[Image #1] [Image #3][Pasted text #4 +1 lines]',
      '[Image #3] [Image #3][Pasted text #4 +1 lines]',
      '[Image #3] [Image #4][Pasted text #2 +3 lines]',
      '[Image #3] [Pasted text #4 +1 lines]',
      '[Image #3] [Image #4]'
    ])('does not submit an incomplete or retained Claude image draft: %s', async displayed => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['[Image #1] [Pasted text #2 +3 lines]']))
      const { forceToken } = await wake.submitText(imagePaste, twoImages, { offerForce: true })
      const sent = wake.submitText(imagePaste, twoImages, { forceToken })
      await vi.advanceTimersByTimeAsync(250)
      await paint(ruledClaude(100, [displayed]))
      await vi.advanceTimersByTimeAsync(10500)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'images-not-drawn' })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste(imagePaste)]])
    })

    it.each([true, false])('retries clearing a remaining Claude draft exactly once (second clear succeeds: %s)', async clears => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['First line', 'Last line']))
      const { forceToken } = await wake.submitText(imagePaste, twoImages, { offerForce: true })
      const sent = wake.submitText(imagePaste, twoImages, { forceToken })
      await paint(ruledClaude(100, ['First line']))
      await vi.advanceTimersByTimeAsync(250)
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [forcedClear, false]])
      await paint(ruledClaude(100, [clears ? '' : 'Part of the first line']))
      await vi.advanceTimersByTimeAsync(250)
      if (clears) await paint(ruledClaude(100, ['[Image #1] [Image #2][Pasted text #3 +1 lines]']))
      await vi.advanceTimersByTimeAsync(2200)
      await expect(sent).resolves.toEqual(clears ? { ok: true } : { ok: false, reason: 'not-cleared' })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [forcedClear, false],
        ...(clears ? [[bracketedPaste(imagePaste)], ['\r']] : [])])
    })

    it('sends normally when a color-only suggestion appears in a previously empty editor', async () => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['']))
      await paint(ruledClaude(100, [graySuggestion], false) + caretAtStart)
      const sent = wake.submitText('My new question')
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste('My new question')]])
      await paint(ruledClaude(100, ['My new question']))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste('My new question')], ['\r']])
    })

    it.each([
      ['one chip', '[Pasted text #13 +39 lines]'],
      ['wrapped chip', '[Pasted text #13 +39\nlines]'],
      ['multiple chips with surrounding text', 'Prefix [Pasted text #13 +20 lines] [Pasted text #14 +19 lines] Suffix']
    ])('submits a long Claude paste over a verified suggestion when it draws %s', async (_shape, rendered) => {
      const { rawWrite } = chatSetup()
      const text = 'Prefix\n' + 'Sample line\n'.repeat(39) + 'Suffix'
      await paint(ruledClaude(100, ['']))
      await paint(ruledClaude(100, [graySuggestion], false) + caretAtStart)
      const sent = wake.submitText(text)
      await paint(ruledClaude(100, rendered.split('\n')))
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it('submits a new long Claude paste after force clearing without an empty redraw', async () => {
      const { rawWrite } = chatSetup()
      const text = 'Sample line\n'.repeat(39).trimEnd()
      await paint(ruledClaude(100, [graySuggestion], false) + caretAtStart)
      const offer = await wake.submitText(text, undefined, { offerForce: true })
      expect(offer).toMatchObject({ reason: 'composer-not-empty', forceToken: expect.any(String) })
      const sent = wake.submitText(text, undefined, { forceToken: offer.forceToken })
      await vi.advanceTimersByTimeAsync(250)
      await paint(ruledClaude(100, ['[Pasted text #13 +38 lines]']))
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste(text)], ['\r']])
    })

    it('does not use a paste chip to submit text appended to an uncleared draft', async () => {
      const { rawWrite } = chatSetup()
      const text = 'Unsent draft\n' + 'Sample line\n'.repeat(39).trimEnd()
      await paint(ruledClaude(100, ['Unsent draft']))
      const offer = await wake.submitText(text, undefined, { offerForce: true })
      const sent = wake.submitText(text, undefined, { forceToken: offer.forceToken })
      await vi.advanceTimersByTimeAsync(250)
      await paint(ruledClaude(100, ['Unsent draft[Pasted text #13 +38 lines]']))
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'not-drawn' })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste(text)]])
    })

    it.each(['typed', 'accepted with Tab', 'recalled with Up'])('preserves a Claude draft %s even with the caret at the start', async action => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['']))
      wake.userInput({ typed: 'Draft', 'accepted with Tab': '\t', 'recalled with Up': '\x1b[A' }[action])
      await paint(ruledClaude(100, ['Suggested follow-up'], false) + caretAtStart)
      await expect(wake.submitText('My new question', undefined, { offerForce: true }))
        .resolves.toMatchObject({ ok: false, reason: 'composer-not-empty', forceToken: expect.any(String) })
      expect(rawWrite).not.toHaveBeenCalled()
    })

    it.each([true, false])('retries a rejected Claude send after an explicit clear (clear redraw: %s)', async redraw => {
      const { rawWrite } = chatSetup()
      const previous = redraw ? 'Unsent draft' : graySuggestion
      await paint(ruledClaude(100, [previous], redraw) + (redraw ? '' : caretAtStart))
      const text = 'My new question'
      const offer = await wake.submitText(text, undefined, { offerForce: true })
      expect(offer).toMatchObject({ ok: false, reason: 'composer-not-empty', forceToken: expect.any(String) })
      expect(rawWrite).not.toHaveBeenCalled()

      const sent = wake.submitText(text, undefined, { forceToken: offer.forceToken })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false]])
      if (redraw) await paint(ruledClaude(100, ['']))
      await vi.advanceTimersByTimeAsync(250)
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste(text)]])
      await paint(ruledClaude(100, [text]))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste(text)], ['\r']])
    })

    it('does not submit when a forced paste joins an uncleared draft', async () => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['Unsent draft']))
      const { forceToken } = await wake.submitText('My new question', undefined, { offerForce: true })
      const sent = wake.submitText('My new question', undefined, { forceToken })
      await vi.advanceTimersByTimeAsync(250)
      await paint(ruledClaude(100, ['Unsent draftMy new question']))
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'not-drawn' })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false], [bracketedPaste('My new question')]])
    })

    it('rejects a force offer after the user edits the draft', async () => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['Unsent draft']))
      const { forceToken } = await wake.submitText('My new question', undefined, { offerForce: true })
      wake.userInput('!')
      await expect(wake.submitText('My new question', undefined, { forceToken }))
        .resolves.toEqual({ ok: false, reason: 'draft-changed' })
      expect(rawWrite).not.toHaveBeenCalled()
    })

    it('cancels a forced send when the user types between clear and paste', async () => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['Unsent draft']))
      const { forceToken } = await wake.submitText('My new question', undefined, { offerForce: true })
      const sent = wake.submitText('My new question', undefined, { forceToken })
      wake.userInput('my edit')
      await paint(ruledClaude(100, ['my edit']))
      await vi.advanceTimersByTimeAsync(250)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'interrupted' })
      expect(rawWrite.mock.calls).toEqual([[forcedClear, false]])
    })

    it('waits for 300 ms of composer stability when the paste and screen differ', async () => {
      const { rawWrite } = chatSetup()
      await paint(claudeDraft(''))
      const text = 'Question for Claude'
      const sent = wake.submitText(text)
      await vi.advanceTimersByTimeAsync(550)
      await paint(claudeDraft('Question for'))
      await vi.advanceTimersByTimeAsync(270)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await vi.advanceTimersByTimeAsync(150)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
      await expect(sent).resolves.toEqual({ ok: true })
    })

    it('sends a stable Claude draft while a spinner above the composer keeps changing', async () => {
      const { rawWrite } = chatSetup('claude', { busy: true })
      const frame = text => '\x1b[?2004h\x1b[2J\x1b[H' +
        ['⠋ Working', '', '─'.repeat(70), '> ' + text].join('\r\n')
      const text = 'before 👋🏽 after'
      await paint(frame(''))
      const sent = wake.submitText(text)
      await paint(frame('before 👋 after'))
      for (const spinner of ['⠙', '⠹', '⠸', '⠼']) {
        await vi.advanceTimersByTimeAsync(100)
        await paint(`\x1b7\x1b[1;1H${spinner}\x1b8`)
        expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      }
      for (const spinner of ['⠴', '⠦', '⠧']) {
        await vi.advanceTimersByTimeAsync(100)
        await paint(`\x1b7\x1b[1;1H${spinner}\x1b8`)
      }
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
      await expect(sent).resolves.toEqual({ ok: true })
    })

    it('waits through 600 ms with no output and sends after the late Claude draft settles', async () => {
      const { rawWrite } = chatSetup('claude', { busy: true })
      const text = 'before 👋🏽 after'
      await paint(claudeDraft(''))
      const sent = wake.submitText(text)
      await vi.advanceTimersByTimeAsync(600)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await paint(claudeDraft('before 👋 after'))
      await vi.advanceTimersByTimeAsync(270)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await vi.advanceTimersByTimeAsync(150)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
      await expect(sent).resolves.toEqual({ ok: true })
    })

    it.each([
      { layout: 'word boundaries', cols: 15, rows: ['explain', 'compare', 'rewrite', 'improve', 'confirm'], separator: ' ' },
      { layout: 'wide characters', cols: 9, rows: Array(14).fill('한글로'), separator: '' }
    ])('hypothesis a: sends a Claude draft wrapped past the row estimate at $layout', async ({ cols, rows, separator }) => {
      const { rawWrite } = chatSetup()
      wake.resize(cols, 24)
      await paint(ruledClaude(cols, ['']))
      const text = rows.join(separator)
      const sent = wake.submitText(text)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      // A seven-column slot holds only three Hangul syllables. With words, each seven-letter word occupies its own row.
      await paint(ruledClaude(cols, rows))
      expect(wake.screenLines().slice(1, rows.length + 1).map(row => row.slice(2).trimEnd())).toEqual(rows)
      expect(wake.composerState()).toBe('draft')
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite).toHaveBeenLastCalledWith('\r')
    })

    it('hypothesis b: waits at least 500 ms before sending a settled scrolled draft', async () => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['']))
      const lines = ['Hidden first line', 'Hidden second line', 'Visible third line', 'Visible fourth line']
      const text = lines.join('\n')
      const sent = wake.submitText(text)
      await paint(ruledClaude(100, lines.slice(2)))
      await vi.advanceTimersByTimeAsync(450)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await vi.advanceTimersByTimeAsync(300)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it('hypothesis c: waits for the full paste while a busy Claude progressively redraws it', async () => {
      const { rawWrite } = chatSetup('claude', { busy: true })
      await paint(claudeDraft(''))
      const text = 'Compare what the old layout shows with the current layout.'
      const sent = wake.submitText(text)
      for (let end = 4; end < text.length; end += 4) {
        await vi.advanceTimersByTimeAsync(150)
        await paint(claudeDraft(text.slice(0, end)))
        expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      }
      // The complete draft arrives after the former 1.5-second deadline.
      await paint(claudeDraft(text))
      await vi.advanceTimersByTimeAsync(300)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite).toHaveBeenLastCalledWith('\r')
    })

    it('hypothesis d: queues a second send while the first one is still waiting to press Enter', async () => {
      const { rawWrite } = chatSetup()
      const first = 'First question'
      const second = 'Follow-up question'
      rawWrite.mockImplementation(data => {
        if (data === bracketedPaste(second)) wake.writeOutput(claudeDraft(second))
        return true
      })
      await paint(claudeDraft(''))
      const sent = wake.submitText(first)
      const followUp = wake.submitText(second)
      await paint(claudeDraft(first))
      await vi.advanceTimersByTimeAsync(450)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(first)]])
      await vi.advanceTimersByTimeAsync(250)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(first)], ['\r']])
      await paint(claudeDraft(''))
      await vi.advanceTimersByTimeAsync(750)
      await expect(followUp).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(first)], ['\r'], [bracketedPaste(second)], ['\r']])
    })

    it.each([
      { action: 'closing the inbox', cancel: () => wake.close(), reason: 'not-agent' },
      { action: 'holding the inbox', cancel: () => wake.setHeld(true), reason: 'interrupted' }
    ])('cancels pending sends without writing to the terminal when $action', async ({ cancel, reason }) => {
      const { rawWrite } = chatSetup()
      await paint(claudeDraft(''))
      // While the next frame is unparsed, both sends wait in the queue before any paste.
      wake.writeOutput(claudeDraft(''))
      const pending = [wake.submitText('First question'), wake.submitText('Second question')]
      cancel()
      await vi.advanceTimersByTimeAsync(5100)
      await expect(Promise.all(pending)).resolves.toEqual([
        { ok: false, reason }, { ok: false, reason }
      ])
      expect(rawWrite).not.toHaveBeenCalled()
    })

    it('hypothesis e: verifies emoji, a variation selector, and a combining mark in a regular draft', async () => {
      const { rawWrite } = chatSetup('codex')
      await paint(codexDraft(''))
      const text = '👩‍💻 ✈️ Cafe\u0301'
      const sent = wake.submitText(text)
      await paint(codexDraft(text))
      expect(wake.screenLines()[0]).toBe('› ' + text)
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it.each([['a combining mark', 'e\u0301'], ['a variation selector', '✈️']])(
      'hypothesis e: verifies an exact-fit draft ending in a cell with %s', async (_description, lastCell) => {
        const { rawWrite } = chatSetup('codex')
        wake.resize(10, 24)
        await paint(codexDraft(''))
        const text = '1234567' + lastCell
        const sent = wake.submitText(text)
        // ConPTY can park the caret in the last column when the draft exactly fills the row.
        await paint(codexDraft(text) + '\x1b[1;10H')
        expect(wake.screenLines()[0]).toBe('› ' + text)
        await vi.advanceTimersByTimeAsync(750)
        await expect(sent).resolves.toEqual({ ok: true })
        expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
      }
    )

    it.each([['with focus', true], ['without focus', false]])(
      'hypothesis f: sends literal text that looks like a placeholder in Claude %s', async (_focus, focused) => {
        const { rawWrite } = chatSetup()
        await paint(ruledClaude(100, [''], focused))
        const text = 'Try "fix lint errors"'
        const sent = wake.submitText(text)
        await paint(ruledClaude(100, [text], focused))
        expect(wake.composerState()).toBe('draft')
        await vi.advanceTimersByTimeAsync(750)
        await expect(sent).resolves.toEqual({ ok: true })
        expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
      }
    )

    it.each([
      { state: 'before the user types', keys: [] },
      { state: 'after the user deletes their draft', keys: ['x', '\x7f'] }
    ])('hypothesis f: treats the dimmed hint in unfocused Claude as empty $state', async ({ keys }) => {
      const { rawWrite } = chatSetup()
      for (const key of keys) wake.userInput(key)
      await paint(ruledClaude(100, ['\x1b[2mTry "fix lint errors"\x1b[22m'], false))
      expect(wake.composerState()).toBe('empty')
      const text = 'Review the changes'
      const sent = wake.submitText(text)
      await paint(ruledClaude(100, [text], false))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it.each([['alive', true], ['exited', false]])('does not send Enter at a shell prompt when the process is %s', async (_state, alive) => {
      const isLive = vi.fn(() => true)
      const { rawWrite } = chatSetup('codex', { busy: false }, { isLive })
      await paint(codexDraft(''))
      const text = 'Review the changes'
      const sent = wake.submitText(text)
      isLive.mockReturnValue(alive)
      await paint('\x1b[2J\x1b[HPS C:\\work> ')
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toMatchObject({ ok: false })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
    })

    it('does not send Enter for a matching draft left on screen by an exited agent', async () => {
      const isLive = vi.fn(() => true)
      const { rawWrite } = chatSetup('codex', { busy: false }, { isLive })
      await paint(codexDraft(''))
      const text = 'Review the changes'
      const sent = wake.submitText(text)
      isLive.mockReturnValue(false)
      await paint(codexDraft(text))
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toMatchObject({ ok: false })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
    })

    it('does not send Enter when an approval question replaces the composer after pasting', async () => {
      const { rawWrite } = chatSetup()
      await paint(ruledClaude(100, ['']))
      const text = 'Review the changes'
      const sent = wake.submitText(text)
      await paint('\x1b[2J\x1b[H' + [
        '─'.repeat(70), 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'
      ].join('\r\n'))
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'approval' })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
    })

    it('does not send Enter after a user types, even if the pasted draft then matches', async () => {
      const { rawWrite } = chatSetup()
      await paint(claudeDraft(''))
      const text = 'Review the changes'
      const sent = wake.submitText(text)
      wake.userInput('x')
      await paint(claudeDraft(text))
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'interrupted' })
      expect(rawWrite).not.toHaveBeenCalledWith('\r')
    })

    it('sends at five seconds even while the composer keeps changing', async () => {
      const { rawWrite } = chatSetup('claude', { busy: true })
      const text = 'Question for Claude'
      await paint(claudeDraft(''))
      const sent = wake.submitText(text)
      const redraw = elapsed => paint(claudeDraft(text.slice(0, elapsed % 200 === 0 ? -1 : -2)))
      for (let elapsed = 100; elapsed <= 4800; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100)
        await redraw(elapsed)
      }
      await vi.advanceTimersByTimeAsync(100)
      await redraw(4900)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await vi.advanceTimersByTimeAsync(100)
      await redraw(5000)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
      await expect(sent).resolves.toEqual({ ok: true })
    })

    async function leaveUnsubmittedDraft(text, isBlocked) {
      await paint(claudeDraft(''))
      const sent = wake.submitText(text)
      await paint(claudeDraft(text))
      isBlocked.mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'approval' })
      isBlocked.mockReturnValue(false)
    }

    it('clears its surviving draft before the next send if a guard stopped Enter', async () => {
      const isBlocked = vi.fn(() => false)
      const { rawWrite } = chatSetup('claude', { busy: true }, { isBlocked })
      const first = 'Unsubmitted question'
      const next = 'Next question'
      await leaveUnsubmittedDraft(first, isBlocked)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(first)]])

      const sent = wake.submitText(next)
      await vi.advanceTimersByTimeAsync(100)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(first)], [expect.stringMatching(/^\x7f+$/), false]])
      await paint(claudeDraft(''))
      await vi.advanceTimersByTimeAsync(150)
      expect(rawWrite).toHaveBeenLastCalledWith(bracketedPaste(next))
      await paint(claudeDraft(next))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite).toHaveBeenLastCalledWith('\r')
    })

    it('clears its own unsubmitted Claude paste chip before the next send', async () => {
      const canSend = vi.fn(() => true)
      const { rawWrite } = chatSetup()
      const text = 'Sample line\n'.repeat(39).trimEnd()
      await paint(claudeDraft(''))
      const stopped = wake.submitText(text, undefined, { canSend })
      await paint(claudeDraft('[Pasted text #13 +38 lines]'))
      canSend.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(750)
      await expect(stopped).resolves.toEqual({ ok: false, reason: 'target-changed' })

      const sent = wake.submitText('New question')
      await vi.advanceTimersByTimeAsync(100)
      expect(rawWrite).toHaveBeenLastCalledWith(expect.stringMatching(/^\x7f+$/), false)
      await paint(claudeDraft(''))
      await paint(claudeDraft('New question'))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls.filter(([key]) => key === '\r')).toHaveLength(1)
    })

    it.each(['unchanged', 'different chip', 'terminal edit'])('takes a Claude paste chip back after chat Esc only if its recorded display is %s', async mode => {
      const { rawWrite } = chatSetup()
      const text = 'Sample line\n'.repeat(39).trimEnd()
      const chip = '[Pasted text #13 +38 lines]'
      await paint(claudeDraft(''))
      const sent = wake.submitText(text)
      await paint(claudeDraft(chip))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      await paint(claudeDraft(''))
      wake.interruptChat()
      if (mode === 'terminal edit') wake.userInput('x')
      await paint(claudeDraft(mode === 'different chip' ? '[Pasted text #14 +38 lines]' : chip))

      const taken = wake.takeBack([text])
      if (mode === 'unchanged') {
        await paint(claudeDraft(''))
        await vi.advanceTimersByTimeAsync(150)
        await expect(taken).resolves.toEqual({ ok: true })
        expect(rawWrite).toHaveBeenLastCalledWith(expect.stringMatching(/^\x7f+$/), false)
      } else {
        await expect(taken).resolves.toEqual({ ok: false, reason: 'different' })
        expect(rawWrite).toHaveBeenLastCalledWith('\r')
      }
    })

    it('leaves the resend gate behind when a normal send recovers its aborted draft', async () => {
      const { rawWrite } = chatSetup('claude', { busy: true })
      const verify = vi.fn(() => true)
      const canSend = vi.fn(() => true)
      const first = 'Resent question'
      const next = 'Ordinary follow-up'
      await paint(claudeDraft(''))
      const resend = wake.submitText(first, undefined, { verify, canSend })
      await paint(claudeDraft(first))
      canSend.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(750)
      await expect(resend).resolves.toEqual({ ok: false, reason: 'target-changed' })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(first)]])
      const resendChecks = canSend.mock.calls.length

      verify.mockReturnValue(false)
      await expect(wake.submitText(next)).resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
      verify.mockReturnValue(true)
      const sent = wake.submitText(next)
      expect(rawWrite).toHaveBeenLastCalledWith(expect.stringMatching(/^\x7f+$/), false)
      await paint(claudeDraft(''))
      expect(rawWrite).toHaveBeenLastCalledWith(bracketedPaste(next))
      await paint(claudeDraft(next))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite).toHaveBeenLastCalledWith('\r')
      expect(canSend).toHaveBeenCalledTimes(resendChecks)
    })

    it('finds the Claude footer below a tall visible composer', async () => {
      chatSetup('claude')
      await paint(ruledClaude(100, Array(14).fill('Draft text')))
      expect(wake.composerFooterRow()).toBe(16)
    })

    it('keeps the user’s draft after they edit a paste blocked by a guard', async () => {
      const isBlocked = vi.fn(() => false)
      const { rawWrite } = chatSetup('claude', { busy: true }, { isBlocked })
      const text = 'Unsubmitted question'
      await leaveUnsubmittedDraft(text, isBlocked)
      wake.userInput('x')
      await paint(claudeDraft(text + 'x'))
      await expect(wake.submitText('Next question')).resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
    })

    it.each([
      { kind: 'claude', text: 'before 👋🏽 after', rendered: 'before 👋 after' },
      { kind: 'claude', text: 'cafe\u0301', rendered: 'café' },
      { kind: 'codex', text: 'before ✅ after', rendered: 'before  after' },
      { kind: 'codex', text: 'al' + 'x'.repeat(1498), rendered: 'al[Pasted Content 1498 chars]' }
    ])('sends a $kind paste after the CLI renders it as $rendered', async ({ kind, text, rendered }) => {
      const { rawWrite } = chatSetup(kind)
      const frame = kind === 'claude' ? claudeDraft : codexDraft
      await paint(frame(''))
      const sent = wake.submitText(text)
      await paint(frame(rendered))
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it.each([['Claude’s footer', true], ['a shell prompt', false]])(
      'uses %s to decide whether to send a clipped Claude draft without its top prompt', async (_name, hasFooter) => {
        const { rawWrite } = chatSetup()
        wake.resize(40, 10)
        await paint(ruledClaude(40, ['']))
        const text = 'These separate words make the composer wrap naturally across the terminal. '.repeat(8)
        const sent = wake.submitText(text)
        // Claude Code’s 40×10 screen after pasting 600 characters, with the top rule off screen.
        const bottom = hasFooter ? ['  ⏵⏵ auto mode on (shift+tab to cycle)', '                    ◐ medium · /effort'] : ['PS C:\\work> ']
        await paint('\x1b[2J\x1b[H' + [
          '  composer wrap naturally across the', '  terminal. These separate words make',
          '  the composer wrap naturally across', '  the terminal. These separate words',
          '  make the composer wrap naturally', '  across the terminal.', '─'.repeat(40), ...bottom
        ].join('\r\n') + '\x1b[6;24H')
        await vi.advanceTimersByTimeAsync(hasFooter ? 750 : 5100)
        await expect(sent).resolves.toMatchObject({ ok: hasFooter })
        expect(rawWrite.mock.calls).toEqual(hasFooter ? [[bracketedPaste(text)], ['\r']] : [[bracketedPaste(text)]])
      }
    )

    // Claude Code 2.1.330, current-e2e-40-height{12,10,8}.jsonl, words600-height-*-fresh.
    const claudeOutput = [
      '▎ Claude checks each tool call for risky',
      '▎ actions and prompt injection before   ',
      '▎ executing, runs the ones it assesses  ',
      '▎ as lower-risk, and blocks the rest.   ',
      '▎ https://code.claude.com/docs/en/permis',
      '▎ sion-modes                            ',
      '                    ◐ medium · /effort'
    ]
    const claudeScrollRule = '─── \x1b[2m↑ 15 more\x1b[22m ──────────────────────────'
    const claudeDraftTail = '  across the terminal. \x1b[7m \x1b[27m'
    const shortClaudeScreens = [
      { height: 12, rows: [...claudeOutput, claudeScrollRule,
        '  the terminal. These separate words    ', '  make the composer wrap naturally',
        claudeDraftTail + ' '.repeat(16), '─'.repeat(40)] },
      { height: 10, rows: [...claudeOutput.slice(1), claudeScrollRule,
        '  the terminal. These separate words', '  make the composer wrap naturally      ', claudeDraftTail] },
      { height: 8, rows: [...claudeOutput.slice(2), claudeScrollRule,
        '  the terminal. These separate words', '  make the composer wrap naturally      '] }
    ]

    describe.each(shortClaudeScreens)('Claude’s captured 40×$height scrolled composer', ({ height, rows }) => {
      const text = 'These separate words make the composer wrap naturally across the terminal. '.repeat(8)
      const lastColumn = `\x1b[${height};40H`
      const screenFrame = lines => '\x1b[2J\x1b[H' + lines.join('\r\n') + lastColumn

      it('sends once when a scroll rule marks the visible draft', async () => {
        const { rawWrite } = chatSetup()
        wake.resize(40, height)
        await paint(ruledClaude(40, ['']))
        const sent = wake.submitText(text)
        await paint(screenFrame(rows))
        expect(wake.screenLines()).toContain('─── ↑ 15 more ──────────────────────────')
        await vi.advanceTimersByTimeAsync(750)
        expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
        await expect(sent).resolves.toEqual({ ok: true })
      })

      it('does not send if a shell prompt appears among the draft rows off the cursor', async () => {
        const { rawWrite } = chatSetup()
        wake.resize(40, height)
        await paint(ruledClaude(40, ['']))
        const sent = wake.submitText(text)
        const mixed = [...rows]
        mixed[rows.indexOf(claudeScrollRule) + 1] = 'PS C:\\work> '
        await paint(screenFrame(mixed))
        await vi.advanceTimersByTimeAsync(5100)
        expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
        await expect(sent).resolves.toMatchObject({ ok: false })
      })
    })

    it.each([
      { row: '  composer wrap naturally across the', label: 'sends the visible draft', blocked: false },
      { row: 'bash-5.2$ ', label: 'blocks a Bash prompt off the cursor', blocked: true }
    ])('a Claude composer with only a downward scroll rule $label', async ({ row, blocked }) => {
      const { rawWrite } = chatSetup()
      wake.resize(40, 8)
      await paint(ruledClaude(40, ['']))
      const text = 'These separate words make the composer wrap naturally across the terminal. '.repeat(8)
      const sent = wake.submitText(text)
      await paint('\x1b[2J\x1b[H' + [
        '  These separate words make the', row, '  terminal. These separate words make',
        claudeScrollRule.replace('↑', '↓'), '  ⏵⏵ auto mode on'
      ].join('\r\n'))
      await vi.advanceTimersByTimeAsync(blocked ? 5100 : 750)
      expect(rawWrite.mock.calls).toEqual(blocked ? [[bracketedPaste(text)]] : [[bracketedPaste(text)], ['\r']])
      await expect(sent).resolves.toEqual(blocked ? { ok: false, reason: 'not-drawn' } : { ok: true })
    })

    it('does not send Enter at a PowerShell continuation prompt below a stale Claude composer', async () => {
      const { rawWrite } = chatSetup('claude', undefined, { isLive: () => true })
      await paint(ruledClaude(100, ['']))
      const text = 'Review the changes'
      const sent = wake.submitText(text)
      await paint('\x1b[2J\x1b[H' + [
        '─── ↑ 3 more ───',
        '  Previous draft, first visible line',
        '  Previous draft, second visible line',
        '─'.repeat(70),
        '  ? for shortcuts',
        'PS C:\\work> line one',
        '>> line two'
      ].join('\r\n'))
      await vi.advanceTimersByTimeAsync(5100)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await expect(sent).resolves.toMatchObject({ ok: false })
    })

    it('sends a Codex draft with a scroll marker after the terminal settles', async () => {
      const { rawWrite } = chatSetup('codex')
      wake.resize(40, 9)
      await paint(codexDraft(''))
      const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '.repeat(3).slice(0, 300)
      const sent = wake.submitText(text)
      // Codex’s 40×9 screen shows only the end of the paste and indicates hidden rows with ↑.
      await paint('\x1b[2J\x1b[H' + [
        '', '', '› chi psi omega alpha beta gamma delta ↑', '  epsilon zeta eta theta iota kappa',
        '  lambda mu nu xi omicron pi rho sigma', '  tau upsilon phi chi psi omega alpha',
        '  beta gamma delta epsilon zeta eta', '  theta iota k', ''
      ].join('\r\n') + '\x1b[8;15H')
      await vi.advanceTimersByTimeAsync(750)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it('waits for a late Codex paste token while the composer still looks empty', async () => {
      const { rawWrite } = chatSetup('codex')
      await paint(codexDraft(''))
      const text = 'x'.repeat(1498)
      const sent = wake.submitText(text)
      await paint(codexDraft(''))
      await vi.advanceTimersByTimeAsync(500)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await paint(codexDraft('[Pasted Content 1498 chars]'))
      await vi.advanceTimersByTimeAsync(300)
      await expect(sent).resolves.toEqual({ ok: true })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)], ['\r']])
    })

    it('expires without Enter at the five-second deadline when the Codex composer stays empty', async () => {
      const { rawWrite } = chatSetup('codex')
      await paint(codexDraft(''))
      const text = 'x'.repeat(1498)
      const sent = wake.submitText(text)
      await vi.advanceTimersByTimeAsync(4900)
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
      await vi.advanceTimersByTimeAsync(200)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'not-drawn' })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
    })

    it.each([
      { kind: 'claude', empty: ruledClaude(100, [''], false),
        hint: ruledClaude(100, ['\x1b[2mReview the previous answer\x1b[22m'], false) },
      { kind: 'codex', empty: codexDraft(''), hint: codexDraft('\x1b[2mAsk Codex…\x1b[22m\x1b[1;3H') }
    ])('expires without Enter when $kind only draws a dim suggestion after the paste', async ({ kind, empty, hint }) => {
      const { rawWrite } = chatSetup(kind)
      await paint(empty)
      const text = 'Question for the agent'
      const sent = wake.submitText(text)
      await paint(hint)
      await vi.advanceTimersByTimeAsync(5100)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'not-drawn' })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste(text)]])
    })

    it('rechecks approval at the deadline before sending into an empty composer', async () => {
      const isBlocked = vi.fn(() => false)
      const { rawWrite } = chatSetup('codex', undefined, { isBlocked })
      await paint(codexDraft(''))
      const sent = wake.submitText('Question for Codex')
      await vi.advanceTimersByTimeAsync(4900)
      isBlocked.mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(200)
      await expect(sent).resolves.toEqual({ ok: false, reason: 'approval' })
      expect(rawWrite.mock.calls).toEqual([[bracketedPaste('Question for Codex')]])
    })

    it('blocks a 999-character Codex paste while a 998-character draft is still in the composer', async () => {
      const { rawWrite } = chatSetup('codex')
      await paint(codexDraft('x'.repeat(998)))
      await expect(wake.submitText('y'.repeat(999))).resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
      expect(rawWrite).not.toHaveBeenCalled()
    })

    describe('sending Enter once', () => {
      const text = 'Review the changes'
      const paste = bracketedPaste(text)

      async function startSend() {
        const { rawWrite } = chatSetup('codex')
        await paint(codexDraft(''))
        const sent = wake.submitText(text)
        return { rawWrite, sent }
      }

      async function sendFirstEnter(rawWrite) {
        await paint(codexDraft(text))
        await vi.advanceTimersByTimeAsync(750)
        expect(rawWrite.mock.calls).toEqual([[paste], ['\r']])
      }

      it.each([
        { kind: 'claude', frame: claudeDraft, input: text, rendered: text },
        { kind: 'claude', frame: claudeDraft, input: (text + '\n').repeat(40), rendered: '[Pasted text #1 +40 lines]' },
        { kind: 'codex', frame: codexDraft, input: text, rendered: text },
        { kind: 'codex', frame: codexDraft, input: 'x'.repeat(1498), rendered: '[Pasted Content 1498 chars]' }
      ])('waits 500 ms and verifies a stable reread in $kind for $rendered', async ({ kind, frame, input, rendered }) => {
        const { rawWrite } = chatSetup(kind)
        await paint(frame(''))
        const sent = wake.submitText(input)
        const pasted = bracketedPaste(input)
        await paint(frame(rendered))
        await vi.advanceTimersByTimeAsync(480)
        expect(rawWrite.mock.calls).toEqual([[pasted]])
        await vi.advanceTimersByTimeAsync(100)
        expect(rawWrite.mock.calls).toEqual([[pasted]])
        await vi.advanceTimersByTimeAsync(170)
        expect(rawWrite.mock.calls).toEqual([[pasted], ['\r']])
        await expect(sent).resolves.toEqual({ ok: true })
      })

      it('restarts the 300 ms stability interval when a partial draft grows', async () => {
        const { rawWrite, sent } = await startSend()
        await vi.advanceTimersByTimeAsync(550)
        await paint(codexDraft('Review'))
        await vi.advanceTimersByTimeAsync(220)
        expect(rawWrite.mock.calls).toEqual([[paste]])
        await paint(codexDraft('Review the'))
        await vi.advanceTimersByTimeAsync(270)
        expect(rawWrite.mock.calls).toEqual([[paste]])
        await vi.advanceTimersByTimeAsync(150)
        expect(rawWrite.mock.calls).toEqual([[paste], ['\r']])
        await expect(sent).resolves.toEqual({ ok: true })
      })

      it('presses Enter exactly once even if the draft remains with a trailing newline', async () => {
        const { rawWrite, sent } = await startSend()
        await sendFirstEnter(rawWrite)
        await expect(sent).resolves.toEqual({ ok: true })
        await paint(codexDraft(text + '\r\n  '))
        await vi.advanceTimersByTimeAsync(5000)
        expect(rawWrite.mock.calls).toEqual([[paste], ['\r']])
      })

      it('presses Enter exactly once when Codex takes a second to clear the composer', async () => {
        const { rawWrite, sent } = await startSend()
        await sendFirstEnter(rawWrite)
        await expect(sent).resolves.toEqual({ ok: true })
        for (let elapsed = 100; elapsed <= 1000; elapsed += 100) {
          await vi.advanceTimersByTimeAsync(100)
          await paint(`\x1b7\x1b[5;1HWorking ${elapsed}\x1b8`)
        }
        expect(rawWrite.mock.calls).toEqual([[paste], ['\r']])
        await paint(codexDraft(''))
        expect(rawWrite.mock.calls).toEqual([[paste], ['\r']])
      })
    })
  })
})

describe('the chat view and an empty composer with a placeholder', () => {
  it('sends into an empty composer that shows placeholder text right of the cursor', async () => {
    const rawWrite = vi.fn(() => true)
    wake = createAgentInboxWake({ kind: 'claude', cols: 100, rows: 24, pendingMessages: () => [], isWorking: () => false, write: vi.fn(() => true), rawWrite })
    // Claude Code: "> " then a dim hint, the cursor back at the prompt's start
    wake.writeOutput(claudeDraft('') + '\x1b[2mTry "fix the failing test"\x1b[22m\x1b[3G')
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText('안녕')
    await vi.waitFor(() => expect(rawWrite).toHaveBeenCalledTimes(1))
    wake.writeOutput(claudeDraft('안녕'))
    await expect(sent).resolves.toEqual({ ok: true })
  })
})

describe('the agent\'s prompt with choices, answered from the chat view', () => {
  // Shaped like Claude Code's permission dialog and Codex's approval (the input box is replaced)
  const claudeOptions = selected =>
    [' 1. Yes', ' 2. Yes, and don\'t ask again for npm test commands', ' 3. No, and tell Claude what to do differently (esc)']
      .map((label, index) => (index + 1 === selected ? ' ❯' : '  ') + label).join('\r\n')
  const claudePrompt = (selected = 1, command = 'npm test') => '\x1b[?2004h\x1b[2J\x1b[H' + 'output above\r\n' + '─'.repeat(70) + '\r\n' +
    ` Bash command\r\n\r\n   ${command}\r\n   Run the tests\r\n\r\n Do you want to proceed?\r\n` + claudeOptions(selected)
  const codexPrompt = '\x1b[?2004h\x1b[2J\x1b[H' + 'earlier answer\r\n\r\n  Would you like to run the following command?\r\n\r\n  $ npm test\r\n\r\n' +
    '› 1. Yes, proceed (y)\r\n  2. Yes, and don\'t ask again for this command (p)\r\n  3. No, and tell Codex what to do differently (esc)\r\n\r\n  Press enter to confirm or esc to cancel'

  function promptSetup(kind, onApprovalChange) {
    const rawWrite = vi.fn(() => true)
    wake = createAgentInboxWake({ kind, cols: 100, rows: 24, pendingMessages: () => [], isWorking: () => true, write: vi.fn(() => true), rawWrite, onApprovalChange })
    return { rawWrite }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 30))

  it('reads Claude\'s question, what it is about and its choices', async () => {
    promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    const prompt = wake.approvalPrompt()
    expect(prompt.question).toBe('Do you want to proceed?')
    expect(prompt.detail).toEqual(['Bash command', 'npm test', 'Run the tests'])
    expect(prompt.options.map(option => option.label)).toEqual(['Yes', 'Yes, and don\'t ask again for npm test commands', 'No, and tell Claude what to do differently (esc)'])
    expect(prompt.selected).toBe('1')
  })

  // 2026-11-24 user report: Claude's startup question sat above its composer with a notice below it.
  // The chat showed no card and only said the line could not be sent.
  const claudeDialogOverComposer = '\x1b[?2004h\x1b[2J\x1b[H' + [
    '─'.repeat(70),
    ' Teach auto mode about your environment?', '',
    ' Auto mode works better when it knows your environment. Takes about a', ' minute.', '',
    ' ❯ 1. Yes', '   2. Not now', '   3. Don\'t show again', '',
    ' Enter to confirm · Esc to cancel', '',
    ' Heads up · 휴대폰에서 에이전트에게 채팅을 보낼 수 있게 되면 셸 입력을 막아도', ' 사실상 같습니다.',
    ' 1: Learn more   2: Knew this already   0: Dismiss', '',
    '─'.repeat(70), '❯ ', '─'.repeat(70), '  ⏵⏵ auto mode on (shift+tab to cycle)'
  ].join('\r\n')

  it('reads Claude\'s dialog drawn above a visible composer, past a notice below it', async () => {
    promptSetup('claude')
    wake.writeOutput(claudeDialogOverComposer)
    await settle()
    const prompt = wake.approvalPrompt()
    expect(prompt).toMatchObject({ question: 'Teach auto mode about your environment?', selected: '1' })
    expect(prompt.options.map(option => option.label)).toEqual(['Yes', 'Not now', 'Don\'t show again'])
  })

  it('refuses a chat line while that dialog is up, naming the question as the reason', async () => {
    const write = vi.fn(() => true)
    wake = createAgentInboxWake({ kind: 'claude', cols: 100, rows: 24, pendingMessages: () => [], isWorking: () => false, write })
    wake.writeOutput(claudeDialogOverComposer)
    await settle()
    await expect(wake.submitText('응 다 끝나면 알려줘')).resolves.toEqual({ ok: false, reason: 'approval' })
    expect(write).not.toHaveBeenCalled()
  })

  it('does not take a numbered list in the conversation above an active composer for a question', async () => {
    promptSetup('claude')
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + [
      '● 순서는 다음과 같습니다.', '  1. 빌드', '  2. 시험', '  3. 배포', '',
      '─'.repeat(70), '❯ ', '─'.repeat(70), '  ⏵⏵ auto mode on'
    ].join('\r\n'))
    await settle()
    expect(wake.approvalPrompt()).toBeNull()
  })

  it.each(['with a footer', 'with just the composer prompt'])('sends a numbered Claude draft %s', async layout => {
    const { rawWrite } = promptSetup('claude')
    const body = '1. 첫 번째 항목만 넣어 줘\n2. 지난 기록도 포함해 줘\n3. 확인이 필요한 목록은 따로 적어 줘'
    const draw = text => '\x1b[?2004h\x1b[2J\x1b[H' + [
      '─'.repeat(70), '❯ ' + text.replace(/\n/g, '\r\n  '),
      ...(layout === 'with a footer' ? ['─'.repeat(70), '  ⏵⏵ auto mode on'] : [])
    ].join('\r\n')
    wake.writeOutput(draw(''))
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const sent = wake.submitText(body)
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~' + body + '\x1b[201~']])
    wake.writeOutput(draw(body))
    await expect(sent).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~' + body + '\x1b[201~'], ['\r']])
  })

  it('withholds Enter when a real dialog appears over the numbered draft', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudeDraft(''))
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const body = '1. 검토\n2. 수정\n3. 보고'
    const sent = wake.submitText(body)
    wake.writeOutput(claudeDialogOverComposer.replace('\r\n❯ \r\n', '\r\n❯ 1. 검토\r\n  2. 수정\r\n  3. 보고\r\n'))
    await expect(sent).resolves.toEqual({ ok: false, reason: 'approval' })
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~' + body + '\x1b[201~']])
    expect(wake.approvalPrompt()).toMatchObject({ question: 'Teach auto mode about your environment?' })
  })

  it('reads Codex\'s question up to the question line, past the hint below the choices', async () => {
    promptSetup('codex')
    // A previous model picker can still appear in the scrollback above the live Yes/No prompt.
    wake.writeOutput(codexPrompt.replace('earlier answer', [
      '  Select Model and Effort', '› 1. GPT-6.2-Sol (current)', '  2. GPT-6.2-Astra',
      '  enter select · esc back'
    ].join('\r\n')))
    await settle()
    const prompt = wake.approvalPrompt()
    expect(prompt.question).toBe('Would you like to run the following command?')
    expect(prompt.detail).toEqual(['$ npm test'])
    expect(prompt.options.map(option => option.key)).toEqual(['1', '2', '3'])
  })

  it('recognizes Claude’s tabbed checklist without sending any approval keys', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + [
      '이전 작업 내용', '─'.repeat(70), '←  □ 반영 범위  ✓ Submit  →', '',
      '│ 어떤 변경을 반영할까요? (선택한 항목만', '│ 반영합니다.)', '',
      '❯ 1. [ ] 첫 번째 변경', '       첫 번째 변경의 설명',
      '  2. [ ] 두 번째 변경', '  3. [ ] Type something', '   Submit', '─'.repeat(70),
      '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'
    ].join('\r\n'))
    await settle()
    const prompt = wake.approvalPrompt()
    expect(prompt).toMatchObject({ question: '어떤 변경을 반영할까요? (선택한 항목만 반영합니다.)', options: [], usesTerminalInput: true })
    await expect(wake.answerApproval('1', prompt.signature)).resolves.toEqual({ ok: false, reason: 'changed' })
    expect(rawWrite).not.toHaveBeenCalled()
    wake.writeOutput('\x1b[2J\x1b[H' + [
      '←  □ 반영 범위  ✓ Submit  →', '', 'Review your answers', '',
      '❯ 1. Submit answers', '  2. Go back', 'Tab/Arrow keys to navigate · Esc to cancel'
    ].join('\r\n'))
    await settle()
    expect(wake.approvalPrompt()).toEqual(prompt)
    wake.writeOutput('\x1b[2J\x1b[H' + [
      'Review your answers', '', '❯ 1. Submit answers', '  2. Go back', 'Tab/Arrow keys to navigate · Esc to cancel'
    ].join('\r\n'))
    await settle()
    expect(wake.approvalPrompt()).toEqual(prompt)
    wake.writeOutput(claudePrompt())
    await settle()
    expect(wake.approvalPrompt()).toMatchObject({ question: 'Do you want to proceed?', selected: '1' })
    wake.writeOutput(claudeDraft(''))
    await settle()
    expect(wake.approvalPrompt()).toBeNull()
  })

  it('recognizes Claude’s question when a narrow pane folds its keyboard hint over two rows', async () => {
    promptSetup('claude')
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + [
      '─'.repeat(40), '←  ☐ 과일  ☐ 색  ✔ Submit  →', '', '어떤 과일을 넣을까요?', '',
      '❯ 1. [ ] Apple', '  2. [ ] Banana', '  3. [ ] Type something', '     Next', '─'.repeat(40),
      '  4. Chat about this', '', 'Enter to select · Tab/Arrow keys to navigate · ', 'Esc to cancel'
    ].join('\r\n'))
    await settle()
    expect(wake.approvalPrompt()).toMatchObject({ question: '어떤 과일을 넣을까요?', options: [], usesTerminalInput: true })
  })

  it('recognizes Claude’s question with previews though its full-width rows wrap into the next ones', async () => {
    promptSetup('claude')
    // The CLI pads its rule and the preview rows to the pane's width and goes on without a line break,
    // so the terminal marks each following row as wrapped (seen with Claude Code 2.1.3xx, 2026-11-23)
    const cells = text => [...text].reduce((sum, ch) => sum + (/[가-힣]/u.test(ch) ? 2 : 1), 0)
    const full = text => text + ' '.repeat(100 - cells(text))
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + [
      '─'.repeat(100), full(' ☐ 유형별 사진 '), full(''),
      full('│ 신규입고 카드에 넣을 사진의 출처를 정해 주세요.'), full(''),
      full('❯ 1. 기존 아이콘으로 유형 카드    ┌──────────────┐'),
      full('    (Recommended)                 │ +--------+   │'),
      full('  2. 이미지 파일을 받아서 적용    │ | 아이콘 |   │'),
      full('  3. 종 사진 우선                 │ +--------+   │'),
      full('                                  └──────────────┘'), full(''),
      full('                                  Notes: press n to add notes'), full(''),
      '─'.repeat(100), full('  Chat about this'), full(''),
      'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel'
    ].join(''))
    await settle()
    expect(wake.approvalPrompt()).toMatchObject({ question: '신규입고 카드에 넣을 사진의 출처를 정해 주세요.', options: [], usesTerminalInput: true })
  })

  it('reads the heading of a single Claude question with no Submit tab', async () => {
    promptSetup('claude')
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + [
      'Earlier output', '  1. Earlier list item', '  2. Another item', '─'.repeat(70), ' ☐ 배포 범위 ', '',
      '어느 환경에 적용할까요?', '', '❯ 1. 개발', '     개발 환경', '  2. 운영', '     운영 환경',
      '  3. Type something.', '─'.repeat(70), '  4. Chat about this', '',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
    ].join('\r\n'))
    await settle()
    expect(wake.approvalPrompt()).toMatchObject({ question: '어느 환경에 적용할까요?', options: [], usesTerminalInput: true })
  })

  it('recognizes the interactive choices when the question has scrolled above them', async () => {
    promptSetup('claude')
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + [
      '       Previous option description', '❯ 2. [ ] Another option', '  3. [ ] Type something',
      '   Submit', '─'.repeat(70), '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'
    ].join('\r\n'))
    await settle()
    expect(wake.approvalPrompt()).toMatchObject({ question: null, options: [], usesTerminalInput: true })
  })

  it('sees no prompt while the composer shows (a numbered list in the output is not one)', async () => {
    promptSetup('claude')
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H1. first\r\n2. second\r\n' + '─'.repeat(70) + '\r\n> ')
    await settle()
    expect(wake.approvalPrompt()).toBeNull()
  })

  it('presses the number of the choice when the prompt is still the one shown, and Enter only if that just moved the selection', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    const { signature } = wake.approvalPrompt()
    const answered = wake.answerApproval('2', signature)
    expect(rawWrite.mock.calls).toEqual([['2']])
    // This CLI only moved its selection to the choice
    wake.writeOutput(claudePrompt(2))
    await expect(answered).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls).toEqual([['2'], ['\r']])
  })

  it('waits past 600 ms for Ink to clear and redraw the choices in separate chunks', async () => {
    const onApprovalChange = vi.fn()
    const { rawWrite } = promptSetup('claude', onApprovalChange)
    wake.writeOutput(claudePrompt())
    await vi.waitFor(() => expect(onApprovalChange).toHaveBeenLastCalledWith(true))
    const { signature } = wake.approvalPrompt()
    const answered = wake.answerApproval('2', signature)
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(rawWrite.mock.calls).toEqual([['2']])
    wake.writeOutput('\x1b[9;1H\x1b[J')
    await vi.waitFor(() => expect(onApprovalChange).toHaveBeenLastCalledWith(false), { interval: 5 })
    expect(wake.approvalPrompt()).toBeNull()
    wake.writeOutput(claudeOptions(2))
    await settle()
    expect(wake.approvalPrompt()).toMatchObject({ selected: '2' })
    expect(wake.approvalPrompt().signature).not.toBe(signature)
    expect(rawWrite.mock.calls).toEqual([['2']])
    await expect(answered).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls).toEqual([['2'], ['\r']])
  })

  it('does not press Enter when the prompt went away (answered) even if the same one shows again', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    const { signature } = wake.approvalPrompt()
    const answered = wake.answerApproval('1', signature)
    wake.writeOutput('\x1b[2J\x1b[Hrunning npm test…')
    await expect(answered).resolves.toEqual({ ok: true })
    wake.writeOutput(claudePrompt())
    await vi.waitFor(() => expect(wake.approvalPrompt()).toMatchObject({ selected: '1' }))
    expect(wake.approvalPrompt().signature).not.toBe(signature)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(rawWrite.mock.calls).toEqual([['1']])
  })

  it.each([20, 100, 200])('does not confirm a different command with the same choices after %i ms', async delay => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt(1, 'git log'))
    await settle()
    const first = wake.approvalPrompt()
    const answered = wake.answerApproval('1', first.signature)
    wake.writeOutput('\x1b[2J\x1b[H⏺ Bash(git log)')
    await new Promise(resolve => setTimeout(resolve, delay))
    wake.writeOutput(claudePrompt(1, 'git push --force'))
    await expect(answered).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(wake.approvalPrompt()?.detail).toContain('git push --force'))
    const second = wake.approvalPrompt()
    expect(second.question).toBe(first.question)
    expect(second.options).toEqual(first.options)
    expect(second.signature).not.toBe(first.signature)
    expect(rawWrite.mock.calls).toEqual([['1']])
  })

  it('distinguishes commands that differ outside the detail display limit', async () => {
    promptSetup('claude')
    const prefix = 'echo ' + 'a'.repeat(320)
    wake.writeOutput(claudePrompt(1, prefix + 'x'))
    await settle()
    const first = wake.approvalPrompt()
    wake.writeOutput(claudePrompt(1, prefix + 'y'))
    await settle()
    const second = wake.approvalPrompt()
    expect(second.detail).toEqual(first.detail)
    expect(second.signature).not.toBe(first.signature)
  })

  it.each([
    ['an unruled header', 'claude', seconds => claudePrompt().replace('─'.repeat(70), `✻ Waiting… (${seconds}s) `)],
    ['a varying Claude spinner word', 'claude', seconds => claudePrompt().replace('─'.repeat(70), `✶ ${seconds === 1 ? 'Cogitating' : 'Herding'}… (${seconds}s · esc to interrupt)`)],
    ['a question without a question mark', 'codex', seconds => codexPrompt.replace('earlier answer', `• Working (${seconds}s …)`).replace('command?', 'command')]
  ])('keeps the identity of %s stable while the progress timer updates', async (_name, kind, frame) => {
    promptSetup(kind)
    wake.writeOutput(frame(1))
    await settle()
    const first = wake.approvalPrompt()
    wake.writeOutput(frame(2))
    await settle()
    expect(wake.approvalPrompt()).toMatchObject({ signature: first.signature, detail: first.detail })
  })

  it('starts a fresh card when the same question and selection return after an absent frame', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    const { signature } = wake.approvalPrompt()
    const answered = wake.answerApproval('1', signature)
    wake.writeOutput('\x1b[9;1H\x1b[J')
    wake.writeOutput(claudeOptions(1))
    await expect(answered).resolves.toEqual({ ok: true })
    expect(wake.approvalPrompt().signature).not.toBe(signature)
    await expect(wake.answerApproval('1', signature)).resolves.toEqual({ ok: false, reason: 'changed' })
    expect(rawWrite.mock.calls).toEqual([['1']])
  })

  it('gives a returning question a fresh identity when it was answered in the terminal', async () => {
    const onApprovalChange = vi.fn()
    const { rawWrite } = promptSetup('claude', onApprovalChange)
    wake.writeOutput(claudePrompt())
    await vi.waitFor(() => expect(onApprovalChange).toHaveBeenLastCalledWith(true))
    const { signature } = wake.approvalPrompt()
    wake.userInput('1')
    wake.writeOutput('\x1b[2J\x1b[H⏺ Bash(npm test)')
    await vi.waitFor(() => expect(onApprovalChange).toHaveBeenLastCalledWith(false), { interval: 5 })
    wake.writeOutput(claudePrompt())
    await vi.waitFor(() => expect(onApprovalChange).toHaveBeenLastCalledWith(true))
    expect(wake.approvalPrompt().signature).not.toBe(signature)
    await expect(wake.answerApproval('1', signature)).resolves.toEqual({ ok: false, reason: 'changed' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('presses Enter after 600 ms without a repaint when the chosen row was already selected', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    const startedAt = Date.now()
    const answered = wake.answerApproval('1', wake.approvalPrompt().signature)
    expect(rawWrite.mock.calls).toEqual([['1']])
    await expect(answered).resolves.toEqual({ ok: true })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600)
    expect(rawWrite.mock.calls).toEqual([['1'], ['\r']])
  })

  it('reports a stalled choice when the question stays and the CLI does not move the selection', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    await expect(wake.answerApproval('2', wake.approvalPrompt().signature)).resolves.toEqual({ ok: false, reason: 'stuck' })
    expect(rawWrite.mock.calls).toEqual([['2']])
  })

  it('reports a failed Enter write', async () => {
    const { rawWrite } = promptSetup('claude')
    rawWrite.mockImplementation(key => key !== '\r')
    wake.writeOutput(claudePrompt())
    await settle()
    const answered = wake.answerApproval('2', wake.approvalPrompt().signature)
    wake.writeOutput(claudePrompt(2))
    await expect(answered).resolves.toEqual({ ok: false, reason: 'write-failed' })
    expect(rawWrite.mock.calls).toEqual([['2'], ['\r']])
  })

  it('refuses a choice for a prompt that is no longer on screen', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    const { signature } = wake.approvalPrompt()
    wake.writeOutput('\x1b[2J\x1b[Hsomething else')
    await settle()
    await expect(wake.answerApproval('1', signature)).resolves.toEqual({ ok: false, reason: 'changed' })
    expect(rawWrite).not.toHaveBeenCalled()
  })
})

describe('sending Antigravity chat text through the verified idle editor', () => {
  const rule = '─'.repeat(40)
  const model = 'Gemini 3.8 Flash · high'
  const idleFooter = `? for shortcuts  ${model}`
  const draw = (lines, row, column) => '\x1b[?2004h\x1b[2J\x1b[H' + lines.join('\r\n') + `\x1b[${row + 1};${column + 1}H`
  const editor = (text = '') => draw([
    'PS C:\\dev> agy', 'Agent output', rule, `> ${text}`, rule,
    text ? model.padStart(40) : idleFooter, 'ezShell status probe'
  ], 3, text.length + 2)
  const settle = () => new Promise(resolve => setTimeout(resolve, 30))

  function setupAntigravity() {
    const state = { working: false, blocked: false, live: true, unknown: false, verified: true }
    const write = vi.fn(() => true)
    const rawWrite = vi.fn(() => true)
    wake = createAgentInboxWake({
      kind: 'antigravity', cols: 40, rows: 12, pendingMessages: () => ['unread'],
      isWorking: () => state.working, isBlocked: () => state.blocked, isLive: () => state.live,
      isUnknown: () => state.unknown, write, rawWrite
    })
    return { state, write, rawWrite }
  }

  it('pastes into an empty bordered editor with historical PowerShell output, then submits the drawn text once', async () => {
    const { write, rawWrite } = setupAntigravity()
    wake.writeOutput(editor())
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const answered = wake.submitText('Hello from chat')
    const pasted = '\x1b[200~Hello from chat\x1b[201~'
    expect(rawWrite.mock.calls).toEqual([[pasted]])
    await expect(wake.submitText('Another line')).resolves.toEqual({ ok: false, reason: 'busy' })
    wake.writeOutput(editor('Hello from chat'))
    await expect(answered).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls).toEqual([[pasted], ['\r']])
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    ['a long-text chip', editor('[Pasted text #1 1001 chars]')],
    ['a long-lines chip', editor('[Pasted text #2 +16 lines]')],
    ['a clipped draft', draw(['> ↑ 14 more lines', '  wrapped draft', '  visible end.', rule, model.padStart(40)], 2, 14)]
  ])('uses %s as a visible draft only', async (_name, painted) => {
    const { rawWrite } = setupAntigravity()
    wake.writeOutput(painted)
    await settle()
    expect(wake.composerState()).toBe('draft')
    await expect(wake.submitText('New line')).resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
    expect(rawWrite).not.toHaveBeenCalled()

    wake.writeOutput(editor())
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const answered = wake.submitText('A long draft that the CLI represents differently')
    wake.writeOutput(painted)
    await expect(answered).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls.map(([data]) => data)).toEqual([
      '\x1b[200~A long draft that the CLI represents differently\x1b[201~', '\r'
    ])
  })

  it.each([
    ['a plain greater-than prompt', draw(['> '], 0, 2)],
    ['a missing footer', draw([rule, '> ', rule], 1, 2)],
    ['a working footer', draw([rule, '> ', rule, `esc to cancel  ${model}`], 1, 2)],
    ['a shell cursor outside a stale editor', draw([rule, '> ', rule, idleFooter, 'PS C:\\dev> '], 4, 11)],
    ['an alternate buffer', '\x1b[?1049h' + editor()]
  ])('refuses to paste at %s even with an idle report', async (_name, screen) => {
    const { rawWrite } = setupAntigravity()
    wake.writeOutput(screen)
    await settle()
    expect(wake.composerState()).toBeNull()
    await expect(wake.submitText('Text')).resolves.toEqual({ ok: false, reason: 'no-composer' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('blocks an actual selection screen even when a ruled empty editor and stale idle status coexist', async () => {
    const { rawWrite } = setupAntigravity()
    wake.writeOutput(draw(['Question 1/1: Which option?', '> 1. Continue', '  2. Cancel', '', rule, '> ', rule, idleFooter], 5, 2))
    await settle()
    const approval = wake.approvalPrompt()
    expect(approval).toMatchObject({ usesTerminalInput: true })
    await expect(wake.answerApproval('1', approval.signature)).resolves.toEqual({ ok: false, reason: 'changed' })
    await expect(wake.submitText('Text')).resolves.toEqual({ ok: false, reason: 'approval' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it.each([
    ['working', true, 'busy'], ['unknown', true, 'busy'], ['blocked', true, 'approval'],
    ['live', false, 'not-agent'], ['verified', false, 'target-changed']
  ])('rechecks %s between paste and Enter', async (flag, value, reason) => {
    const { rawWrite, state } = setupAntigravity()
    wake.writeOutput(editor())
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const answered = wake.submitText('Text', undefined, { canSend: () => state.verified })
    state[flag] = value
    wake.writeOutput(editor('Text'))
    await expect(answered).resolves.toEqual({ ok: false, reason })
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~Text\x1b[201~']])
  })

  it('leaves a pasted draft alone when the user takes over before Enter', async () => {
    const { rawWrite } = setupAntigravity()
    wake.writeOutput(editor())
    await vi.waitFor(() => expect(wake.composerState()).toBe('empty'))
    const answered = wake.submitText('Text')
    wake.userInput('x')
    wake.writeOutput(editor('Textx'))
    await expect(answered).resolves.toEqual({ ok: false, reason: 'interrupted' })
    await vi.waitFor(() => expect(wake.composerState()).toBe('draft'))
    await expect(wake.submitText('Text')).resolves.toEqual({ ok: false, reason: 'composer-not-empty' })
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~Text\x1b[201~']])
  })
})

describe('Claude background shell count', () => {
  it('reads only the live footer and distinguishes zero from a missing composer', async () => {
    wake = createAgentInboxWake({
      kind: 'claude', cols: 100, rows: 24, pendingMessages: () => [], isWorking: () => false, write: vi.fn()
    })
    const border = '─'.repeat(70)
    const footer = text => claudeDraft('') + '\r\n' + border + '\r\n' + text
    wake.writeOutput(footer('  ⏵⏵ auto mode on · 1 shell · ← 1 agent · ↓ to manage'))
    await vi.waitFor(() => expect(wake.backgroundShellCount()).toBe(1))
    wake.writeOutput(footer('  3 shells ·\r\n  ← 1 agent · ↓ to manage'))
    await vi.waitFor(() => expect(wake.backgroundShellCount()).toBe(3))
    wake.writeOutput(footer('  ⏵⏵ auto mode on · ← 1 agent · ↓ to manage'))
    await vi.waitFor(() => expect(wake.backgroundShellCount()).toBe(0))
    wake.writeOutput('\x1b[2J\x1b[HCommand output: 42 shells · ↓ to manage')
    await vi.waitFor(() => expect(wake.backgroundShellCount()).toBeNull())
  })
})

describe('a prompt in a narrow pane', () => {
  it('joins choices the terminal wrapped', async () => {
    wake = createAgentInboxWake({ kind: 'claude', cols: 30, rows: 24, pendingMessages: () => [], isWorking: () => true, write: vi.fn(() => true) })
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(30) + '\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again for npm run build commands\r\n   3. No')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(wake.approvalPrompt()?.options.map(option => option.label)).toEqual(['Yes', 'Yes, and don\'t ask again for npm run build commands', 'No'])
  })
})

// Esc while a chat line waited: the CLI puts the queued line back into its composer (2026-11-22 user
// report). The chat takes it back so its own box gets the text and the composer is empty for the next send.
describe('taking a queued chat line back from the composer (takeBack)', () => {
  function backSetup(kind = 'claude') {
    const rawWrite = vi.fn(() => true)
    wake = createAgentInboxWake({
      kind, cols: 100, rows: 24, quietMs: 60,
      pendingMessages: () => [],
      isWorking: () => false,
      write: vi.fn(() => true), rawWrite
    })
    return { rawWrite }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  it('cancels a chat send before the PTY confirms the pasted text, so it never sends Enter', async () => {
    const { rawWrite } = backSetup()
    wake.writeOutput(claudeDraft(''))
    await settle()
    const sent = wake.submitText('아직 보낼 필요가 없는 질문')
    wake.userInput('\x1b')
    wake.writeOutput(claudeDraft('아직 보낼 필요가 없는 질문'))
    await expect(sent).resolves.toEqual({ ok: false, reason: 'interrupted' })
    await settle()
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~아직 보낼 필요가 없는 질문\x1b[201~']])
  })

  it.each([['claude', claudeDraft], ['codex', codexDraft]])('%s: clears the composer when it holds exactly the queued lines', async (kind, draft) => {
    const { rawWrite } = backSetup(kind)
    wake.writeOutput(draft('라이브러리 메뉴에 연구논문 추가'))
    await settle()
    const taken = wake.takeBack(['라이브러리 메뉴에 연구논문 추가'])
    await vi.waitFor(() => expect(rawWrite).toHaveBeenCalledTimes(1))
    const [keys, track] = rawWrite.mock.calls[0]
    expect(keys).toMatch(/^\x7f+$/)
    expect(keys.length).toBeGreaterThanOrEqual('라이브러리 메뉴에 연구논문 추가'.length)
    expect(track).toBe(false)
    wake.writeOutput(draft(''))
    await expect(taken).resolves.toEqual({ ok: true })
  })

  it('takes several queued lines back together, however the CLI joined them', async () => {
    const { rawWrite } = backSetup()
    wake.writeOutput(claudeDraft('첫 질문 둘째 질문'))
    await settle()
    const taken = wake.takeBack(['첫 질문', '둘째 질문'])
    await vi.waitFor(() => expect(rawWrite).toHaveBeenCalledTimes(1))
    wake.writeOutput(claudeDraft(''))
    await expect(taken).resolves.toEqual({ ok: true })
  })

  it('never touches a draft that is not what the chat sent', async () => {
    const { rawWrite } = backSetup()
    wake.writeOutput(claudeDraft('터미널에서 내가 쓰던 글'))
    await settle()
    await expect(wake.takeBack(['채팅에서 보낸 글'])).resolves.toEqual({ ok: false, reason: 'different' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('reports an empty composer without writing (the CLI did not put the line back)', async () => {
    const { rawWrite } = backSetup()
    wake.writeOutput(claudeDraft(''))
    await settle()
    await expect(wake.takeBack(['채팅에서 보낸 글'])).resolves.toEqual({ ok: false, reason: 'empty' })
    expect(rawWrite).not.toHaveBeenCalled()
  })

  it('reports when the composer does not empty', async () => {
    backSetup()
    wake.writeOutput(claudeDraft('채팅에서 보낸 글'))
    await settle()
    await expect(wake.takeBack(['채팅에서 보낸 글'])).resolves.toEqual({ ok: false, reason: 'not-cleared' })
  })
})
