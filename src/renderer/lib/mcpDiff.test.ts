import { describe, it, expect } from 'vitest'
import type { McpDiffHunk } from '../types'
import { revealDiff } from './mcpDiff'

const hunk = (...lines: McpDiffHunk['lines']): McpDiffHunk[] => [{ header: '@@ -1,1 +1,1 @@', lines }]

describe('revealDiff', () => {
  it('leaves ordinary text as it is, tabs included', () => {
    const input = hunk({ type: 'remove', text: 'port:\t8080' }, { type: 'add', text: '포트: 9090' })
    expect(revealDiff(input)).toEqual({ hunks: input, hasHidden: false })
  })

  it('makes invisible and direction-changing characters visible, and says so', () => {
    const { hunks, hasHidden } = revealDiff(hunk({ type: 'add', text: 'rm ‮txt.exe​' }))
    expect(hunks[0].lines[0].text).toBe('rm ⟨U+202E⟩txt.exe⟨U+200B⟩')
    expect(hasHidden).toBe(true)
  })

  it('marks a CRLF line end without calling it hidden', () => {
    const { hunks, hasHidden } = revealDiff(hunk({ type: 'remove', text: 'a\r' }, { type: 'add', text: 'a' }))
    expect(hunks[0].lines.map(line => line.text)).toEqual(['a␍', 'a'])
    expect(hasHidden).toBe(false)
  })

  it('still reveals a carriage return in the middle of a line', () => {
    const { hunks, hasHidden } = revealDiff(hunk({ type: 'add', text: 'safe\rrm -rf /\r' }))
    expect(hunks[0].lines[0].text).toBe('safe⟨U+000D⟩rm -rf /␍')
    expect(hasHidden).toBe(true)
  })

  it('words the missing final line break in Korean', () => {
    const { hunks } = revealDiff(hunk({ type: 'note', text: ' No newline at end of file' }))
    expect(hunks[0].lines[0]).toEqual({ type: 'note', text: '(파일 끝에 줄바꿈 없음)' })
  })
})
