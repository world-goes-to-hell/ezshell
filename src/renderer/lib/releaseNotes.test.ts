import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { compareVersions, notesFromFiles, notesToShow, parseMarkdown, MAX_VERSIONS_SHOWN } from './releaseNotes'

describe('compareVersions', () => {
  it('orders by number, not text', () => {
    expect(compareVersions('2.14.0', '2.9.1')).toBeGreaterThan(0)
    expect(compareVersions('2.9.1', '2.14.0')).toBeLessThan(0)
    expect(compareVersions('2.14.0', '2.14.0')).toBe(0)
    expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0)
  })
})

describe('notesFromFiles', () => {
  it('keys notes by the version in the file name and ignores other files', () => {
    const notes = notesFromFiles({
      '../../../release-notes/2.14.0.md': 'a',
      '../../../release-notes/2.13.0.md': 'b',
      '../../../release-notes/README.md': 'c',
      '../../../release-notes/2.15.0-beta.md': 'd'
    })
    expect(notes).toEqual({ '2.14.0': 'a', '2.13.0': 'b' })
  })
})

describe('notesToShow', () => {
  const available = { '2.12.0': 'n12', '2.13.0': 'n13', '2.14.0': 'n14', '2.15.0': 'n15' }

  it('shows every version after the last one seen, up to the current one, newest first', () => {
    expect(notesToShow({ previous: '2.12.0', current: '2.14.0', existingUser: true, available })).toEqual([
      { version: '2.14.0', markdown: 'n14' },
      { version: '2.13.0', markdown: 'n13' }
    ])
  })

  it('shows nothing when the version did not go up', () => {
    expect(notesToShow({ previous: '2.14.0', current: '2.14.0', existingUser: true, available })).toEqual([])
    expect(notesToShow({ previous: '2.15.0', current: '2.14.0', existingUser: true, available })).toEqual([])
  })

  it('shows the current version to an existing user with no record (first version with this feature)', () => {
    expect(notesToShow({ previous: null, current: '2.14.0', existingUser: true, available })).toEqual([
      { version: '2.14.0', markdown: 'n14' }
    ])
  })

  it('shows nothing on a fresh install', () => {
    expect(notesToShow({ previous: null, current: '2.14.0', existingUser: false, available })).toEqual([])
  })

  it('skips versions without notes and caps the list', () => {
    expect(notesToShow({ previous: '2.13.0', current: '2.14.0', existingUser: true, available: {} })).toEqual([])
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`1.${i}.0`, `n${i}`]))
    const shown = notesToShow({ previous: '0.1.0', current: '1.29.0', existingUser: true, available: many })
    expect(shown).toHaveLength(MAX_VERSIONS_SHOWN)
    expect(shown[0].version).toBe('1.29.0')
  })
})

describe('parseMarkdown', () => {
  it('splits headings, lists and paragraphs', () => {
    const blocks = parseMarkdown('## 새 기능\n\n### 터미널\n- 첫째 `ls` 항목\n- **굵게** 둘째\n  - 안쪽\n\n문단 한 줄\n이어지는 줄\n\n다음 문단')
    expect(blocks).toEqual([
      { type: 'heading', level: 2, inlines: [{ type: 'text', text: '새 기능' }] },
      { type: 'heading', level: 3, inlines: [{ type: 'text', text: '터미널' }] },
      {
        type: 'list',
        items: [
          { depth: 0, inlines: [{ type: 'text', text: '첫째 ' }, { type: 'code', text: 'ls' }, { type: 'text', text: ' 항목' }] },
          { depth: 0, inlines: [{ type: 'bold', text: '굵게' }, { type: 'text', text: ' 둘째' }] },
          { depth: 1, inlines: [{ type: 'text', text: '안쪽' }] }
        ]
      },
      { type: 'paragraph', inlines: [{ type: 'text', text: '문단 한 줄 이어지는 줄' }] },
      { type: 'paragraph', inlines: [{ type: 'text', text: '다음 문단' }] }
    ])
  })

  it('treats a top-level heading like a section heading and leaves unclosed marks as text', () => {
    expect(parseMarkdown('# 제목')).toEqual([{ type: 'heading', level: 2, inlines: [{ type: 'text', text: '제목' }] }])
    expect(parseMarkdown('- a `b')).toEqual([{ type: 'list', items: [{ depth: 0, inlines: [{ type: 'text', text: 'a `b' }] }] }])
    expect(parseMarkdown('**x')).toEqual([{ type: 'paragraph', inlines: [{ type: 'text', text: '**x' }] }])
  })

  it('accepts * bullets and CRLF line endings', () => {
    expect(parseMarkdown('* a\r\n* b')).toEqual([{ type: 'list', items: [
      { depth: 0, inlines: [{ type: 'text', text: 'a' }] },
      { depth: 0, inlines: [{ type: 'text', text: 'b' }] }
    ] }])
  })
})

describe('release notes for this version', () => {
  it('exist for the version in package.json (write release-notes/<version>.md before releasing)', () => {
    const root = path.resolve(__dirname, '../../..')
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(fs.existsSync(path.join(root, 'release-notes', `${version}.md`))).toBe(true)
  })
})
