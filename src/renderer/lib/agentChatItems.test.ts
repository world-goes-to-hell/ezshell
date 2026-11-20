import { describe, expect, it } from 'vitest'
import type { AgentChatItem } from '../types'
import { MAX_CHAT_ITEMS, diffLineKind, mergeChatItems, reconcileChatEchoes, shellAgentOf } from './agentChatItems'

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

describe('reconciling messages sent in the chat', () => {
  const user = (id: string, time: number, text = '안녕'): AgentChatItem => ({ id, kind: 'user', time, text })

  it('keeps an echo on first load alongside an older identical prompt, then replaces only the new copy', () => {
    const echo = { id: 'outgoing:1', text: '안녕', time: 10000, hasImage: false }
    const local = user(echo.id, echo.time)
    const old = user('old', 1000)
    const initial = reconcileChatEchoes([local], [old], 'reset', [echo])
    expect(ids(initial.items)).toEqual(['old', echo.id])
    const logged = user('latest', 10100)
    const confirmed = reconcileChatEchoes(initial.items, [logged], 'append', initial.echoes)
    expect(ids(confirmed.items)).toEqual(['old', logged.id])
    expect(confirmed.recorded.get(echo.id)).toBe(logged)
    expect(confirmed.echoes).toEqual([])
  })

  it('matches repeated messages separately and preserves the transcript turn order', () => {
    const echoes = [
      { id: 'outgoing:1', text: '안녕', time: 10000, hasImage: false },
      { id: 'outgoing:2', text: '안녕', time: 12000, hasImage: false }
    ]
    const initial = echoes.map(echo => user(echo.id, echo.time))
    const result = reconcileChatEchoes(initial, [user('first', 10100), item('reply'), user('second', 12200)], 'append', echoes)
    expect(ids(result.items)).toEqual(['first', 'reply', 'second'])
    expect([...result.recorded.keys()]).toEqual(echoes.map(echo => echo.id))
  })

  it('keeps a slash command sent before a look at the terminal until Claude records it when done', () => {
    // Back from the terminal: the chat reopens with the kept echo; the transcript has the conversation only
    const echo = { id: 'outgoing:compact', text: '/compact', time: 20000, hasImage: false }
    const reopened = reconcileChatEchoes([user(echo.id, echo.time, '/compact')], [user('u1', 1000, '찾아봐줘'), item('a1')], 'reset', [echo])
    expect(ids(reopened.items)).toEqual(['u1', 'a1', echo.id])
    // Minutes later the command line is written, after the compact
    const done = reconcileChatEchoes(reopened.items, [item('notice'), user('cmd', 140000, '/compact')], 'append', reopened.echoes)
    expect(ids(done.items)).toEqual(['u1', 'a1', 'notice', 'cmd'])
    expect(done.echoes).toEqual([])
  })

  it('reconciles the first transcript frame containing an image-only send', () => {
    const echo = { id: 'outgoing:image', text: '', time: 10000, hasImage: true }
    const prompt = user('image', 10001, '첨부 이미지를 열어 확인해 주세요.\nC:/sample.png')
    const result = reconcileChatEchoes([user(echo.id, echo.time, '스크린샷 첨부')], [prompt], 'reset', [echo])
    expect(ids(result.items)).toEqual(['image'])
    expect(result.echoes).toEqual([])
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
