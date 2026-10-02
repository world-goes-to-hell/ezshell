import { describe, it, expect } from 'vitest'
import fileEditModule from './fileEdit.js'

const { applyEdit, describeChange, toUnifiedText, countLines } = fileEditModule

describe('applyEdit', () => {
  const text = 'port: 8080\nhost: a\nport_admin: 9090\n'

  it('replaces the only occurrence', () => {
    expect(applyEdit(text, { oldString: 'host: a', newString: 'host: b' })).toEqual({ ok: true, content: 'port: 8080\nhost: b\nport_admin: 9090\n' })
  })

  it('reports a string that is not in the file', () => {
    expect(applyEdit(text, { oldString: 'host: z', newString: 'x' })).toEqual({ ok: false, reason: 'not-found', count: 0 })
  })

  it('refuses to guess when the string occurs more than once', () => {
    expect(applyEdit(text, { oldString: 'port', newString: 'PORT' })).toEqual({ ok: false, reason: 'ambiguous', count: 2 })
  })

  it('replaces every occurrence when asked to', () => {
    expect(applyEdit(text, { oldString: 'port', newString: 'PORT', replaceAll: true })).toEqual({ ok: true, content: 'PORT: 8080\nhost: a\nPORT_admin: 9090\n' })
  })

  it('still reports a missing string with replaceAll', () => {
    expect(applyEdit(text, { oldString: 'nope', newString: 'x', replaceAll: true })).toEqual({ ok: false, reason: 'not-found', count: 0 })
  })

  it('treats replacement patterns in the new text as plain text', () => {
    expect(applyEdit('a=1\n', { oldString: '1', newString: '$& $1 $$ $`' })).toEqual({ ok: true, content: 'a=$& $1 $$ $`\n' })
  })

  it('treats regular expression characters in the old text as plain text', () => {
    expect(applyEdit('a.b\naXb\n', { oldString: 'a.b', newString: 'ok' })).toEqual({ ok: true, content: 'ok\naXb\n' })
  })

  it('can delete text', () => {
    expect(applyEdit('keep\ndrop\n', { oldString: 'drop\n', newString: '' })).toEqual({ ok: true, content: 'keep\n' })
  })

  it('refuses a replacement that would outgrow the limit, without building it', () => {
    const content = 'a'.repeat(1000)
    expect(applyEdit(content, { oldString: 'a', newString: 'x'.repeat(2000), replaceAll: true, maxLength: 100_000 })).toEqual({ ok: false, reason: 'too-large', count: 1000 })
    expect(applyEdit(content, { oldString: 'a', newString: 'xy', replaceAll: true, maxLength: 100_000 }).ok).toBe(true)
    expect(applyEdit('abc', { oldString: 'b', newString: 'B'.repeat(10), maxLength: 12 }).ok).toBe(true)
    expect(applyEdit('abc', { oldString: 'b', newString: 'B'.repeat(11), maxLength: 12 })).toEqual({ ok: false, reason: 'too-large', count: 1 })
  })

  it('says when the file uses CRLF and the text to find does not', () => {
    expect(applyEdit('a\r\nb\r\n', { oldString: 'a\nb', newString: 'x' })).toEqual({ ok: false, reason: 'not-found', count: 0, crlf: true })
  })
})

describe('describeChange', () => {
  it('shows a new file as added lines only', () => {
    const change = describeChange(null, 'one\ntwo\n')
    expect(change).toMatchObject({ added: 2, removed: 0 })
    expect(change.hunks[0].lines).toEqual([{ type: 'add', text: 'one' }, { type: 'add', text: 'two' }])
  })

  it('shows a changed line with its neighbours', () => {
    const change = describeChange('one\ntwo\nthree\n', 'one\n2\nthree\n')
    expect(change).toMatchObject({ added: 1, removed: 1 })
    expect(change.hunks).toEqual([{
      header: '@@ -1,3 +1,3 @@',
      lines: [{ type: 'context', text: 'one' }, { type: 'remove', text: 'two' }, { type: 'add', text: '2' }, { type: 'context', text: 'three' }]
    }])
  })

  it('keeps lines that look like diff markers as text', () => {
    const change = describeChange('-- old\n', '++ new\n@@ x\n')
    expect(change.hunks[0].lines).toEqual([{ type: 'remove', text: '-- old' }, { type: 'add', text: '++ new' }, { type: 'add', text: '@@ x' }])
    expect(change).toMatchObject({ added: 2, removed: 1 })
  })

  it('notes a missing final line break without counting it as a line', () => {
    const change = describeChange('a\n', 'a')
    expect(change.hunks[0].lines.some(line => line.type === 'note')).toBe(true)
    expect(change).toMatchObject({ added: 1, removed: 1 })
  })

  it('has nothing to show when nothing changes', () => {
    expect(describeChange('same\n', 'same\n')).toEqual({ added: 0, removed: 0, hunks: [] })
  })

  describe('when the exact change is too costly to work out', () => {
    const before = 'one\ntwo\nthree\n'
    const after = 'uno\ndos\n'

    it('shows the whole file as replaced, so every line is still on screen', () => {
      const change = describeChange(before, after, { maxEditLength: 1 })
      expect(change).toEqual({
        added: 2,
        removed: 3,
        isWholeFile: true,
        hunks: [{
          header: '@@ -1,3 +1,2 @@',
          lines: [
            { type: 'remove', text: 'one' }, { type: 'remove', text: 'two' }, { type: 'remove', text: 'three' },
            { type: 'add', text: 'uno' }, { type: 'add', text: 'dos' }
          ]
        }]
      })
    })

    it('keeps a last line without a line break', () => {
      const change = describeChange('a\nb', 'c', { maxEditLength: 0 })
      expect(change.hunks[0].lines).toEqual([{ type: 'remove', text: 'a' }, { type: 'remove', text: 'b' }, { type: 'add', text: 'c' }])
    })

    it('gives up within the time limit instead of blocking the app', () => {
      const lines = (tag) => Array.from({ length: 12000 }, (_, i) => `${tag}${i}`).join('\n') + '\n'
      const started = Date.now()
      const change = describeChange(lines('a'), lines('b'), { timeoutMs: 100 })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(change.isWholeFile).toBe(true)
      expect(change).toMatchObject({ added: 12000, removed: 12000 })
    })

    it('still works out an ordinary change exactly', () => {
      expect(describeChange(before, 'one\n2\nthree\n').isWholeFile).toBeUndefined()
    })
  })

  it('counts lines the way an editor does', () => {
    expect(['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n'].map(countLines)).toEqual([0, 1, 1, 2, 2, 1])
  })

  it('separates distant changes into hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const after = before.replace('line 2\n', 'LINE 2\n').replace('line 25\n', 'LINE 25\n')
    expect(describeChange(before, after).hunks).toHaveLength(2)
  })
})

describe('toUnifiedText', () => {
  it('writes the hunks in the usual diff notation', () => {
    const { hunks } = describeChange('one\ntwo\n', 'one\n2\n')
    expect(toUnifiedText(hunks)).toBe('@@ -1,2 +1,2 @@\n one\n-two\n+2\n')
  })

  it('is empty for no hunks', () => {
    expect(toUnifiedText([])).toBe('')
  })
})
