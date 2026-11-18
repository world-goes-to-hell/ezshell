import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentInboxWake, PROMPT } from './agentInboxWake.js'

const paste = '\x1b[200~' + PROMPT + '\x1b[201~'
const claudeDraft = text => '\x1b[?2004h\x1b[2J\x1b[H' + '─'.repeat(70) + '\r\n> ' + text
const codexDraft = text => '\x1b[?2004h\x1b[2J\x1b[H› ' + text
const paintedClaudeDraft = text => '\x1b[?2004h\x1b[?25l\x1b[2J\x1b[20;1H' +
  '─'.repeat(70) + '\r\n❯\u00a0' + text + '\x1b[7m \x1b[0m\r\n' +
  '─'.repeat(70) + '\r\n  ⏵⏵ auto mode on'

let wake
function setup(kind = 'claude') {
  const write = vi.fn(() => true)
  const state = { busy: false, ids: [] }
  wake = createAgentInboxWake({
    kind, cols: 100, rows: 24,
    pendingMessages: () => state.ids,
    isWorking: () => state.busy,
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

  it('keeps queued messages while the agent is busy or a user draft is open', async () => {
    const { write, state } = setup('codex')
    state.busy = true
    state.ids.push('first')
    wake.writeOutput(codexDraft(''))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(write).not.toHaveBeenCalled()

    state.busy = false
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
