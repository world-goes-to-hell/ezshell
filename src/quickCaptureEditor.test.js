import { describe, expect, it } from 'vitest'
import { arrowHead, commentWithBadge, composeStack, cornerBox, EDITOR_SCRIPT, fitBox, isMark, markedImage, MAX_SHOTS, nextBadge, restoredHistory, stackLayout } from './quickCaptureEditor.js'

describe('capture marks', () => {
  it('puts the arrow head at the end of the drag, its shaft stopping under the head', () => {
    const head = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)
    expect(head.tip).toEqual({ x: 100, y: 0 })
    expect(head.left.x).toBeCloseTo(84)
    expect(head.right.x).toBeCloseTo(84)
    expect(head.left.y).toBeCloseTo(8.8)
    expect(head.right.y).toBeCloseTo(-8.8)
    expect(head.shaftEnd.x).toBeGreaterThan(84)
    expect(arrowHead({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)).toBeNull()
    // A short arrow keeps its head within its own length
    expect(arrowHead({ x: 0, y: 0 }, { x: 6, y: 0 }, 10).left.x).toBeCloseTo(0)
  })

  it('makes a box from corners dragged any way', () => {
    expect(cornerBox({ x: 30, y: 5 }, { x: 10, y: 25 })).toEqual({ x: 10, y: 5, width: 20, height: 20 })
  })

  it('adds a numbered line to the comment for each badge', () => {
    expect(commentWithBadge('', 1)).toBe('1. ')
    expect(commentWithBadge('1. 버튼 색  \n', 2)).toBe('1. 버튼 색\n2. ')
    expect(commentWithBadge('전체적으로 어둡다', 3)).toBe('전체적으로 어둡다\n3. ')
  })

  it('keeps a drag as a mark only when it moved, and text only when typed', () => {
    expect(isMark({ type: 'arrow', from: { x: 0, y: 0 }, to: { x: 2, y: 2 } }, 4)).toBe(false)
    expect(isMark({ type: 'box', from: { x: 0, y: 0 }, to: { x: 20, y: 0 } }, 4)).toBe(true)
    expect(isMark({ type: 'pen', points: [{ x: 1, y: 1 }] }, 4)).toBe(false)
    expect(isMark({ type: 'text', text: '  ' }, 4)).toBe(false)
    expect(isMark({ type: 'badge' }, 4)).toBe(true)
  })

  it('is valid script for the overlay page, without anything from this module', () => {
    expect(() => new Function(EDITOR_SCRIPT)).not.toThrow()
    expect(EDITOR_SCRIPT).toMatch(/installCaptureEditor\(\)\s*$/)
    expect(EDITOR_SCRIPT).not.toMatch(/require\(|module\.exports/)
  })
})

describe('several captures in one go', () => {
  it('stacks the captures top to bottom, each under a band for its number', () => {
    expect(stackLayout([{ width: 100, height: 50 }, { width: 80, height: 40 }])).toEqual({
      width: 100, height: 170,
      items: [{ labelY: 0, y: 32, width: 100, height: 50 }, { labelY: 98, y: 130, width: 80, height: 40 }]
    })
    expect(stackLayout([{ width: 7, height: 3 }])).toEqual({ width: 7, height: 35, items: [{ labelY: 0, y: 32, width: 7, height: 3 }] })
  })

  it('shows an earlier capture at its own size at the top, shrinking it to leave room for the panel', () => {
    expect(fitBox({ width: 1000, height: 500 }, { width: 1280, height: 880 }, 1.25, 400)).toEqual({ left: 240, top: 24, width: 800, height: 400 })
    expect(fitBox({ width: 1000, height: 500 }, { width: 600, height: 500 }, 1.25, 400)).toEqual({ left: 175, top: 24, width: 250, height: 125 })
  })

  it('numbers a new badge after the largest number on any capture', () => {
    const badge = n => ({ type: 'badge', n })
    expect(nextBadge([])).toBe(1)
    expect(nextBadge([[badge(1), badge(2), { type: 'arrow' }], [badge(3)]])).toBe(4)
    expect(nextBadge([[badge(1)], [badge(5)], [badge(2)]])).toBe(6)
  })

  it('lets undo take restored marks off one at a time', () => {
    expect(restoredHistory(['a', 'b', 'c'])).toEqual([[], ['a'], ['a', 'b']])
    expect(restoredHistory([])).toEqual([])
  })

  it('stacks the checked pictures itself when the overlay picture cannot be used', () => {
    const picture = (width, height, value) => ({ getSize: () => ({ width, height }), toBitmap: () => Buffer.alloc(width * height * 4, value) })
    const nativeImage = { createFromBitmap: (buffer, size) => ({ buffer, size }) }
    const { buffer, size } = composeStack([picture(2, 1, 9), picture(1, 2, 7)], nativeImage)
    expect(size).toEqual({ width: 2, height: 32 + 1 + 16 + 32 + 2 })
    const pixel = (x, y) => [...buffer.subarray((y * 2 + x) * 4, (y * 2 + x) * 4 + 4)]
    expect(pixel(0, 0)).toEqual([0x22, 0x22, 0x22, 0xff])
    expect(pixel(1, 32)).toEqual([9, 9, 9, 9])
    expect(pixel(0, 81)).toEqual([7, 7, 7, 7])
    expect(pixel(1, 81)).toEqual([0x22, 0x22, 0x22, 0xff])
    expect(composeStack([{ getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(3) }], nativeImage)).toBeNull()
    // Past 64M pixels (a 256MB buffer) main does not try
    const tooBig = { getSize: () => ({ width: 9000, height: 8000 }), toBitmap: () => { throw new Error('allocated') } }
    expect(composeStack([tooBig], nativeImage)).toBeNull()
  })

  it('allows eight captures', () => {
    expect(MAX_SHOTS).toBe(8)
    expect(EDITOR_SCRIPT).toContain('const MAX_SHOTS = 8')
  })
})

describe('the marked image from the overlay', () => {
  const region = { x: 10, y: 20, width: 300, height: 200 }
  const nativeImage = {
    createFromDataURL: value => ({
      isEmpty: () => value.endsWith('empty'),
      getSize: () => (value.endsWith('small') ? { width: 299, height: 200 } : { width: 300, height: 200 })
    })
  }

  it('is used only as a PNG data URL of exactly the chosen size', () => {
    expect(markedImage('data:image/png;base64,ok', region, nativeImage)).not.toBeNull()
    expect(markedImage('data:image/png;base64,small', region, nativeImage)).toBeNull()
    expect(markedImage('data:image/png;base64,empty', region, nativeImage)).toBeNull()
    expect(markedImage('data:image/jpeg;base64,ok', region, nativeImage)).toBeNull()
    expect(markedImage('data:image/png;base64,' + 'A'.repeat(48 * 1024 * 1024), region, nativeImage)).toBeNull()
    expect(markedImage(null, region, nativeImage)).toBeNull()
    expect(markedImage('data:image/png;base64,ok', region, null)).toBeNull()
  })
})
