// What the chat's bell lists (AgentChat/AgentMailBell.tsx): the messages an agent has not handled yet (answered or
// acknowledged), oldest first as its inbox reads them, read ones included (a request put off while it works).
import type { AgentMessage, AgentMessageSession } from '../types'

export const MAX_BELL_MESSAGES = 20

export function pendingMessagesFor(messages: readonly AgentMessage[], agentId: string): AgentMessage[] {
  return messages.filter(message => message.to === agentId && !message.read).sort((a, b) => a.sentAt - b.sentAt)
}

/** "사용자", or the agent id with its role ("claude-5 · 개발B") */
export function senderName(from: string, agents: readonly AgentMessageSession[]): string {
  if (from === 'user') return '사용자'
  const role = agents.find(agent => agent.id === from)?.role
  return role ? `${from} · ${role}` : from
}

/** Time today, else month and day with the time */
export function messageTime(sentAt: number, now = Date.now()): string {
  const at = new Date(sentAt)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return new Date(now).toDateString() === at.toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`
}
