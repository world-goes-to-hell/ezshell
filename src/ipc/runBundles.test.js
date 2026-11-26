import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { findBundle, keepBundles, saveBundle, validateBundle, MAX_BUNDLES } = require('./runBundles.js')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const presets = new Set([A, B, C])
const bundleId = '44444444-4444-4444-8444-444444444444'

describe('run bundles', () => {
  it('accepts a named choice of the project\u2019s presets, without repeats', () => {
    const bundle = validateBundle({ name: ' 주문 개발 ', presetIds: [A, B, A] }, presets)
    expect(bundle).toMatchObject({ name: '주문 개발', presetIds: [A, B] })
    expect(bundle.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(validateBundle({ id: bundleId, name: 'x', presetIds: [C] }, presets).id).toBe(bundleId)
  })

  it('refuses what main cannot keep', () => {
    expect(() => validateBundle({ name: '', presetIds: [A] }, presets)).toThrow('묶음 이름을 입력해 주세요.')
    expect(() => validateBundle({ name: 'x'.repeat(21), presetIds: [A] }, presets)).toThrow('20자까지')
    expect(() => validateBundle({ name: 'a\u202eb', presetIds: [A] }, presets)).toThrow('쓸 수 없는 글자')
    expect(() => validateBundle({ name: 'x', presetIds: [] }, presets)).toThrow('하나 이상')
    expect(() => validateBundle({ name: 'x', presetIds: ['gone'] }, presets)).toThrow('없는 실행 구성')
    expect(() => validateBundle({ name: 'x', presetIds: [A, B, C, A] }, presets)).toThrow('실행 구성을 확인해')
    expect(() => validateBundle({ id: 'nope', name: 'x', presetIds: [A] }, presets)).toThrow('묶음을 확인해')
    expect(() => validateBundle(null, presets)).toThrow('묶음을 확인해')
  })

  it('keeps the saved bundles that still make sense after the presets changed', () => {
    const kept = keepBundles([
      { id: bundleId, name: '주문 개발', presetIds: [A, 'deleted', B] },
      { id: bundleId, name: '같은 id', presetIds: [A] },
      { id: C, name: '주문 개발', presetIds: [C] },
      { id: B, name: '빈 묶음', presetIds: ['deleted'] },
      { id: 'x', name: '나쁜 id', presetIds: [A] },
      'text'
    ], presets)
    expect(kept).toEqual([{ id: bundleId, name: '주문 개발', presetIds: [A, B] }])
    expect(keepBundles(undefined, presets)).toEqual([])
  })

  it('saves a new bundle or replaces one, refusing a name in use and more than the limit', () => {
    const first = saveBundle([], { id: bundleId, name: '주문', presetIds: [A] }, presets)
    expect(saveBundle(first, { id: bundleId, name: '주문', presetIds: [A, C] }, presets)).toEqual([{ id: bundleId, name: '주문', presetIds: [A, C] }])
    expect(() => saveBundle(first, { name: '주문', presetIds: [B] }, presets)).toThrow('같은 이름')
    const full = Array.from({ length: MAX_BUNDLES }, (_, index) => ({ id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`, name: `b${index}`, presetIds: [A] }))
    expect(() => saveBundle(full, { name: 'more', presetIds: [A] }, presets)).toThrow(`${MAX_BUNDLES}개까지`)
  })

  it('finds a bundle by id, or by name for the MCP tools', () => {
    const bundles = [{ id: bundleId, name: '주문 개발', presetIds: [A] }]
    expect(findBundle(bundles, { id: bundleId })?.name).toBe('주문 개발')
    expect(findBundle(bundles, { name: ' 주문 개발 ' })?.id).toBe(bundleId)
    expect(findBundle(bundles, { name: '없음' })).toBeNull()
    expect(findBundle(bundles)).toBeNull()
  })
})
