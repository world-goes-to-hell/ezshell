import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentInboxWake, PROMPT, BUSY_PROMPT, REMIND_PROMPT } from './agentInboxWake.js'

const paste = '\x1b[200~' + PROMPT + '\x1b[201~'
const busyPaste = '\x1b[200~' + BUSY_PROMPT + '\x1b[201~'
const remindPaste = '\x1b[200~' + REMIND_PROMPT + '\x1b[201~'
const claudeDraft = text => '\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(70) + '\r\n> ' + text
const codexDraft = text => '\x1b[?2004h\x1b[2J\x1b[H› ' + text
const paintedClaudeDraft = text => '\x1b[?2004h\x1b[?25l\x1b[2J\x1b[20;1H' +
  '─'.repeat(70) + '\r\n❯\u00a0' + text + '\x1b[7m \x1b[0m\r\n' +
  '─'.repeat(70) + '\r\n  ⏵⏵ auto mode on'

let wake
function setup(kind = 'claude', cols = 100) {
  const write = vi.fn(() => true)
  // ids: unread (wake for these); open: not answered yet, read or not
  // busy: not waiting for input; running: busy with a task (not starting up or asking for approval)
  const state = { busy: false, running: true, unknown: false, ids: [], open: [] }
  wake = createAgentInboxWake({
    kind, cols, rows: 24, quietMs: 60,
    isUnknown: () => state.unknown,
    pendingMessages: () => state.ids,
    unhandledMessages: () => state.open,
    isWorking: () => state.busy,
    isRunningTask: () => state.busy && state.running,
    write
  })
  return { write, state }
}

afterEach(() => wake?.close())

describe('wake an idle agent with unread messages', () => {
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
  function chatSetup(kind = 'claude', state = { busy: false }) {
    const write = vi.fn(() => true)
    const rawWrite = vi.fn(() => true)
    wake = createAgentInboxWake({
      kind, cols: 100, rows: 24, quietMs: 60,
      pendingMessages: () => [],
      isWorking: () => state.busy,
      isRunningTask: () => state.busy,
      write, rawWrite
    })
    return { write, rawWrite }
  }

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
    wake.writeOutput(unfocused('Try "fix lint errors"'))
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

  it('does not press Enter when the composer never shows the text', async () => {
    const { rawWrite } = chatSetup()
    wake.writeOutput(claudeDraft(''))
    await new Promise(resolve => setTimeout(resolve, 20))
    const sent = wake.submitText('보낼 글')
    wake.writeOutput(claudeDraft('다른 글'))
    await expect(sent).resolves.toEqual({ ok: false, reason: 'not-drawn' })
    expect(rawWrite.mock.calls).toEqual([['\x1b[200~보낼 글\x1b[201~']])
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
  const claudePrompt = (selected = 1) => '\x1b[?2004h\x1b[2J\x1b[H' + 'output above\r\n' + '─'.repeat(70) + '\r\n' +
    ' Bash command\r\n\r\n   npm test\r\n   Run the tests\r\n\r\n Do you want to proceed?\r\n' +
    [' 1. Yes', ' 2. Yes, and don\'t ask again for npm test commands', ' 3. No, and tell Claude what to do differently (esc)']
      .map((label, index) => (index + 1 === selected ? ' ❯' : '  ') + label).join('\r\n')
  const codexPrompt = '\x1b[?2004h\x1b[2J\x1b[H' + 'earlier answer\r\n\r\n  Would you like to run the following command?\r\n\r\n  $ npm test\r\n\r\n' +
    '› 1. Yes, proceed (y)\r\n  2. Yes, and don\'t ask again for this command (p)\r\n  3. No, and tell Codex what to do differently (esc)\r\n\r\n  Press enter to confirm or esc to cancel'

  function promptSetup(kind) {
    const rawWrite = vi.fn(() => true)
    wake = createAgentInboxWake({ kind, cols: 100, rows: 24, pendingMessages: () => [], isWorking: () => true, write: vi.fn(() => true), rawWrite })
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

  it('reads Codex\'s question up to the question line, past the hint below the choices', async () => {
    promptSetup('codex')
    wake.writeOutput(codexPrompt)
    await settle()
    const prompt = wake.approvalPrompt()
    expect(prompt.question).toBe('Would you like to run the following command?')
    expect(prompt.detail).toEqual(['$ npm test'])
    expect(prompt.options.map(option => option.key)).toEqual(['1', '2', '3'])
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

  it('does not press Enter when the prompt went away (answered) even if the same one shows again', async () => {
    const { rawWrite } = promptSetup('claude')
    wake.writeOutput(claudePrompt())
    await settle()
    const { signature } = wake.approvalPrompt()
    const answered = wake.answerApproval('1', signature)
    wake.writeOutput('\x1b[2J\x1b[Hrunning npm test…')
    await settle()
    wake.writeOutput(claudePrompt())
    await expect(answered).resolves.toEqual({ ok: true })
    expect(rawWrite.mock.calls).toEqual([['1']])
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

describe('a prompt in a narrow pane', () => {
  it('joins choices the terminal wrapped', async () => {
    wake = createAgentInboxWake({ kind: 'claude', cols: 30, rows: 24, pendingMessages: () => [], isWorking: () => true, write: vi.fn(() => true) })
    wake.writeOutput('\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(30) + '\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again for npm run build commands\r\n   3. No')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(wake.approvalPrompt()?.options.map(option => option.label)).toEqual(['Yes', 'Yes, and don\'t ask again for npm run build commands', 'No'])
  })
})
