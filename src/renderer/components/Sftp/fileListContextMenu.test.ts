import { describe, it, expect } from 'vitest'
import { fitMenu } from './FileListContextMenu'

const VIEWPORT = { width: 1200, height: 800 }
const MENU = { width: 210, height: 330 }

describe('fitMenu', () => {
  it('opens at the click when it fits', () => {
    expect(fitMenu({ x: 300, y: 200 }, MENU, VIEWPORT)).toEqual({ top: 200, left: 300 })
  })

  it('opens upwards near the bottom of the window', () => {
    expect(fitMenu({ x: 300, y: 700 }, MENU, VIEWPORT)).toEqual({ top: 370, left: 300 })
  })

  it('stays inside the window when neither direction has room', () => {
    expect(fitMenu({ x: 300, y: 200 }, { width: 210, height: 600 }, { width: 1200, height: 500 }).top).toBe(8)
  })

  it('moves in from the right edge', () => {
    expect(fitMenu({ x: 1150, y: 100 }, MENU, VIEWPORT).left).toBe(1200 - 210 - 8)
  })
})
