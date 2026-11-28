import { describe, expect, it } from 'vitest'
import { messageTime, pendingMessagesFor, senderName } from './agentMailBell'
import type { AgentMessage, AgentMessageSession } from '../types'

const message = (id: string, to: string, sentAt: number, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, from: 'claude-5', to, text: id, sentAt, read: false, ...extra })

describe('the chat bell', () => {
  it('lists the agent\u2019s messages not handled yet, oldest first, read ones included', () => {
    const messages = [message('b', 'claude-2', 20), message('a', 'claude-2', 10, { seenAt: 15 }), message('done', 'claude-2', 5, { read: true }), message('other', 'codex-6', 1)]
    expect(pendingMessagesFor(messages, 'claude-2').map(item => item.id)).toEqual(['a', 'b'])
  })

  it('names the sender with its role, and the user', () => {
    const agents = [{ id: 'claude-5', role: '개발B' }] as AgentMessageSession[]
    expect(senderName('claude-5', agents)).toBe('claude-5 · 개발B')
    expect(senderName('codex-6', agents)).toBe('codex-6')
    expect(senderName('user', agents)).toBe('사용자')
  })

  it('shows the time today, the date before', () => {
    const now = new Date(2026, 10, 28, 15, 0).getTime()
    expect(messageTime(new Date(2026, 10, 28, 9, 5).getTime(), now)).toBe('09:05')
    expect(messageTime(new Date(2026, 10, 27, 23, 41).getTime(), now)).toBe('11/27 23:41')
  })
})
