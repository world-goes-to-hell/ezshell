import { describe, it, expect } from 'vitest'
import { droppedFilePaths, dropUploadStatus, terminalDropText, CHAT_IMAGE_FILE } from './droppedFiles'

describe('droppedFilePaths', () => {
  it('uses file.path where the runtime still has it', () => {
    const result = droppedFilePaths([{ name: 'a.txt', path: 'C:/work/a.txt' } as never])
    expect(result).toEqual({ paths: [{ name: 'a.txt', localPath: 'C:/work/a.txt' }], missing: 0 })
  })

  it('asks the preload when file.path is gone', () => {
    const result = droppedFilePaths([{ name: 'a.txt' }, { name: 'b.txt' }], file => `D:/in/${file.name}`)
    expect(result.paths.map(item => item.localPath)).toEqual(['D:/in/a.txt', 'D:/in/b.txt'])
    expect(result.missing).toBe(0)
  })

  it('counts files nobody can place, and survives a throwing lookup', () => {
    expect(droppedFilePaths([{ name: 'a.txt' }])).toEqual({ paths: [], missing: 1 })
    expect(droppedFilePaths([{ name: 'a.txt' }], () => '')).toEqual({ paths: [], missing: 1 })
    expect(droppedFilePaths([{ name: 'a.txt' }], () => { throw new Error('x') })).toEqual({ paths: [], missing: 1 })
    const mixed = droppedFilePaths([{ name: 'a.txt', path: 'C:/a.txt' } as never, { name: 'b.txt' }], () => '')
    expect(mixed.paths).toHaveLength(1)
    expect(mixed.missing).toBe(1)
  })
})

describe('dropUploadStatus', () => {
  it('never reports files that were not sent as done', () => {
    expect(dropUploadStatus(0, 2)).toContain('실패')
    expect(dropUploadStatus(2, 1)).toBe('2개 파일 업로드 시작 · 1개는 위치를 알 수 없어 제외')
    expect(dropUploadStatus(3, 0)).toBe('3개 파일 업로드 시작')
  })
})

describe('terminalDropText', () => {
  it('pastes a plain path as it is, with a space to type on after it', () => {
    expect(terminalDropText(['C:\\work\\shot.png'])).toBe('C:\\work\\shot.png ')
  })

  it('quotes a path the shell would split or read, as a pasted screenshot path is', () => {
    expect(terminalDropText(['C:\\My Files\\a.txt'])).toBe("'C:\\My Files\\a.txt' ")
    expect(terminalDropText(['D:\\R&D\\b.txt'])).toBe("'D:\\R&D\\b.txt' ")
    expect(terminalDropText(['D:\\x (1)\\c.txt'])).toBe("'D:\\x (1)\\c.txt' ")
    expect(terminalDropText(["D:\\it's\\d.txt"])).toBe("'D:\\it''s\\d.txt' ")
    expect(terminalDropText(["/home/me/it's here.txt"], 'posix')).toBe("'/home/me/it'\\''s here.txt' ")
  })

  it('puts several files on one line, separated by spaces', () => {
    expect(terminalDropText(['C:\\a.png', 'C:\\b c.png'])).toBe("C:\\a.png 'C:\\b c.png' ")
  })

  it('pastes nothing for no path, and leaves out a path with a line break that would press Enter', () => {
    expect(terminalDropText([])).toBe('')
    expect(terminalDropText(['', 'C:\\a\r\nb.txt'])).toBe('')
    expect(terminalDropText(['C:\\a\nb.txt', 'C:\\ok.txt'])).toBe('C:\\ok.txt ')
  })
})

describe('CHAT_IMAGE_FILE', () => {
  it('takes the pictures the chat can attach', () => {
    expect(['a.png', 'B.JPG', 'c.jpeg'].every(name => CHAT_IMAGE_FILE.test(name))).toBe(true)
    expect(['d.gif', 'e.txt', 'png'].some(name => CHAT_IMAGE_FILE.test(name))).toBe(false)
  })
})

