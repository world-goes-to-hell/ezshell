import { describe, it, expect } from 'vitest'
import { buildPathSuggestions } from './pathSuggestions'

const places = [
  { kind: 'desktop' as const, label: '바탕 화면', path: 'C:\\Users\\me\\Desktop' },
  { kind: 'downloads' as const, label: '다운로드', path: 'C:\\Users\\me\\Downloads' }
]
const drives = [
  { kind: 'local' as const, label: '로컬 디스크 (C:)', path: 'C:\\' },
  { kind: 'local' as const, label: '새 볼륨 (D:)', path: 'D:\\' }
]

describe('buildPathSuggestions', () => {
  it('lists bookmarks, then usual folders, then drives for the local side', () => {
    const items = buildPathSuggestions({ bookmarks: ['D:\\git\\kira'], places, drives, query: '', isLocal: true })
    expect(items.map(i => [i.section, i.label])).toEqual([
      ['bookmark', 'D:\\git\\kira'],
      ['place', '바탕 화면'], ['place', '다운로드'],
      ['drive', '로컬 디스크 (C:)'], ['drive', '새 볼륨 (D:)']
    ])
  })

  it('shows only bookmarks on the server side', () => {
    const items = buildPathSuggestions({ bookmarks: ['/data'], places, drives, query: '', isLocal: false })
    expect(items).toEqual([{ section: 'bookmark', path: '/data', label: '/data' }])
  })

  it('filters by name or path while typing, ignoring case', () => {
    expect(buildPathSuggestions({ bookmarks: [], places, drives, query: '다운', isLocal: true }).map(i => i.label)).toEqual(['다운로드'])
    expect(buildPathSuggestions({ bookmarks: [], places, drives, query: 'd:', isLocal: true }).map(i => i.label)).toEqual(['새 볼륨 (D:)'])
    expect(buildPathSuggestions({ bookmarks: ['D:\\git\\kira'], places, drives, query: 'KIRA', isLocal: true }).map(i => i.path)).toEqual(['D:\\git\\kira'])
  })

  it('does not repeat a bookmark that is also a usual folder or a drive', () => {
    const items = buildPathSuggestions({ bookmarks: ['C:\\Users\\me\\Desktop'], places, drives, query: '', isLocal: true })
    expect(items.filter(i => i.path === 'C:\\Users\\me\\Desktop')).toHaveLength(1)
    expect(items[0].section).toBe('bookmark')
  })
})
