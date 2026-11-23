import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { AgentMessage } from '../../types'
import { AgentMessageThread } from './AgentMessageThread'

it('starts a new sender group across a local date boundary', () => {
  const messages: AgentMessage[] = [
    { id: 'one', from: 'codex-1', to: 'claude-2', text: 'first', read: false, sentAt: new Date(2026, 0, 1, 23, 58).getTime() },
    { id: 'two', from: 'codex-1', to: 'claude-2', text: 'second', read: false, sentAt: new Date(2026, 0, 1, 23, 59).getTime() },
    { id: 'three', from: 'codex-1', to: 'claude-2', text: 'third', read: false, sentAt: new Date(2026, 0, 2, 0, 1).getTime() }
  ]
  const html = renderToStaticMarkup(createElement(AgentMessageThread, {
    messages,
    originals: new Map(),
    states: new Map(),
    name: '메시지',
    actor: id => id,
    identityOf: id => id,
    term: '',
    rightAgent: 'codex-1',
    pair: true
  }))

  expect(html.match(/class="agent-message-date"/g)).toHaveLength(2)
  expect(html.match(/class="agent-message-group-label"/g)).toHaveLength(2)
  expect(html.match(/class="agent-thread-message"/g)).toHaveLength(3)
})
