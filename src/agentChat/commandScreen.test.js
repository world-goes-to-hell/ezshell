import { describe, expect, it } from 'vitest'
import { readCommandOutput, watchCommand } from './commandScreen.js'

// Codex's screen: history rows, then the composer and its footer
const screen = (history, composer = '› ', wraps = []) => ({
  lines: [...history, '', composer, '', '  ⏎ send   ⌃J newline'], wraps
})
const printedLines = (before, after, command) => readCommandOutput(before, after, command)?.output ?? null

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

  it('starts at the echo even when Codex redraws earlier work and trims the empty composer', () => {
    const before = screen(['• An earlier answer', '  local bridge after the MCP transport closed.'])
    const after = screen([
      '  local bridge after the MCP transport', '  closed.',
      'Worked for 8m 0s • 11:51 PM', '• Context compacted · 36s', 'Worked for 36s',
      '› /mcp', '', '🔌  MCP Tools', '  • codex_apps: connected (108 tools)'
    ], '›')
    expect(printedLines(before, after, '/mcp')).toBe('🔌  MCP Tools\n  • codex_apps: connected (108 tools)')
  })

  it('ignores a redrawn prior echo but captures a repeated command that appears after it', () => {
    const prior = ['› /status', 'Model: x']
    const before = screen(['old answer', ...prior])
    expect(printedLines(before, screen(['reflowed answer', ...prior]), '/status')).toBeNull()
    expect(printedLines(before, screen(['reflowed answer', ...prior, '• Context compacted']), '/status')).toBeNull()
    expect(printedLines(before, screen([...prior, '', ...prior]), '/status')).toBe('Model: x')
    expect(printedLines(before, screen(['reflowed answer', ...prior, '', '/status', 'Model: x']), '/status')).toBe('Model: x')
  })

  it('accepts an unadorned echo with arguments after redrawn history', () => {
    const after = screen(['• Context compacted', '  /mcp verbose', '🔌  MCP Tools', '  • Tools: one'])
    expect(printedLines(screen(['earlier answer']), after, '/mcp verbose')).toBe('🔌  MCP Tools\n  • Tools: one')
  })

  it('joins a soft-wrapped echo, including the space at the right edge', () => {
    const after = screen(['› /mcp ', 'verbose', '', 'MCP Tools', '  • Tools: one'], '›',
      [false, true])
    expect(readCommandOutput(screen(['older answer']), after, '/mcp verbose')).toEqual({
      output: 'MCP Tools\n  • Tools: one', echoVerified: true
    })
  })

  it('keeps the visible output of /status and /diff after their echoes scroll away', () => {
    expect(readCommandOutput(screen(['previous answer']), screen(['Model: x', 'Context: 14000']), '/status'))
      .toEqual({ output: 'Model: x\nContext: 14000', echoVerified: false })
    expect(readCommandOutput(screen(['previous answer', 'last row']), screen(['last row', '+ added', '- removed']), '/diff'))
      .toEqual({ output: '+ added\n- removed', echoVerified: false })
    expect(readCommandOutput(screen([]), screen(['remaining text'], '›', [true]), '/diff'))
      .toEqual({ output: 'remaining text', echoVerified: false })
  })

  it('does not report an earlier result whose echo and body reflow', () => {
    const before = screen(['previous answer', '› /mcp', 'MCP Tools', '  • one: authentication required (0 tools)'])
    const after = screen(['redrawn answer', '› /m', 'cp', 'MCP Tools', '  • one: authentication', ' required (0 tools)'], '›',
      [false, false, true, false, false, true])
    expect(readCommandOutput(before, after, '/mcp')).toBeNull()
  })

  it('does not report an unchanged result when a redraw restores its previously hidden echo', () => {
    const body = ['MCP Tools', '  • one: authentication required (0 tools)']
    expect(readCommandOutput(screen(body), screen(['› /mcp', '', ...body]), '/mcp')).toBeNull()
  })

  it('leaves a matching old echo unverified when a redraw also changes its body', () => {
    const before = screen(['previous answer', '› /mcp', 'MCP Tools', '  • one: connected (1 tool)'])
    const after = screen(['redrawn answer', '› /mcp', 'MCP Tools', '  • one: authentication required (0 tools)'])
    expect(readCommandOutput(before, after, '/mcp')).toMatchObject({ echoVerified: false })
  })

  it('clips a long output', () => {
    const rows = Array.from({ length: 120 }, (_, index) => `줄 ${index}`)
    const text = printedLines(screen([]), screen(['/diff', ...rows]), '/diff')
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
  const shown = (composer, snapshot = screen([]), approval = false) => ({
    composer, ...(Array.isArray(snapshot) ? { lines: snapshot } : snapshot), approval
  })

  it('ran: the empty composer came back and stayed (Codex: with what it printed)', async () => {
    const after = screen(['› /status', 'Model: x'])
    expect(await run([shown('draft'), shown('empty', after)])).toEqual({ state: 'done', output: 'Model: x', echoVerified: true })
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
