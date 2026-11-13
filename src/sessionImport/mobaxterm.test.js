import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { readSessionValue, readMobaText, readMobaFile } = require('./mobaxterm.js')

/** An SSH value with the fields at their positions (others empty) */
function ssh(fields) {
  const parts = Array.from({ length: 30 }, (_, i) => fields[i] ?? '')
  parts[0] = '0'
  return ` #109#${parts.join('%')}#MobaFont%10%0%0%-1%15#0# #-1`
}

describe('mobaxterm', () => {
  it('reads the community example line', () => {
    expect(readSessionValue('#109#0%192.168.137.40%22%deck%%0%0%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1%')).toMatchObject({
      host: '192.168.137.40', port: '22', username: 'deck', privateKeyPath: '', jump: null
    })
  })

  it('reads the key file, the first gateway hop and an SSH proxy', () => {
    expect(readSessionValue(ssh({ 1: 'h', 2: '2222', 3: 'u', 14: '_CurrentDrive_:\\keys\\id.ppk', 8: 'gw1__PIPE__gw2', 9: '22__PIPE__22', 10: 'g1__PIPE__g2' }))).toMatchObject({
      host: 'h', port: '2222', username: 'u', privateKeyPath: 'C:\\keys\\id.ppk', jump: { host: 'gw1', port: '22', username: 'g1' }
    })
    expect(readSessionValue(ssh({ 1: 'h', 19: '6', 20: 'proxy', 21: '2200', 22: 'p' })).jump).toEqual({ host: 'proxy', port: '2200', username: 'p' })
    expect(readSessionValue(ssh({ 1: 'h', 3: '<default>' })).username).toBe('')
  })

  it('skips other session types', () => {
    expect(readSessionValue('#91#4%rdp.example.com%3389%').skip).toBeTruthy()
    expect(readSessionValue('garbage').skip).toBeTruthy()
  })

  it('turns Bookmarks sections into folders, nested by backslash', () => {
    const text = [
      '[Bookmarks]', 'SubRep=', 'ImgNum=42', `top=${ssh({ 1: 'top.example.com' })}`,
      '[Bookmarks_1]', 'SubRep=운영', 'ImgNum=41', `web=${ssh({ 1: 'web.example.com', 3: 'root' })}`,
      '[Bookmarks_2]', 'SubRep=운영\\DB', 'ImgNum=41', `db=${ssh({ 1: 'db.example.com' })}`, `rdp=#91#4%x%3389%`,
      '[Misc]', `notasession=${ssh({ 1: 'evil' })}`
    ].join('\r\n')
    const result = readMobaText(text)
    expect(result.folders.map(f => [f.name, f.parentId])).toEqual([['운영', null], ['DB', 'f1']])
    expect(result.sessions.map(s => [s.name, s.host, s.folderId])).toEqual([['top', 'top.example.com', null], ['web', 'web.example.com', 'f1'], ['db', 'db.example.com', 'f2']])
    expect(result.skipped).toEqual({ 'SSH 가 아닌 세션': 1 })
  })

  it('treats the "User sessions" root of a full export as the top level and reads the ANSI code page', () => {
    const text = `[Bookmarks]\r\nSubRep=User sessions\r\nImgNum=42\r\n한글서버=${ssh({ 1: 'k.example.com' })}\r\n`
    const ansi = require('iconv-lite').encode(text, 'cp949')
    const result = readMobaFile(ansi)
    expect(result.folders).toEqual([])
    expect(result.sessions[0]).toMatchObject({ name: '한글서버', host: 'k.example.com', folderId: null })
  })
})
