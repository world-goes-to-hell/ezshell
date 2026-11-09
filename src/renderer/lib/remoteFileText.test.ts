import { describe, it, expect } from 'vitest'
import { canEditFile, canFollowFile, detectLineEnding, fileNameOf, fromEditorText, toEditorText } from './remoteFileText'

describe('following a server file as a log', () => {
  it('offers it for anything shown as text, not for images and PDFs', () => {
    expect(canFollowFile('app.log')).toBe(true)
    expect(canFollowFile('catalina.out')).toBe(true)
    expect(canFollowFile('syslog')).toBe(true)
    expect(canFollowFile('.bash_history')).toBe(true)
    expect(canFollowFile('logo.PNG')).toBe(false)
    expect(canFollowFile('report.pdf')).toBe(false)
  })
})

describe('line endings of a server file', () => {
  it('tells LF, CRLF, mixed and none apart', () => {
    expect(detectLineEnding('a\nb\n')).toBe('lf')
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf')
    expect(detectLineEnding('a\r\nb\n')).toBe('mixed')
    expect(detectLineEnding('a\rb')).toBe('mixed')
    expect(detectLineEnding('one line')).toBe('none')
  })

  it('gives back a CRLF file exactly as it was opened', () => {
    const original = 'a=1\r\nb=2\r\n'
    expect(fromEditorText(toEditorText(original), detectLineEnding(original))).toBe(original)
  })

  it('saves new lines of a CRLF file as CRLF', () => {
    expect(fromEditorText('a\nb\nc', 'crlf')).toBe('a\r\nb\r\nc')
  })

  it('saves a mixed file with LF', () => {
    const original = 'a\r\nb\n'
    expect(fromEditorText(toEditorText(original), detectLineEnding(original))).toBe('a\nb\n')
  })
})

describe('labels', () => {
  it('takes the file name from a path', () => {
    expect(fileNameOf('/etc/nginx/nginx.conf')).toBe('nginx.conf')
    expect(fileNameOf('/')).toBe('/')
  })

  it('offers editing for files within the limit only', () => {
    expect(canEditFile({ size: 10 }, 100)).toBe(true)
    expect(canEditFile({ size: 101 }, 100)).toBe(false)
    expect(canEditFile({ isDirectory: true, size: 1 }, 100)).toBe(false)
  })
})

describe('server file path', () => {
  it('joins a folder and a name', async () => {
    const { joinRemotePath } = await import('./remoteFileOpen')
    expect(joinRemotePath('/var/log', 'app.log')).toBe('/var/log/app.log')
    expect(joinRemotePath('/', 'etc')).toBe('/etc')
    expect(joinRemotePath('/srv/', 'a b.txt')).toBe('/srv/a b.txt')
  })
})
