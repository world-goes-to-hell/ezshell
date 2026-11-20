import { describe, expect, it } from 'vitest'
import { readableOutput, readableValue } from './items.js'

// The shape of ezShell's read_inbox answer (contents replaced)
const inbox = JSON.stringify({
  messages: [{
    id: 'c9f0', from: 'user', to: 'codex-2',
    text: '수정 요청입니다.\n\n이거 뭔지 알아봐\n{\n  "url": "https://example.com",\n  "tag": "li"\n}',
    sentAt: 1795133729074, read: false
  }]
})

describe('readableOutput', () => {
  it('turns a JSON answer into an indented outline with the line breaks of its texts', () => {
    expect(readableOutput(inbox)).toBe([
      'messages:',
      '  - id: c9f0',
      '    from: user',
      '    to: codex-2',
      '    text: |',
      '      수정 요청입니다.',
      '',
      '      이거 뭔지 알아봐',
      '      {',
      '        "url": "https://example.com",',
      '        "tag": "li"',
      '      }',
      '    sentAt: 1795133729074',
      '    read: false'
    ].join('\n'))
  })

  it('keeps empty lists and objects, numbers, null and nested lists readable', () => {
    expect(readableOutput('{"a":[],"b":{},"c":null,"d":[1,"two",[3]],"e":true}')).toBe([
      'a: []', 'b: {}', 'c: null', 'd:', '  - 1', '  - two', '  - - 3', 'e: true'
    ].join('\n'))
  })

  it('leaves text that is not a whole JSON object or list as it is', () => {
    for (const text of ['없음', '"just a string"', '42', '{"cut": "off', 'ok {"a":1}', '']) {
      expect(readableOutput(text)).toBe(text)
    }
  })

  it('shows a value nested too deep as JSON on one line', () => {
    let deep = { end: 1 }
    for (let level = 0; level < 30; level++) deep = { next: deep }
    const lines = readableValue(deep).split('\n')
    expect(lines.length).toBeLessThan(25)
    expect(lines.at(-1)).toContain('{"next":')
  })
})
