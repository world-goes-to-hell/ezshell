import { describe, it, expect } from 'vitest'
import { droppedFilePaths, dropUploadStatus } from './droppedFiles'

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
