import { describe, expect, it } from 'vitest'
import { moveOrderPreset, startOrderForSave, validWaitPart, type RunStartOrderDraft } from './runStartOrderDraft'

const draft: RunStartOrderDraft = {
  timeoutSeconds: 300, onTimeout: 'pause', askDependencies: true, reverseStop: true,
  stages: [
    { key: 3, ids: ['a', 'b'], gate: { kind: 'ready' } },
    { key: 4, ids: ['c'], gate: { kind: 'log', value: '' } }
  ]
}

describe('start order editor', () => {
  it('keeps both stage keys when their first preset moves and assigns a new key only to a new stage', () => {
    const moved = moveOrderPreset(draft.stages, 'a', 1, 5)
    expect(moved.map(({ key, ids }) => ({ key, ids }))).toEqual([{ key: 3, ids: ['b'] }, { key: 4, ids: ['c', 'a'] }])
    const appended = moveOrderPreset(moved, 'b', 'new', 5)
    expect(appended.map(({ key }) => key)).toEqual([4, 5])
  })

  it('omits internal stage keys, saves exact seconds and clears the last stage’s unused gate', () => {
    expect(startOrderForSave(draft, '5', '7')).toMatchObject({
      timeoutSeconds: 307, stages: [{ ids: ['a', 'b'], gate: { kind: 'ready' } }, { ids: ['c'], gate: { kind: 'none' } }]
    })
    expect(startOrderForSave(draft, '5', '7')?.stages[0]).not.toHaveProperty('key')
  })

  it('rejects negative values, overflow and empty duration', () => {
    expect(validWaitPart('-1', 60)).toBe(false)
    expect(validWaitPart('59', 59)).toBe(true)
    for (const [minutes, seconds] of [['-1', '10'], ['5', '-1'], ['5', '60'], ['60', '01'], ['', '']]) {
      expect(startOrderForSave(draft, minutes, seconds)).toBeNull()
    }
    expect(startOrderForSave(draft, '60', '0')?.timeoutSeconds).toBe(3600)
  })
})
