import { describe, expect, it } from 'vitest'
import { uncoveredBox } from './browserViewClip'

const view = { x: 46, y: 80, width: 900, height: 600 }

describe('browser view clip', () => {
  it('keeps the view when no panel overlaps it', () => {
    expect(uncoveredBox(view, [])).toEqual(view)
    // The folded rail, beside the view
    expect(uncoveredBox(view, [{ x: 0, y: 0, width: 46, height: 1000 }])).toEqual(view)
  })

  it('cuts the view from the left under the opened sidebar', () => {
    expect(uncoveredBox(view, [{ x: 0, y: 0, width: 280, height: 1000 }])).toEqual({ x: 280, y: 80, width: 666, height: 600 })
  })

  it('cuts the view from the right under a right panel, both sides together', () => {
    expect(uncoveredBox(view, [{ x: 0, y: 0, width: 280, height: 1000 }, { x: 600, y: 40, width: 400, height: 900 }]))
      .toEqual({ x: 280, y: 80, width: 320, height: 600 })
  })

  it('ignores a panel above or below the view and an empty one', () => {
    expect(uncoveredBox(view, [{ x: 0, y: 700, width: 500, height: 100 }, { x: 0, y: 0, width: 0, height: 0 }])).toEqual(view)
  })

  it('hides the view when too little is left', () => {
    expect(uncoveredBox(view, [{ x: 0, y: 0, width: 500, height: 1000 }, { x: 520, y: 0, width: 500, height: 1000 }])).toBeNull()
  })
})
