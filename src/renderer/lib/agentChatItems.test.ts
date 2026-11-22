import { describe, expect, it } from 'vitest'
import type { AgentChatItem } from '../types'
import { MAX_CHAT_ITEMS, diffLineKind, echoOutputId, mergeChatItems, readSubagentActivity, reconcileChatEchoes, shellAgentOf, subagentDisplayText } from './agentChatItems'

const item = (id: string, text = id): AgentChatItem => ({ id, kind: 'assistant', time: null, text })
const ids = (items: AgentChatItem[]) => items.map(entry => entry.id)

describe('subagent previews after a renderer update', () => {
  it('hides encrypted Codex text still sent by an older main process, including clipped tokens', () => {
    const token = 'gAAAA' + 'b0_q-2R'.repeat(20)
    expect(subagentDisplayText(`${token}==`, 'codex')).toBe('')
    expect(subagentDisplayText(`${token}\n…`, 'codex')).toBe('')
    expect(subagentDisplayText('검색 결과를 정리했습니다', 'codex')).toBe('검색 결과를 정리했습니다')
    expect(subagentDisplayText(token, 'claude')).toBe(token)
  })

  it('distinguishes a missing IPC handler from an empty or failed activity read', async () => {
    const read = (load?: typeof window.electronAPI.agentChatSubagentPreview) => readSubagentActivity(load, 'local:1', 'child')
    expect(await read()).toBe('restart-required')
    expect(await read(async () => { throw new Error("Error: No handler registered for 'agent-chat-subagent-preview'") })).toBe('restart-required')
    expect(await read(async () => { throw new Error('Read failed') })).toBe('unavailable')
    expect(await read(async () => [])).toEqual([])
  })
})

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

  it('keeps a Codex slash command and what it printed together, through new frames and a reopened view', () => {
    // Codex records no slash command: the line and its output (read off the screen) stay as sent
    const echo = { id: 'outgoing:status', text: '/status', time: 20000, hasImage: false }
    const line: AgentChatItem = { ...user(echo.id, echo.time, '/status'), commandState: 'done' }
    const output: AgentChatItem = { id: echoOutputId(echo.id), kind: 'output', time: echo.time, text: 'Model: x' }
    const shown = [user('u1', 1000, '찾아봐줘'), line, output]
    const appended = reconcileChatEchoes(shown, [{ ...item('a2'), time: 30000 }], 'append', [echo])
    expect(ids(appended.items)).toEqual(['u1', echo.id, output.id, 'a2'])
    const reopened = reconcileChatEchoes([line, output], [user('u1', 1000, '찾아봐줘'), { ...item('a2'), time: 30000 }], 'reset', [echo])
    expect(ids(reopened.items)).toEqual(['u1', echo.id, output.id, 'a2'])
    expect(reopened.echoes).toEqual([echo])
  })

  it.each(['', '첫 줄\n\n둘째 줄'])('reconciles stored image references with body %j', body => {
    const echo = { id: 'outgoing:image', text: body, time: 10000, hasImage: true }
    const path = 'C:\\tmp\\ezshell-clipboard-AbC123\\d74b21e8-46bd-4259-8345-d9a8c43b88b2.png'
    for (const prefix of ['', '첨부 이미지를 열어 확인해 주세요.\n']) {
      const prompt = user('image', 10001, prefix + [path, body].filter(Boolean).join('\n\n'))
      const result = reconcileChatEchoes([user(echo.id, echo.time, body || '스크린샷 첨부')], [prompt], 'reset', [echo])
      expect(ids(result.items)).toEqual(['image'])
      expect(result.echoes).toEqual([])
    }
  })

  it('reconciles native image messages with and without a text body', () => {
    for (const body of ['', '이미지전송 테스트\n\n두 이미지를 비교해 줘.']) {
      const echo = { id: 'outgoing:image', text: body, time: 10000, hasImage: true }
      const local = user(echo.id, echo.time, body || '스크린샷 첨부')
      const transcripts = [
        user('image', 10001, ['[Image #1] [Image #2]', body].filter(Boolean).join('\n')),
        user('image', 10001, ['[Image #1] [Image #2]첨부 이미지를 열어 확인해 주세요.', body].filter(Boolean).join('\n')),
        { ...user('image', 10001, body), hasImage: true }
      ]
      for (const transcript of transcripts) {
        const result = reconcileChatEchoes([local], [transcript], 'append', [echo])
        expect(ids(result.items)).toEqual(['image'])
        expect(result.echoes).toEqual([])
      }
    }
  })

  it('keeps a pending image send alongside identical text without an attachment', () => {
    const echo = { id: 'outgoing:image', text: '같은 내용', time: 10000, hasImage: true }
    const result = reconcileChatEchoes([user(echo.id, echo.time, echo.text)], [user('plain', 10001, echo.text)], 'append', [echo])
    expect(ids(result.items)).toEqual([echo.id, 'plain'])
    expect(result.echoes).toEqual([echo])
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
