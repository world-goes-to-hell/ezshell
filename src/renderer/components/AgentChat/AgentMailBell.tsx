// The chat header's bell (2026-11-28 user request): opens the messages this agent has not handled yet, and picking
// one asks the agent to handle it now (agent-inbox-notify: main checks the message is this agent's and pastes the
// fixed line naming it through the chat's send path; while the agent works it waits for its turn).
// The class name stays `agent-chat-notification`: the delivery animation flies to it (AgentMessages.tsx).
import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiLoader4Line, RiMailLine, RiNotification3Line } from 'react-icons/ri'
import { openAgentMessages, useAgentMessagesStore } from '../Terminal/AgentMessages'
import { toast } from '../../stores/toastStore'
import { pendingMessagesFor, senderName, messageTime, MAX_BELL_MESSAGES } from '../../lib/agentMailBell'
import type { AgentMessageSession } from '../../types'
import './AgentMailBell.css'

export function AgentMailBell({ shellId, agent, unread, tabId }: {
  shellId: string
  agent: AgentMessageSession
  /** Not read yet (the count on the bell) */
  unread: number
  tabId?: string
}) {
  const snapshot = useAgentMessagesStore(state => state.snapshot)
  const [sending, setSending] = useState<string | null>(null)
  const pending = pendingMessagesFor(snapshot.messages, agent.id)
  const label = unread ? `읽지 않은 메시지 ${unread}개` : '메시지 알림'
  const canNotify = typeof window.electronAPI.agentInboxNotify === 'function' && agent.active

  const notify = async (messageId: string) => {
    setSending(messageId)
    try {
      const result = await window.electronAPI.agentInboxNotify?.(shellId, messageId)
      if (!result) return
      if (result.ok) toast.success('에이전트에게 알렸습니다', '이 메시지를 지금 읽고 처리하도록 입력했습니다.')
      else toast.error('알리지 못했습니다', result.error)
    } catch {
      toast.error('알리지 못했습니다')
    } finally {
      setSending(null)
    }
  }

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="agent-chat-notification" title={`${label} · 눌러서 보기`} aria-label={label} data-unread={unread > 0}>
          <RiNotification3Line size={15} aria-hidden="true" />
          {unread > 0 && <span className="agent-mail-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="terminal-menu agent-mail-bell-menu" align="end" sideOffset={4} collisionPadding={8}>
          <div className="agent-mail-bell-head">
            {pending.length ? `처리하지 않은 메시지 ${pending.length}개` : '처리하지 않은 메시지가 없습니다'}
            {pending.length > 0 && canNotify && <span className="agent-mail-bell-hint">눌러서 지금 알리기</span>}
          </div>
          {pending.slice(0, MAX_BELL_MESSAGES).map(message => (
            <DropdownMenu.Item key={message.id} className="agent-mail-bell-item" data-seen={message.seenAt ? '' : undefined}
              disabled={!canNotify || sending !== null}
              title={canNotify ? '이 메시지를 지금 읽고 처리하도록 에이전트에게 알립니다' : '에이전트가 연결돼 있지 않습니다'}
              onSelect={() => void notify(message.id)}>
              <span className="agent-mail-bell-meta">
                <span className="agent-mail-bell-from">{senderName(message.from, snapshot.agents)}</span>
                <span className="agent-mail-bell-time">{messageTime(message.sentAt)}</span>
                {message.seenAt ? <span className="agent-mail-bell-state">읽음 · 답 없음</span> : <span className="agent-mail-bell-state is-new">새 메시지</span>}
                {sending === message.id && <RiLoader4Line size={12} className="agent-chat-spin" aria-hidden="true" />}
              </span>
              <span className="agent-mail-bell-text">{message.reviewRequest?.text ?? message.text}</span>
            </DropdownMenu.Item>
          ))}
          {pending.length > MAX_BELL_MESSAGES && <div className="agent-mail-bell-more">외 {pending.length - MAX_BELL_MESSAGES}개는 메시지함에서 봅니다</div>}
          <DropdownMenu.Separator className="terminal-menu-separator" />
          <DropdownMenu.Item className="terminal-menu-item" onSelect={() => openAgentMessages(agent.id, tabId)}>
            <RiMailLine size={15} aria-hidden="true" /> 메시지함 열기
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
