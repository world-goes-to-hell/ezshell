import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundleFromDraft, bundleHead, bundleMembers, readBundleChoice, writeBundleChoice, type RunBundle } from './runBundles'
import type { RunPreset, RunStartOrder, RunState } from '../types'

const preset = (id: string, name: string, inAll = true): RunPreset => ({
  id, name, relative: '.', kind: 'task', taskId: '.:gradle', jdk: 'system', env: {}, notify: true, agentControl: true, inAll, waitReady: false
})
const presets = [preset('g', 'gateway'), preset('a', 'auth'), preset('o', 'order'), preset('x', 'admin', false)]
const order: RunBundle = { id: 'b1', name: '주문 개발', presetIds: ['g', 'a', 'o', 'gone'] }
const running: RunState = { status: 'running', errors: 0 }

describe('run bundles on the card', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('starts a bundle\u2019s presets, or all the presets in 모두 실행', () => {
    expect(bundleMembers(presets, order).map(item => item.id)).toEqual(['g', 'a', 'o'])
    expect(bundleMembers(presets, null).map(item => item.id)).toEqual(['g', 'a', 'o'])
    // A named bundle can append its presets outside the project order.
    const order2 = { stages: [{ ids: ['o', 'x'], gate: { kind: 'none' } }], timeoutSeconds: 300, onTimeout: 'pause', reverseStop: true, askDependencies: true } as unknown as RunStartOrder
    expect(bundleMembers(presets, order, order2).map(item => item.id)).toEqual(['o', 'g', 'a'])
    expect(bundleMembers(presets, null, order2).map(item => item.id)).toEqual(['o', 'x'])
  })

  it('offers start, then stop once one of the bundle\u2019s presets runs', () => {
    expect(bundleHead(presets, {}, order)).toMatchObject({ action: 'start', label: '주문 개발 실행', count: 3, canStart: true })
    expect(bundleHead(presets, { a: running }, order)).toMatchObject({ action: 'stop', label: '주문 개발 중지' })
    // A preset outside the bundle does not count
    expect(bundleHead(presets, { x: running }, order)).toMatchObject({ action: 'start' })
    // Without a bundle, 모두 중지 shows while anything runs
    expect(bundleHead(presets, { x: running }, null)).toMatchObject({ action: 'stop', label: '모두 중지' })
    expect(bundleHead(presets, {}, null)).toMatchObject({ label: '모두 실행', count: 3 })
    expect(bundleHead([], {}, null)).toMatchObject({ canStart: false, title: '띄울 구성이 없습니다' })
    expect(bundleHead(presets, {}, { ...order, presetIds: ['x'] })).toMatchObject({ count: 1, canStart: true })
  })

  it('remembers the chosen bundle on this PC, while it exists', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) })
    writeBundleChoice('c:/work/shop', order)
    expect(readBundleChoice('c:/work/shop', [order])?.id).toBe('b1')
    expect(readBundleChoice('c:/work/shop', [])).toBeNull()
    writeBundleChoice('c:/work/shop', null)
    expect(readBundleChoice('c:/work/shop', [order])).toBeNull()
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } })
    expect(readBundleChoice('c:/work/shop', [order])).toBeNull()
  })

  it('checks a bundle draft before saving', () => {
    expect(bundleFromDraft({ name: ' 결제 ', presetIds: ['g', 'g', 'gone'] }, presets, [order])).toEqual({ bundle: { name: '결제', presetIds: ['g'] } })
    expect(bundleFromDraft({ id: 'b1', name: '주문 개발', presetIds: ['a'] }, presets, [order])).toEqual({ bundle: { id: 'b1', name: '주문 개발', presetIds: ['a'] } })
    expect(bundleFromDraft({ name: '주문 개발', presetIds: ['a'] }, presets, [order])).toEqual({ error: '같은 이름의 묶음이 있습니다.' })
    expect(bundleFromDraft({ name: '', presetIds: ['a'] }, presets, [])).toEqual({ error: '묶음 이름을 입력해 주세요.' })
    expect(bundleFromDraft({ name: 'x'.repeat(21), presetIds: ['a'] }, presets, [])).toEqual({ error: '묶음 이름은 20자까지입니다.' })
    expect(bundleFromDraft({ name: 'x', presetIds: [] }, presets, [])).toEqual({ error: '묶음에 넣을 실행 구성을 하나 이상 골라 주세요.' })
  })
})
