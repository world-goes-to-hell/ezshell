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
