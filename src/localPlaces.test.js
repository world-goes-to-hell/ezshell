import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { parseLogicalDisks, listPlaces, createPlacesReader } = require('./localPlaces.js')

const isDir = (dirs) => async (p) => dirs.includes(p)

describe('parseLogicalDisks', () => {
  it('names drives by volume name, or by their kind', () => {
    const json = JSON.stringify([
      { DeviceID: 'C:', VolumeName: '', DriveType: 3 },
      { DeviceID: 'D:', VolumeName: '새 볼륨', DriveType: 3 },
      { DeviceID: 'E:', VolumeName: null, DriveType: 2 },
      { DeviceID: 'Z:', VolumeName: '', DriveType: 4 },
      { DeviceID: 'F:', VolumeName: '', DriveType: 5 }
    ])
    expect(parseLogicalDisks(json)).toEqual([
      { path: 'C:\\', label: '로컬 디스크 (C:)', kind: 'local' },
      { path: 'D:\\', label: '새 볼륨 (D:)', kind: 'local' },
      { path: 'E:\\', label: '이동식 디스크 (E:)', kind: 'removable' },
      { path: 'Z:\\', label: '네트워크 드라이브 (Z:)', kind: 'network' },
      { path: 'F:\\', label: 'CD 드라이브 (F:)', kind: 'cd' }
    ])
  })

  it('takes a single object (one drive) and ignores malformed entries', () => {
    expect(parseLogicalDisks(JSON.stringify({ DeviceID: 'C:', VolumeName: 'OS', DriveType: 3 }))).toEqual([
      { path: 'C:\\', label: 'OS (C:)', kind: 'local' }
    ])
    expect(parseLogicalDisks(JSON.stringify([{ DeviceID: 'C:\\evil', DriveType: 3 }, { VolumeName: 'x' }]))).toEqual([])
    expect(parseLogicalDisks('not json')).toEqual([])
  })

  it('keeps a volume name to one line and a sane length', () => {
    const [drive] = parseLogicalDisks(JSON.stringify([{ DeviceID: 'D:', VolumeName: 'a\nb'.padEnd(80, 'x'), DriveType: 3 }]))
    expect(drive.label).not.toContain('\n')
    expect(drive.label.length).toBeLessThanOrEqual(40 + ' (D:)'.length)
  })
})

describe('listPlaces', () => {
  const paths = { desktop: 'C:\\Users\\me\\Desktop', home: 'C:\\Users\\me', documents: 'C:\\Users\\me\\Documents', downloads: 'C:\\Users\\me\\Downloads', pictures: 'C:\\Users\\me\\Pictures', music: 'C:\\Users\\me\\Music', videos: 'C:\\Users\\me\\Videos' }
  const getPath = (name) => {
    if (!(name in paths)) throw new Error('unknown')
    return paths[name]
  }

  it('lists the usual folders that exist, in order, with Korean names', async () => {
    const places = await listPlaces({ getPath, isDirectory: isDir(Object.values(paths).filter(p => !p.endsWith('Music'))) })
    expect(places.map(p => [p.kind, p.label])).toEqual([
      ['desktop', '바탕 화면'], ['home', '홈 폴더'], ['documents', '문서'], ['downloads', '다운로드'], ['pictures', '사진'], ['videos', '동영상']
    ])
    expect(places[0].path).toBe('C:\\Users\\me\\Desktop')
  })

  it('skips a folder the system cannot name', async () => {
    const places = await listPlaces({ getPath: (n) => (n === 'home' ? 'C:\\Users\\me' : (() => { throw new Error('x') })()), isDirectory: async () => true })
    expect(places.map(p => p.kind)).toEqual(['home'])
  })
})

describe('createPlacesReader (drives)', () => {
  it('reads Windows drives once and remembers them for a while', async () => {
    let runs = 0
    let now = 0
    const reader = createPlacesReader({
      platform: 'win32',
      getPath: () => 'C:\\Users\\me',
      isDirectory: async () => true,
      runPowerShell: async () => { runs++; return JSON.stringify([{ DeviceID: 'C:', VolumeName: '', DriveType: 3 }]) },
      now: () => now
    })
    expect((await reader.read()).drives).toEqual([{ path: 'C:\\', label: '로컬 디스크 (C:)', kind: 'local' }])
    await reader.read()
    expect(runs).toBe(1)
    now += 31_000
    await reader.read()
    expect(runs).toBe(2)
  })

  it('falls back to the drive letters that open when PowerShell fails', async () => {
    const reader = createPlacesReader({
      platform: 'win32',
      getPath: () => 'C:\\Users\\me',
      isDirectory: async (p) => p === 'C:\\' || p === 'D:\\' || p === 'C:\\Users\\me',
      runPowerShell: async () => { throw new Error('blocked') },
      now: () => 0
    })
    expect((await reader.read()).drives).toEqual([
      { path: 'C:\\', label: 'C:', kind: 'local' },
      { path: 'D:\\', label: 'D:', kind: 'local' }
    ])
  })

  it('lists the root and mounted volumes elsewhere', async () => {
    const reader = createPlacesReader({
      platform: 'darwin',
      getPath: () => '/Users/me',
      isDirectory: async () => true,
      readDir: async (dir) => (dir === '/Volumes' ? ['Macintosh HD', 'USB'] : []),
      now: () => 0
    })
    expect((await reader.read()).drives).toEqual([
      { path: '/', label: '/ (루트)', kind: 'local' },
      { path: '/Volumes/Macintosh HD', label: 'Macintosh HD', kind: 'local' },
      { path: '/Volumes/USB', label: 'USB', kind: 'local' }
    ])
  })
})
