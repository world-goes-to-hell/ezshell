import { describe, expect, it, vi } from 'vitest'
import {
  addClick, addMove, CLICK_CAP, clearEffects, createEffectState, effectiveEffects, keepRunning, MOVE_CAP, needsFrame,
  drawFrame, pageAllowsEffects, prune, type EffectConfig, type GhostCursor
} from './pointerEffects'
import { CLICK_EFFECTS, MOVE_EFFECTS } from './pointerPrefs'
import { PRESET_THEMES } from '../themes/presets'
import { contrastRatio, type Rgb } from './colorContrast'
import { inkFor } from './pointerInk'

const config = (patch: Partial<EffectConfig> = {}): EffectConfig => ({
  reduced: false, dark: true, ink: '#4fd1a5', move: 'sparkle', click: 'firework',
  moveLevel: 3, clickLevel: 3, moveOnTerminal: false, clickOnTerminal: true, ...patch
})
const page = { hidden: false, focused: true }
const sprite = (hotspot: GhostCursor['hotspot']): GhostCursor => ({
  image: { complete: true, naturalWidth: 32 } as HTMLImageElement, hotspot
})

/** A pointer sweeping far each step, so every effect's distance threshold is passed */
function sweep(effect: typeof MOVE_EFFECTS[number], steps: number, visible = true) {
  const state = createEffectState()
  const arrow = sprite([2, 2])
  for (let i = 0; i < steps; i++) addMove(state, effect, (i % 2) * 400 + i, i * 3, 1000 + i, 3, '#4fd1a5', true, visible, () => arrow)
  return state
}

describe('pointer effect limits', () => {
  it('keeps the moving particles under their limits however fast the pointer goes', () => {
    for (const effect of MOVE_EFFECTS) {
      const state = sweep(effect, 2000)
      expect(state.move.length, effect).toBeLessThanOrEqual(MOVE_CAP)
    }
    expect(sweep('rainbow', 500).move.length).toBeLessThanOrEqual(44)
    expect(sweep('ghost', 500).move.length).toBe(16)
    expect(sweep('paw', 500).move.length).toBeLessThanOrEqual(30)
    expect(sweep('sparkle', 2000).move.length).toBe(MOVE_CAP)
  })

  it('keeps the press particles under their limit through a burst of clicks', () => {
    for (const effect of [...CLICK_EFFECTS, 'rs' as const]) {
      const state = createEffectState()
      for (let i = 0; i < 400; i++) addClick(state, effect, 100, 100, 1000 + i, 3, '#4fd1a5', true)
      expect(state.click.length, effect).toBeLessThanOrEqual(CLICK_CAP)
    }
  })

  it('adds nothing over a terminal while moving effects are off there, and nothing for none', () => {
    expect(sweep('sparkle', 50, false).move).toHaveLength(0)
    expect(sweep('none', 50).move).toHaveLength(0)
    const state = createEffectState()
    addClick(state, 'none', 10, 10, 0, 2, '#4fd1a5', true)
    expect(state.click).toHaveLength(0)
  })
})

it('draws each ghost with the image and hotspot used where it was recorded', () => {
  const state = createEffectState()
  const arrow = sprite([2, 2])
  const text = sprite([16, 16])
  addMove(state, 'ghost', 20, 40, 100, 2, '#4fd1a5', true, true, () => arrow)
  addMove(state, 'ghost', 70, 40, 112, 2, '#4fd1a5', true, true, () => text)
  const drawImage = vi.fn()
  const ctx = { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), drawImage } as unknown as CanvasRenderingContext2D
  drawFrame(ctx, state, 160, 90, 128, 16, config({ move: 'ghost', click: 'none' }))
  expect(drawImage.mock.calls).toEqual([[arrow.image, 18, 38], [text.image, 54, 24]])
})

it('draws and expires each new moving and press effect', () => {
  const moves = ['snow', 'notes', 'wind', 'firefly'] as const
  const clicks = ['square', 'orbit', 'confetti', 'shutter', 'bloom'] as const
  const paint = vi.fn()
  const path = vi.fn()
  const ctx = {
    clearRect: path, save: path, restore: path, translate: path, rotate: path, beginPath: path, moveTo: path, lineTo: path,
    quadraticCurveTo: path, closePath: path, arc: path, ellipse: path, rect: path, roundRect: path,
    stroke: paint, fill: paint, fillRect: paint
  } as unknown as CanvasRenderingContext2D
  for (const [move, click] of [...moves.map(move => [move, 'none'] as const), ...clicks.map(click => ['none', click] as const)]) {
    const state = createEffectState()
    const settings = config({ move, click })
    addMove(state, move, 70, 40, 100, 2, settings.ink, settings.dark, true)
    addClick(state, click, 70, 40, 100, 2, settings.ink, settings.dark)
    paint.mockClear()
    drawFrame(ctx, state, 160, 90, 280, 16, settings)
    expect(paint, `${move} / ${click}`).toHaveBeenCalled()
    prune(state, 2000)
    expect(needsFrame(state, settings)).toBe(false)
  }
})

it('draws legible word bubbles in every app palette and keeps them inside the canvas', () => {
  const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb
  for (const { id, colors } of PRESET_THEMES) {
    const settings = config({ ...inkFor(colors.accent, colors.bgPrimary), move: 'none', click: 'word' })
    const state = createEffectState()
    addClick(state, 'word', 0, 0, 100, settings.clickLevel, settings.ink, settings.dark)
    const ctx = {
      clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), scale: vi.fn(), translate: vi.fn(),
      beginPath: vi.fn(), roundRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(),
      measureText: () => ({ width: 24 }), fill: vi.fn(() => ctx.fillStyle), fillText: vi.fn(() => ctx.fillStyle), fillStyle: ''
    }
    drawFrame(ctx as unknown as CanvasRenderingContext2D, state, 160, 54, 440, 16, settings)
    const background = ctx.fill.mock.results[0]?.value
    const text = ctx.fillText.mock.results[0]?.value
    expect(contrastRatio(rgb(text), rgb(background)), id).toBeGreaterThanOrEqual(4.5)
    expect(ctx.translate, id).toHaveBeenCalledWith(23, 14)
  }
})

describe('when the effect loop stops', () => {
  it('stops once every particle has run its life', () => {
    const state = sweep('sparkle', 20)
    addClick(state, 'firework', 50, 50, 1000, 3, '#4fd1a5', true)
    expect(needsFrame(state, config())).toBe(true)
    prune(state, 1000 + 60_000)
    expect(state.move).toHaveLength(0)
    expect(state.click).toHaveLength(0)
    expect(needsFrame(state, config())).toBe(false)
  })

  it('does not ask for frames while the window is hidden or unfocused', () => {
    const state = sweep('sparkle', 20)
    expect(keepRunning(state, config(), page)).toBe(true)
    expect(keepRunning(state, config(), { hidden: true, focused: true })).toBe(false)
    expect(keepRunning(state, config(), { hidden: false, focused: false })).toBe(false)
    expect(pageAllowsEffects({ hidden: false, focused: true })).toBe(true)
  })

  it('keeps the spotlight going only while it is still easing toward the pointer', () => {
    const state = createEffectState()
    const spot = config({ move: 'spot' })
    expect(needsFrame(state, spot)).toBe(false)
    addMove(state, 'spot', 200, 120, 0, 2, '#4fd1a5', true, true)
    expect(needsFrame(state, spot)).toBe(true)
    Object.assign(state.spot, { x: 200, y: 120, a: 1 })
    expect(needsFrame(state, spot)).toBe(false)
    state.spot.visible = false
    expect(needsFrame(state, spot)).toBe(true)
  })

  it('hides the spotlight over a terminal at once, with no frames to run', () => {
    const state = createEffectState()
    const spot = config({ move: 'spot' })
    addMove(state, 'spot', 200, 120, 0, 2, '#4fd1a5', true, true)
    Object.assign(state.spot, { x: 180, a: 0.6 })
    addMove(state, 'spot', 300, 150, 1, 2, '#4fd1a5', true, false)
    expect(state.spot).toMatchObject({ x: 300, y: 150, a: 0, visible: false })
    expect(needsFrame(state, spot)).toBe(false)
  })

  it('forgets everything when cleared', () => {
    const state = sweep('bubble', 30)
    addMove(state, 'spot', 5, 5, 0, 2, '#4fd1a5', true, true)
    clearEffects(state)
    expect(state.move).toHaveLength(0)
    expect(state.spot.visible).toBe(false)
    expect(needsFrame(state, config({ move: 'spot' }))).toBe(false)
  })
})

describe('reduced motion', () => {
  it('keeps only the still spotlight and turns every press effect into one ring', () => {
    expect(effectiveEffects('sparkle', 'firework', true)).toEqual({ move: 'none', click: 'rs' })
    expect(effectiveEffects('spot', 'none', true)).toEqual({ move: 'spot', click: 'none' })
    expect(effectiveEffects('comet', 'ink', false)).toEqual({ move: 'comet', click: 'ink' })
  })
})
