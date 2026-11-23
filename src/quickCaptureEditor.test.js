import { describe, expect, it } from 'vitest'
import { arrowHead, commentWithBadge, cornerBox, EDITOR_SCRIPT, isMark, markedImage } from './quickCaptureEditor.js'

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
