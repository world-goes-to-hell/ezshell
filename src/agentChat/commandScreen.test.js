import { describe, expect, it } from 'vitest'
import { printedLines, watchCommand } from './commandScreen.js'

// Codex's screen: history rows, then the composer and its footer
const screen = (history, composer = '› ') => [...history, '', composer, '', '  ⏎ send   ⌃J newline']

describe('what a slash command printed on Codex\'s screen', () => {
  it('takes the rows that came above the composer, the history scrolled up to make room', () => {
    const before = screen(['• 이전 답변', '  둘째 줄'])
    const after = screen(['  둘째 줄', '› /status', '', '╭──────────╮', '│ Model: x │', '╰──────────╯'])
    expect(printedLines(before, after, '/status')).toBe('╭──────────╮\n│ Model: x │\n╰──────────╯')
  })

  it('reads output on a screen that did not scroll, and nothing when nothing came or it was redrawn', () => {
    expect(printedLines(screen([]), screen(['/diff', 'diff --git a/x b/x']), '/diff')).toBe('diff --git a/x b/x')
    expect(printedLines(screen(['a', 'b']), screen(['a', 'b']), '/new')).toBeNull()
    expect(printedLines(screen(['a', 'b']), screen(['전혀 다른', '화면']), '/new')).toBe('전혀 다른\n화면')
  })

  it('clips a long output', () => {
    const rows = Array.from({ length: 120 }, (_, index) => `줄 ${index}`)
    const text = printedLines(screen([]), screen(rows), '/diff')
    expect(text.split('\n')).toHaveLength(81)
    expect(text.endsWith('\n…')).toBe(true)
  })
})

describe('watching the screen after a slash command', () => {
  function run(frames, { kind = 'codex', before = screen([]) } = {}) {
    let time = 0
    let index = 0
    return watchCommand({
      kind, before, command: '/status',
      read: () => frames[Math.min(index++, frames.length - 1)],
      sleep: async ms => { time += ms },
      now: () => time
    })
  }
  const shown = (composer, lines = screen([]), approval = false) => ({ composer, lines, approval })

  it('ran: the empty composer came back and stayed (Codex: with what it printed)', async () => {
    const after = screen(['/status', 'Model: x'])
    expect(await run([shown('draft'), shown('empty', after)])).toEqual({ state: 'done', output: 'Model: x' })
    expect(await run([shown('empty', after)], { kind: 'claude' })).toEqual({ state: 'done' })
  })

  it('opened a screen of its own: no composer for a while', async () => {
    expect(await run([shown('draft'), shown(null, ['Settings', '  Theme  dark'])])).toEqual({ state: 'screen' })
  })

  it('asks a numbered question: the chat\'s card takes it', async () => {
    expect(await run([shown(null, ['1. a', '2. b'], true)])).toEqual({ state: 'approval' })
  })

  it('the agent went away', async () => {
    expect(await run([null])).toEqual({ state: 'gone' })
  })
})
