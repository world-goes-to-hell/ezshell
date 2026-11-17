import { describe, it, expect } from 'vitest'
import { transferMarksFor, finishedInto, startedInto, type MarkableTransfer } from './transferMarks'

let nextId = 0
const upload = (remotePath: string, status: MarkableTransfer['status'], error?: string, progress = 0): MarkableTransfer =>
  ({ id: String(nextId++), type: 'upload', localPath: `C:\\src\\${remotePath.split('/').pop()}`, remotePath, status, error, progress })
const download = (localPath: string, status: MarkableTransfer['status']): MarkableTransfer =>
  ({ id: String(nextId++), type: 'download', localPath, remotePath: `/srv/${localPath.split('\\').pop()}`, status, progress: 0 })

describe('transferMarksFor', () => {
  it('marks uploads on the remote side by their target name in that folder', () => {
    const transfers = [
      upload('/var/www/a.txt', 'completed'),
      upload('/var/www/b (1).txt', 'active', undefined, 42),
      upload('/var/www/c.txt', 'error', 'Permission denied'),
      upload('/var/www/sub/d.txt', 'completed')
    ]

    const marks = transferMarksFor(transfers, 'remote', '/var/www')

    // 'sub': the folder the fourth upload went into (folders sent whole are marked too)
    expect([...marks.keys()]).toEqual(['a.txt', 'b (1).txt', 'c.txt', 'sub'])
    expect(marks.get('a.txt')).toEqual({ direction: 'upload', state: 'done' })
    expect(marks.get('b (1).txt')).toEqual({ direction: 'upload', state: 'transferring', progress: 42 })
    expect(marks.get('c.txt')).toEqual({ direction: 'upload', state: 'error', error: 'Permission denied' })
  })

  it('ignores downloads on the remote side and uploads on the local side', () => {
    const transfers = [upload('/srv/a.txt', 'completed'), download('C:\\work\\a.txt', 'completed')]

    expect(transferMarksFor(transfers, 'remote', '/srv').size).toBe(1)
    expect(transferMarksFor(transfers, 'local', 'C:\\work').get('a.txt')).toEqual({ direction: 'download', state: 'done' })
  })

  it('keeps queued and paused apart from transferring, with the progress so far', () => {
    const marks = transferMarksFor([upload('/a/q.txt', 'queued'), upload('/a/p.txt', 'paused', undefined, 30)], 'remote', '/a')

    expect(marks.get('q.txt')).toEqual({ direction: 'upload', state: 'queued', progress: 0 })
    expect(marks.get('p.txt')).toEqual({ direction: 'upload', state: 'paused', progress: 30 })
  })

  it('clamps odd progress values into 0..100', () => {
    const marks = transferMarksFor([upload('/a/x.txt', 'active', undefined, 140), upload('/a/y.txt', 'active', undefined, NaN)], 'remote', '/a')

    expect(marks.get('x.txt')?.progress).toBe(100)
    expect(marks.get('y.txt')?.progress).toBe(0)
  })

  it('matches the folder regardless of trailing separator, and Windows paths regardless of case', () => {
    expect(transferMarksFor([upload('/a.txt', 'completed')], 'remote', '/').has('a.txt')).toBe(true)
    expect(transferMarksFor([upload('/x/a.txt', 'completed')], 'remote', '/x/').has('a.txt')).toBe(true)
    expect(transferMarksFor([download('C:\\Work\\a.txt', 'completed')], 'local', 'c:\\work\\').has('a.txt')).toBe(true)
    expect(transferMarksFor([download('C:\\a.txt', 'completed')], 'local', 'C:\\').has('a.txt')).toBe(true)
  })

  it('uses the latest transfer when the same name was sent more than once', () => {
    const marks = transferMarksFor([upload('/a/x.txt', 'error', 'boom'), upload('/a/x.txt', 'completed')], 'remote', '/a')

    expect(marks.get('x.txt')).toEqual({ direction: 'upload', state: 'done' })
  })

  it('skips transfers without a target path (older main process)', () => {
    const legacy = { id: 'old', type: 'upload', status: 'completed' } as MarkableTransfer

    expect(transferMarksFor([legacy], 'remote', '/').size).toBe(0)
  })
})

describe('finishedInto', () => {
  it('is true when a transfer into the folder became completed or failed', () => {
    const active = upload('/a/x.txt', 'active')
    const done = { ...active, status: 'completed' as const }
    const failed = { ...active, status: 'error' as const }

    expect(finishedInto([active], [done], 'remote', '/a')).toBe(true)
    expect(finishedInto([active], [failed], 'remote', '/a')).toBe(true)
  })

  it('is false for other folders, the other side, still running or already finished transfers', () => {
    const active = upload('/a/x.txt', 'active')
    const done = { ...active, status: 'completed' as const }

    expect(finishedInto([active], [done], 'remote', '/b')).toBe(false)
    expect(finishedInto([active], [done], 'local', '/a')).toBe(false)
    expect(finishedInto([active], [active], 'remote', '/a')).toBe(false)
    expect(finishedInto([done], [done], 'remote', '/a')).toBe(false)
  })

  it('is true for a transfer that appears already finished', () => {
    expect(finishedInto([], [upload('/a/x.txt', 'completed')], 'remote', '/a')).toBe(true)
  })
})

describe('startedInto', () => {
  it('is true when a transfer into the folder became active (the target file now exists)', () => {
    const queued = upload('/a/x.txt', 'queued')
    const active = { ...queued, status: 'active' as const }

    expect(startedInto([queued], [active], 'remote', '/a')).toBe(true)
    expect(startedInto([], [active], 'remote', '/a')).toBe(true)
  })

  it('is false for progress ticks of a running transfer, other folders and queued transfers', () => {
    const active = upload('/a/x.txt', 'active', undefined, 10)
    const ticked = { ...active, progress: 20 }

    expect(startedInto([active], [ticked], 'remote', '/a')).toBe(false)
    expect(startedInto([], [active], 'remote', '/b')).toBe(false)
    expect(startedInto([], [upload('/a/q.txt', 'queued')], 'remote', '/a')).toBe(false)
  })
})

describe('transferMarksFor: folders sent whole', () => {
  it('marks the folder a transfer landed inside, at any depth', () => {
    const marks = transferMarksFor([upload('/var/www/site/index.html', 'completed'), upload('/var/www/site/css/a.css', 'completed')], 'remote', '/var/www')
    expect(marks.get('site')).toEqual({ direction: 'upload', state: 'done' })
    expect(marks.size).toBe(1)
  })

  it('keeps the folder transferring until everything in it is through, with the overall progress', () => {
    const marks = transferMarksFor([upload('/a/dir/1.txt', 'completed'), upload('/a/dir/2.txt', 'active', undefined, 50), upload('/a/dir/3.txt', 'queued')], 'remote', '/a')
    expect(marks.get('dir')).toEqual({ direction: 'upload', state: 'transferring', progress: 50 })
  })

  it('reports how many failed once nothing is pending', () => {
    const marks = transferMarksFor([upload('/a/dir/1.txt', 'completed'), upload('/a/dir/2.txt', 'error', 'denied')], 'remote', '/a')
    expect(marks.get('dir')).toEqual({ direction: 'upload', state: 'error', error: '2개 중 1개 실패' })
  })

  it('works for downloads into a Windows folder, whatever the case and separators of the paths', () => {
    const marks = transferMarksFor([download('C:\\Work\\app\\conf\\a.yaml', 'completed')], 'local', 'c:/work')
    expect(marks.get('app')).toEqual({ direction: 'download', state: 'done' })
  })

  it('does not mark folders for transfers elsewhere, or on the other side', () => {
    expect(transferMarksFor([upload('/other/dir/1.txt', 'completed')], 'remote', '/a').size).toBe(0)
    expect(transferMarksFor([upload('/a/dir/1.txt', 'completed')], 'local', 'C:\\src').size).toBe(0)
    expect(transferMarksFor([upload('/a/1.txt', 'completed')], 'remote', '/a').has('a')).toBe(false)
  })

  it('marks a folder under the root', () => {
    expect(transferMarksFor([upload('/dir/1.txt', 'completed')], 'remote', '/').get('dir')?.state).toBe('done')
  })
})

