import { describe, it, expect, vi } from 'vitest'
import { runTransferBatch, resolveTarget, uniqueName, siblingPath, type OverwriteAnswer } from './transferBatch'

const files = (count: number) => Array.from({ length: count }, (_, i) => `f${i + 1}.txt`)

function setup(conflicts: string[], answers: Array<OverwriteAnswer | null>) {
  const ran: Array<[string, string]> = []
  const asked: string[] = []
  const queue = [...answers]
  const steps = {
    hasConflict: (name: string) => conflicts.includes(name),
    ask: vi.fn(async (name: string) => {
      asked.push(name)
      return queue.shift() ?? null
    }),
    run: async (name: string, action: string) => { ran.push([name, action]) }
  }
  return { steps, ran, asked }
}

describe('runTransferBatch', () => {
  it('asks about the conflicting file itself and still transfers every file after it', async () => {
    const { steps, ran, asked } = setup(['f5.txt'], [{ action: 'skip', applyToAll: false }])

    const result = await runTransferBatch(files(10), steps)

    expect(asked).toEqual(['f5.txt'])
    expect(ran.map(([name]) => name)).toEqual(files(10).filter(name => name !== 'f5.txt'))
    expect(ran.every(([, action]) => action === 'overwrite')).toBe(true)
    expect(result).toEqual({ processed: 10, cancelled: false })
  })

  it('never runs the same file twice', async () => {
    const { steps, ran } = setup(['f3.txt', 'f7.txt'], [
      { action: 'overwrite', applyToAll: false },
      { action: 'overwrite', applyToAll: false }
    ])

    await runTransferBatch(files(9), steps)

    expect(ran.map(([name]) => name)).toEqual(files(9))
  })

  it('applies "apply to all" only to later conflicts, not to files without a conflict', async () => {
    const { steps, ran, asked } = setup(['f2.txt', 'f6.txt', 'f8.txt'], [{ action: 'skip', applyToAll: true }])

    await runTransferBatch(files(10), steps)

    expect(asked).toEqual(['f2.txt'])
    expect(ran.map(([name]) => name)).toEqual(['f1.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f7.txt', 'f9.txt', 'f10.txt'])
  })

  it('renames only the conflicting files when rename is applied to all', async () => {
    const { steps, ran } = setup(['f2.txt', 'f4.txt'], [{ action: 'rename', applyToAll: true }])

    await runTransferBatch(files(5), steps)

    expect(ran).toEqual([
      ['f1.txt', 'overwrite'],
      ['f2.txt', 'rename'],
      ['f3.txt', 'overwrite'],
      ['f4.txt', 'rename'],
      ['f5.txt', 'overwrite']
    ])
  })

  it('stops at the conflict when the dialog is cancelled', async () => {
    const { steps, ran } = setup(['f4.txt'], [null])

    const result = await runTransferBatch(files(8), steps)

    expect(ran.map(([name]) => name)).toEqual(['f1.txt', 'f2.txt', 'f3.txt'])
    expect(result).toEqual({ processed: 3, cancelled: true })
  })
})

describe('resolveTarget', () => {
  const plan = (existing: Record<string, number>, sourceSize?: number) => ({
    fileName: 'a.txt',
    plannedTarget: '/up/a.txt',
    sourceSize,
    existing: new Map(Object.entries(existing))
  })

  it('keeps the planned target for overwrite and drops skip', () => {
    expect(resolveTarget(plan({ 'a.txt': 1 }), 'overwrite', new Set())).toBe('/up/a.txt')
    expect(resolveTarget(plan({ 'a.txt': 1 }), 'skip', new Set())).toBeNull()
  })

  it('skips size-diff only when both sizes are known and equal', () => {
    expect(resolveTarget(plan({ 'a.txt': 10 }, 10), 'size-diff', new Set())).toBeNull()
    expect(resolveTarget(plan({ 'a.txt': 10 }, 11), 'size-diff', new Set())).toBe('/up/a.txt')
    expect(resolveTarget(plan({ 'a.txt': -1 }, 10), 'size-diff', new Set())).toBe('/up/a.txt')
    expect(resolveTarget(plan({ 'a.txt': 10 }), 'size-diff', new Set())).toBe('/up/a.txt')
  })

  it('renames away from names in the folder and names this batch will create', () => {
    // "a (1).txt" is another file of the same batch, so the renamed copy must not land on it
    const reserved = new Set(['a.txt', 'a (1).txt'])
    expect(resolveTarget(plan({ 'a.txt': 1 }), 'rename', reserved)).toBe('/up/a (2).txt')
  })
})

describe('uniqueName', () => {
  it('numbers the name before the extension', () => {
    expect(uniqueName('a.txt', new Set(['a.txt']))).toBe('a (1).txt')
    expect(uniqueName('a.txt', new Set(['a.txt', 'a (1).txt']))).toBe('a (2).txt')
    expect(uniqueName('.env', new Set(['.env']))).toBe('.env (1)')
  })
})

describe('siblingPath', () => {
  it('replaces the last segment of remote and Windows paths', () => {
    expect(siblingPath('/var/www/old/a.txt', 'a (1).txt')).toBe('/var/www/old/a (1).txt')
    expect(siblingPath('/a.txt', 'a (1).txt')).toBe('/a (1).txt')
    expect(siblingPath('C:\\work\\sub\\a.txt', 'a (1).txt')).toBe('C:\\work\\sub\\a (1).txt')
  })
})
