import { describe, it, expect } from 'vitest'
import { joinChildPath, nextFolderName } from './sftpFileOps'

describe('joinChildPath', () => {
  it('joins Windows local paths with a backslash', () => {
    expect(joinChildPath('C:\\', 'a', 'local')).toBe('C:\\a')
    expect(joinChildPath('C:\\Users', 'a', 'local')).toBe('C:\\Users\\a')
  })

  it('joins remote paths with a slash', () => {
    expect(joinChildPath('/', 'a', 'remote')).toBe('/a')
    expect(joinChildPath('/home/user', 'a', 'remote')).toBe('/home/user/a')
    expect(joinChildPath('/home/user/', 'a', 'remote')).toBe('/home/user/a')
  })
})

describe('nextFolderName', () => {
  it('uses the base name when free', () => {
    expect(nextFolderName(['a'])).toBe('새 폴더')
  })

  it('numbers the name like Explorer when taken', () => {
    expect(nextFolderName(['새 폴더'])).toBe('새 폴더 (2)')
    expect(nextFolderName(['새 폴더', '새 폴더 (2)'])).toBe('새 폴더 (3)')
  })
})
