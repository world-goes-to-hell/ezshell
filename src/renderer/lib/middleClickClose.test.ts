import { describe, expect, it, vi } from 'vitest'
import type { MouseEvent } from 'react'
import { middleClickClose } from './middleClickClose'

const event = (button: number) => ({ button, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as MouseEvent & { preventDefault: ReturnType<typeof vi.fn> }

describe('closing a tab with the wheel button', () => {
  it('closes on a middle click and keeps the press from scrolling', () => {
    const close = vi.fn()
    const handlers = middleClickClose(close)
    const press = event(1)
    handlers.onMouseDown(press)
    expect(press.preventDefault).toHaveBeenCalled()
    handlers.onAuxClick(event(1))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves the left and right buttons alone', () => {
    const close = vi.fn()
    const handlers = middleClickClose(close)
    for (const button of [0, 2]) {
      const press = event(button)
      handlers.onMouseDown(press)
      handlers.onAuxClick(event(button))
      expect(press.preventDefault).not.toHaveBeenCalled()
    }
    expect(close).not.toHaveBeenCalled()
  })
})
