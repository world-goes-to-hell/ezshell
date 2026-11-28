// The chat's bell: "지금 알리기" on one message (agent-inbox-notify, 2026-11-28 user request)
import { describe, expect, it } from 'vitest'
import { registerAgentChatIpc } from './ipc.js'
import { isInboxPrompt, messagePrompt } from '../ipc/agentInboxPrompts.js'

const MESSAGE = '11111111-2222-4333-8444-555555555555'

function harness({ kind = 'claude', unhandled = [MESSAGE], locked = false, mainFrame = true } = {}) {
  const handlers = new Map()
  const sent = []
  registerAgentChatIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    fromMainWindow: () => mainFrame,
    isLocked: () => locked,
    chats: {},
    shells: () => ({
      agentOf: () => ({ kind, status: 'working' }),
      chatSend: async (id, prompt) => { sent.push({ id, prompt }); return { ok: true } }
    }),
    clipboard: {},
    inbox: { unhandledFor: () => unhandled }
  })
  const call = request => handlers.get('agent-inbox-notify')({}, request)
  return { call, sent }
}

describe('asking an agent to handle one message now', () => {
  it('pastes the fixed line naming the message through the chat send path, even while the agent works', async () => {
    const { call, sent } = harness()
    expect(await call({ shellId: 'local:1', messageId: MESSAGE })).toEqual({ ok: true })
    expect(sent).toEqual([{ id: 'local:1', prompt: messagePrompt(MESSAGE) }])
    // The chat shows it as an inbox notice, not as something the user said
    expect(isInboxPrompt(sent[0].prompt)).toBe(true)
  })

  it('refuses a message the agent has handled or that is not its own, and anything but a message id', async () => {
    const { call, sent } = harness({ unhandled: [] })
    expect(await call({ shellId: 'local:1', messageId: MESSAGE })).toMatchObject({ ok: false })
    expect(await call({ shellId: 'local:1', messageId: 'read everything; rm -rf' })).toMatchObject({ ok: false, error: '메시지를 찾지 못했습니다.' })
    expect(await call({ shellId: '../x', messageId: MESSAGE })).toMatchObject({ ok: false })
    expect(sent).toEqual([])
  })

  it('only from the unlocked main window, and only to a chat agent', async () => {
    for (const options of [{ locked: true }, { mainFrame: false }, { kind: 'antigravity' }, { kind: 'shell' }]) {
      const { call, sent } = harness(options)
      expect(await call({ shellId: 'local:1', messageId: MESSAGE }), JSON.stringify(options)).toMatchObject({ ok: false })
      expect(sent).toEqual([])
    }
  })

  it('builds the line only from a message id', () => {
    expect(() => messagePrompt('x\nrm -rf /')).toThrow()
    expect(isInboxPrompt('ezShell message 11111111-2222-4333-8444-555555555555 is waiting for you: read it now with read_inbox, then handle it. and more')).toBe(false)
  })
})
