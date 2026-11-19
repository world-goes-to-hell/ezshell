import { describe, expect, it } from 'vitest'
import type { AgentChatItem } from '../types'
import { MAX_CHAT_ITEMS, diffLineKind, mergeChatItems, shellAgentOf } from './agentChatItems'

const item = (id: string, text = id): AgentChatItem => ({ id, kind: 'assistant', time: null, text })
const ids = (items: AgentChatItem[]) => items.map(entry => entry.id)

describe('merging chat frames', () => {
  it('appends new items and replaces one that came again (a tool with its result)', () => {
    const merged = mergeChatItems([item('a'), item('t', 'running')], [item('t', 'done'), item('b')], 'append')
    expect(ids(merged)).toEqual(['a', 't', 'b'])
    expect(merged[1].text).toBe('done')
  })

  it('puts older items before what is shown', () => {
    expect(ids(mergeChatItems([item('c'), item('d')], [item('a'), item('b'), item('c', 'again')], 'older'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('starts over on reset', () => {
    expect(ids(mergeChatItems([item('a')], [item('x')], 'reset'))).toEqual(['x'])
  })

  it('keeps at most the limit: appending drops the oldest, older items fill only the room left', () => {
    const full = Array.from({ length: MAX_CHAT_ITEMS }, (_, index) => item(String(index)))
    const appended = mergeChatItems(full, [item('new')], 'append')
    expect(appended).toHaveLength(MAX_CHAT_ITEMS)
    expect(appended[0].id).toBe('1')
    expect(appended[appended.length - 1].id).toBe('new')
    expect(mergeChatItems(full, [item('old')], 'older')).toHaveLength(MAX_CHAT_ITEMS)
    const almost = full.slice(2)
    expect(ids(mergeChatItems(almost, [item('o1'), item('o2'), item('o3')], 'older')).slice(0, 3)).toEqual(['o2', 'o3', '2'])
  })
})

describe('chat helpers', () => {
  it('tells diff lines apart', () => {
    expect(['@@ -1 +1 @@', '*** 수정: a', '+x', '-y', ' z'].map(diffLineKind)).toEqual(['hunk', 'hunk', 'add', 'remove', 'context'])
  })

  it('finds the latest live agent of a shell', () => {
    const agents = [
      { id: 'a', shellId: 'local:1', active: true },
      { id: 'b', shellId: 'local:2', active: true },
      { id: 'c', shellId: 'local:1', active: true },
      { id: 'd', shellId: 'local:1', active: false }
    ]
    expect(shellAgentOf(agents, 'local:1')?.id).toBe('c')
    expect(shellAgentOf(agents, 'local:3')).toBeUndefined()
  })
})
