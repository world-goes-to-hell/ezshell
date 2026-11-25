import { describe, expect, it } from 'vitest'
import { prepareHandoff, handoffMessage, agentLabel, MAX_MESSAGE } from './handoff.js'
import { registerAgentChatIpc } from './ipc.js'

const AGENTS = [
  { id: 'claude-4', kind: 'claude', role: '리뷰어', active: true, mcpConnected: true },
  { id: 'codex-9', kind: 'codex', role: null, active: true, mcpConnected: true },
  { id: 'codex-2', kind: 'codex', active: false, mcpConnected: false },
  { id: 'claude-7', kind: 'claude', active: true, mcpConnected: false, sleeping: true }
]

describe('handoff message', () => {
  it('names the source agent with its role and keeps the comment above the answer', () => {
    expect(agentLabel(AGENTS[0])).toBe('Claude Code 4(리뷰어)')
    expect(agentLabel({ id: 'codex-9', kind: 'codex' })).toBe('Codex 9')
    expect(handoffMessage({ from: AGENTS[0], comment: '이대로 구현해 주세요.', answer: '계획입니다.' }))
      .toBe('[인계] Claude Code 4(리뷰어)의 답변을 넘깁니다.\n\n이대로 구현해 주세요.\n\n--- 넘겨받은 답변 ---\n계획입니다.')
  })

  it('cuts a long answer at its end so the whole fits the inbox, never the comment', () => {
    const comment = '코멘트'.repeat(100)
    const text = handoffMessage({ from: AGENTS[0], comment, answer: 'a'.repeat(20_000) })
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(text).toContain(comment)
    expect(text.endsWith('(이하 생략)')).toBe(true)
  })
})

describe('prepareHandoff', () => {
  const request = (over = {}) => ({ to: 'codex-9', comment: '확인 부탁해요', answer: '답변', ...over })

  it('builds the message for a connected (or sleeping) agent', () => {
    expect(prepareHandoff({ request: request(), sourceAgentId: 'claude-4', agents: AGENTS })).toMatchObject({ to: 'codex-9', toLabel: 'Codex 9' })
    expect(prepareHandoff({ request: request({ to: 'claude-7' }), sourceAgentId: 'claude-4', agents: AGENTS })).toMatchObject({ to: 'claude-7' })
  })

  it('refuses the chat\'s own agent, an agent that is not connected and an unknown one', () => {
    expect(prepareHandoff({ request: request({ to: 'claude-4' }), sourceAgentId: 'claude-4', agents: AGENTS }).error).toBeTruthy()
    expect(prepareHandoff({ request: request({ to: 'codex-2' }), sourceAgentId: 'claude-4', agents: AGENTS }).error).toBeTruthy()
    expect(prepareHandoff({ request: request({ to: 'nobody' }), sourceAgentId: 'claude-4', agents: AGENTS }).error).toBeTruthy()
  })

  it('refuses control characters, an empty answer and a comment over the limit', () => {
    expect(prepareHandoff({ request: request({ comment: 'a\x1b[2Jb' }), sourceAgentId: 'claude-4', agents: AGENTS }).error).toBeTruthy()
    expect(prepareHandoff({ request: request({ answer: '   ' }), sourceAgentId: 'claude-4', agents: AGENTS }).error).toBeTruthy()
    expect(prepareHandoff({ request: request({ comment: 'x'.repeat(2001) }), sourceAgentId: 'claude-4', agents: AGENTS }).error).toBeTruthy()
  })

  it('names an agent without the message MCP by its kind', () => {
    const { text } = prepareHandoff({ request: request(), sourceAgentId: null, sourceKind: 'claude', agents: AGENTS })
    expect(text.startsWith('[인계] Claude Code의 답변을 넘깁니다.')).toBe(true)
  })
})

describe('agent-chat-handoff', () => {
  function harness({ locked = false, agentId = 'claude-4', throws = null } = {}) {
    const handlers = new Map()
    const sent = []
    registerAgentChatIpc({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
      fromMainWindow: () => true,
      isLocked: () => locked,
      chats: {},
      shells: () => ({ agentOf: id => (id === 'local:1' ? { kind: 'claude', status: 'idle' } : null), chatAgentId: () => agentId }),
      clipboard: {},
      handoff: {
        agents: () => AGENTS,
        send: request => {
          if (throws) throw new Error(throws)
          sent.push(request)
          return { id: 'm1' }
        }
      }
    })
    const mainFrame = {}
    const call = (request, frame = mainFrame) => handlers.get('agent-chat-handoff')({ senderFrame: frame, sender: { mainFrame } }, request)
    return { call, sent }
  }

  it('sends the built message as the user to the chosen agent', async () => {
    const { call, sent } = harness()
    expect(await call({ shellId: 'local:1', to: 'codex-9', comment: '', answer: '답변' })).toEqual({ ok: true, to: 'codex-9', toLabel: 'Codex 9' })
    expect(sent).toEqual([{ to: 'codex-9', text: '[인계] Claude Code 4(리뷰어)의 답변을 넘깁니다.\n\n--- 넘겨받은 답변 ---\n답변' }])
  })

  it('refuses while locked, from a child frame, from a shell without an agent, and to the chat\'s own agent', async () => {
    expect((await harness({ locked: true }).call({ shellId: 'local:1', to: 'codex-9', answer: 'x' })).ok).toBe(false)
    expect((await harness().call({ shellId: 'local:1', to: 'codex-9', answer: 'x' }, {})).ok).toBe(false)
    expect((await harness().call({ shellId: 'local:2', to: 'codex-9', answer: 'x' })).ok).toBe(false)
    const own = harness()
    expect((await own.call({ shellId: 'local:1', to: 'claude-4', answer: 'x' })).ok).toBe(false)
    expect(own.sent).toEqual([])
  })

  it('answers the inbox\'s refusal as an error', async () => {
    const { call } = harness({ throws: '메시지를 받을 실행 중인 에이전트를 찾을 수 없습니다.' })
    expect(await call({ shellId: 'local:1', to: 'codex-9', answer: 'x' })).toEqual({ ok: false, error: '메시지를 받을 실행 중인 에이전트를 찾을 수 없습니다.' })
  })
})
