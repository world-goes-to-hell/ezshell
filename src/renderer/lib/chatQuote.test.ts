import { describe, expect, it } from 'vitest'
import { composeQuotedReply, prepareChatQuote, splitQuotedReply } from './chatQuote'
import { renderChatMarkdown } from './markdownRender'

describe('quoted chat replies', () => {
  it('writes each quote on its own Markdown block and keeps the body last', () => {
    const result = composeQuotedReply(['한 줄\n\n다음 단락', '둘째 인용'], '**그대로인 본문**')
    const text = '> 한 줄\n> \n> 다음 단락\n\n\n> 둘째 인용\n\n**그대로인 본문**'
    expect(result).toEqual({ text })
    const parsed = splitQuotedReply(text)!
    expect(parsed.body).toBe('**그대로인 본문**')
    expect(parsed.quotes).toEqual(['> 한 줄\n> \n> 다음 단락', '> 둘째 인용'])
    const html = renderChatMarkdown(text)
    expect(html.match(/<blockquote>/g)).toHaveLength(2)
    expect(html).toContain('<p>다음 단락</p>')
    expect(splitQuotedReply('일반 메시지\n> 인용')).toBeNull()
  })

  it('preserves separate quote blocks when reading the earlier single-blank-line format', () => {
    expect(splitQuotedReply('> 첫째\n\n> 둘째\n\n답변')).toEqual({ quotes: ['> 첫째', '> 둘째'], body: '답변' })
  })

  it('strips control characters, normalizes newlines and keeps indentation', () => {
    expect(prepareChatQuote(' 앞\x00\x1b\x7f\x85\r\n\t뒤\r끝 ')).toBe('앞\n    뒤\n끝')
  })

  it('fits multiple long blocks within the IPC limit, with the body intact', () => {
    const quote = `처음\n${'🔥 내용\n'.repeat(5000)}마지막`
    const body = '본문'.repeat(7300)
    const result = composeQuotedReply([quote, '짧은 인용', quote], body)
    expect(result).toHaveProperty('text')
    if (!('text' in result)) throw new Error('quote should fit')
    expect(result.text.length).toBeLessThanOrEqual(16_000)
    expect(result.text).not.toMatch(/[\uD800-\uDFFF]/u)
    expect(result.text.match(/처음/g)).toHaveLength(2)
    expect(result.text.match(/마지막/g)).toHaveLength(2)
    expect(result.text).toContain('…')
    expect(result.text).toContain('> 짧은 인용')
    expect(splitQuotedReply(result.text)?.body).toBe(body)
  })

  it('keeps the first five quotes and declines replies without space, a body, or a valid command context', () => {
    expect(composeQuotedReply(['1', '2', '3', '4', '5', '6'], '답변')).toEqual({ text: '> 1\n\n\n> 2\n\n\n> 3\n\n\n> 4\n\n\n> 5\n\n답변' })
    expect(composeQuotedReply(['인용'], ' \n\t')).toEqual({ reason: 'empty' })
    expect(composeQuotedReply(['인용'], '  /model sonnet')).toEqual({ reason: 'command' })
    expect(composeQuotedReply(['인용'], '글'.repeat(15_996))).toEqual({ reason: 'too-long' })
    expect(composeQuotedReply(['길다'], '글'.repeat(15_995))).toEqual({ text: '> …\n\n' + '글'.repeat(15_995) })
    expect(composeQuotedReply(['첫째', '둘째'], '글'.repeat(15_989))).toEqual({ text: '> …\n\n\n> …\n\n' + '글'.repeat(15_989) })
  })
})
