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
function setup(kind = 'claude') {
  const write = vi.fn(() => true)
  // ids: unread (wake for these); open: not answered yet, read or not
  // busy: not waiting for input; running: busy with a task (not starting up or asking for approval)
  const state = { busy: false, running: true, unknown: false, ids: [], open: [] }
  wake = createAgentInboxWake({
    kind, cols: 100, rows: 24, quietMs: 60,
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
    // It read the message (no longer unread) and sent a receipt, but has not answered yet
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
    // Two agents talking: the message was read inside a running turn (wait_for_message) before Enter
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
