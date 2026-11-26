import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createRunBundleStore } = require('./runBundleStore.js')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const KEY = 'c:/work/shop'
let folder

afterEach(() => { if (folder) fs.rmSync(folder, { recursive: true, force: true }) })

const fresh = () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'run-bundles-'))
  return path.join(folder, 'run-bundles.json')
}

describe('run bundle store', () => {
  it('saves bundles by project in a file of its own and reads them back', () => {
    const file = fresh()
    const store = createRunBundleStore(file)
    expect(store.list(KEY, [A, B])).toEqual([])
    const [saved] = store.save(KEY, { name: '주문 개발', presetIds: [A, B] }, [A, B])
    expect(saved).toMatchObject({ name: '주문 개발', presetIds: [A, B] })
    const again = createRunBundleStore(file)
    expect(again.list(KEY, [A, B])).toEqual([saved])
    expect(again.list('c:/other', [A, B])).toEqual([])
  })

  it('leaves out presets that are gone, and a bundle left empty', () => {
    const store = createRunBundleStore(fresh())
    const [order] = store.save(KEY, { name: '주문', presetIds: [A, B] }, [A, B])
    store.save(KEY, { name: 'B만', presetIds: [B] }, [A, B])
    expect(store.list(KEY, [A])).toEqual([{ ...order, presetIds: [A] }])
  })

  it('finds what a bundle starts by id or by name, and removes one', () => {
    const store = createRunBundleStore(fresh())
    const [order] = store.save(KEY, { name: '주문', presetIds: [A] }, [A, B])
    expect(store.selection(KEY, [A, B], { id: order.id })).toEqual([A])
    expect(store.selection(KEY, [A, B], { name: '주문' })).toEqual([A])
    expect(() => store.selection(KEY, [A, B], { name: '없음' })).toThrow('실행 묶음을 찾지 못했습니다')
    expect(store.remove(KEY, order.id, [A, B])).toEqual([])
    expect(() => store.remove(KEY, order.id, [A, B])).toThrow('묶음을 찾지 못했습니다')
  })

  it('ignores a broken file and refuses a bad bundle without writing', () => {
    const file = fresh()
    fs.writeFileSync(file, '{not json')
    const store = createRunBundleStore(file)
    expect(store.list(KEY, [A])).toEqual([])
    expect(() => store.save(KEY, { name: '', presetIds: [A] }, [A])).toThrow('묶음 이름')
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json')
  })
})
