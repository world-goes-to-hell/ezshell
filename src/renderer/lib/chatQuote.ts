import { isSlashCommand } from './slashCommands'

export const CHAT_QUOTE_LIMIT = 5
const MAX_CHAT_TEXT = 16_000 // MAX_TEXT in src/agentChat/ipc.js, measured in UTF-16 code units.
const QUOTE_SEPARATOR = '\n\n\n'
const BODY_SEPARATOR = '\n\n'

function clipQuote(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.ceil((limit - 1) * 2 / 3)
  const tail = limit - 1 - head
  const before = text.slice(0, head).replace(/[\uD800-\uDBFF]$/, '')
  const after = tail ? text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, '') : ''
  return `${before}…${after}`
}

export function prepareChatQuote(text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trim()
  return clipQuote(clean, MAX_CHAT_TEXT)
}

const markdownQuote = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n')

function fitMarkdownQuote(text: string, budget: number): string {
  const full = markdownQuote(text)
  if (full.length <= budget) return full
  let low = 2
  let high = Math.min(text.length - 1, budget - 2)
  let result = '> …'
  while (low <= high) {
    const size = Math.floor((low + high) / 2)
    const candidate = markdownQuote(clipQuote(text, size))
    if (candidate.length <= budget) {
      result = candidate
      low = size + 1
    } else {
      high = size - 1
    }
  }
  return result
}

type QuotedReply = { text: string } | { reason: 'empty' | 'command' | 'too-long' }

export function composeQuotedReply(quotes: readonly string[], body: string): QuotedReply {
  const text = body.trim()
  if (!text) return { reason: 'empty' }
  if (isSlashCommand(text)) return { reason: 'command' }

  const prepared = quotes.slice(0, CHAT_QUOTE_LIMIT).map(prepareChatQuote).filter(Boolean)
  const separators = prepared.length ? (prepared.length - 1) * QUOTE_SEPARATOR.length + BODY_SEPARATOR.length : 0
  let budget = MAX_CHAT_TEXT - text.length - separators
  if (budget < prepared.length * 3) return { reason: 'too-long' }

  // Budget the shorter blocks first so their unused space stays available to longer quotes.
  const order = prepared.map((quote, index) => ({ index, length: markdownQuote(quote).length }))
    .sort((a, b) => a.length - b.length)
  const blocks = prepared.slice()
  for (const [position, { index }] of order.entries()) {
    const block = fitMarkdownQuote(prepared[index], Math.floor(budget / (order.length - position)))
    blocks[index] = block
    budget -= block.length
  }
  return { text: blocks.length ? blocks.join(QUOTE_SEPARATOR) + BODY_SEPARATOR + text : text }
}

export function splitQuotedReply(text: string): { quotes: string[]; body: string } | null {
  if (!text.startsWith('> ')) return null
  const lines = text.split('\n')
  const isQuote = (line: string | undefined) => line === '>' || line?.startsWith('> ')
  const quotes: string[] = []
  let end = 0
  while (isQuote(lines[end])) {
    const start = end
    while (isQuote(lines[end])) end++
    if (lines[end] !== '') return quotes.length ? { quotes, body: lines.slice(start).join('\n') } : null
    quotes.push(lines.slice(start, end).join('\n'))
    while (lines[end] === '') end++
  }
  return end < lines.length ? { quotes, body: lines.slice(end).join('\n') } : null
}
