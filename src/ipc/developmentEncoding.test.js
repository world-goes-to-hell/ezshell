import { describe, expect, it } from 'vitest'
import { createLogDecoder, javaLogOptions, windowsConsoleEncoding } from './developmentEncoding.js'

describe('development PTY encodings', () => {
  const korean = Buffer.from('c7d1b1db', 'hex') // 한글 in Windows-949

  it('holds split UTF-8 characters and preserves an intentional replacement character', () => {
    const decoder = createLogDecoder('auto')
    const line = Buffer.from('정보 \ufffd\r\n')
    expect(decoder.write(line.subarray(0, 2))).toBe('')
    expect(decoder.write(line.subarray(2))).toBe('정보 \ufffd\r\n')
    expect(decoder.finish()).toBe('')
  })

  it('switches to MS949 after repeated invalid UTF-8 bytes and uses it for following lines', () => {
    const decoder = createLogDecoder('auto')
    expect(decoder.write(Buffer.from('INFO '))).toBe('INFO ')
    expect(decoder.write(korean.subarray(0, 2))).toBe('')
    expect(decoder.write(korean.subarray(2))).toBe('')
    expect(decoder.write(Buffer.from('\r\n'))).toBe('한글\r\n')
    expect(decoder.write(Buffer.concat([korean, Buffer.from(' OK')]))).toBe('한글 OK')
  })

  it('decodes explicit MS949 without a UTF-8 probe and preserves decoded ConPTY strings', () => {
    const decoder = createLogDecoder('ms949')
    expect(decoder.write(korean.subarray(0, 1))).toBe('')
    expect(decoder.write(korean.subarray(1))).toBe('한글')
    expect(decoder.write('이미 해석한 출력')).toBe('이미 해석한 출력')
    expect(decoder.finish()).toBe('')
    expect(windowsConsoleEncoding('ms949')).toContain('GetEncoding(949)')
  })

  it('uses version-appropriate Java standard output and error properties', () => {
    expect(javaLogOptions('auto', 17)).toEqual([])
    expect(javaLogOptions('ms949', 17)).toEqual(['-Dsun.stdout.encoding=MS949', '-Dsun.stderr.encoding=MS949'])
    expect(javaLogOptions('utf-8', 21)).toEqual(['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'])
    expect(javaLogOptions('ms949', null)).toEqual(['-Dstdout.encoding=MS949', '-Dstderr.encoding=MS949', '-Dsun.stdout.encoding=MS949', '-Dsun.stderr.encoding=MS949'])
  })
})
