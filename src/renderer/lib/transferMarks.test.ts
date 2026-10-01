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

    expect([...marks.keys()]).toEqual(['a.txt', 'b (1).txt', 'c.txt'])
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
