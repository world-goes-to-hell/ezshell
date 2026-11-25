import {
  addClick, addMove, createEffectState, drawFrame, effectiveEffects, needsFrame, type EffectConfig
} from './lib/pointerEffects'
import type { DesktopPointerConfig, DesktopPointerFrame } from './lib/pointerDesktop'
import { ghostCursor } from './lib/pointerImages'

declare global {
  interface Window {
    pointerEffectsOverlay?: { onFrame(callback: (packet: DesktopPointerFrame) => void): () => void }
  }
}

const canvas = document.querySelector('canvas')!
const context = canvas.getContext('2d')!
let state = createEffectState()
let prefs: DesktopPointerConfig | undefined
let config: EffectConfig | undefined
let frame = 0
let last = 0

function release() {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  canvas.width = canvas.height = 0
}

function clear() {
  state = createEffectState()
  release()
}

function draw(time: number) {
  frame = 0
  if (!config) return
  const width = window.innerWidth
  const height = window.innerHeight
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const pixelsWide = Math.round(width * dpr)
  const pixelsHigh = Math.round(height * dpr)
  if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
    canvas.width = pixelsWide
    canvas.height = pixelsHigh
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawFrame(context, state, width, height, time, Math.max(0, Math.min(40, time - last)), config)
  last = time
  if (needsFrame(state, config)) frame = requestAnimationFrame(draw)
  else if (!state.spot.visible) release()
}

function wake() {
  if (frame || !config || (!state.spot.visible && !needsFrame(state, config))) return
  last = performance.now()
  frame = requestAnimationFrame(draw)
}

window.pointerEffectsOverlay?.onFrame(packet => {
  switch (packet.type) {
    case 'config': {
      prefs = packet.config
      const { move, click, reduced, dark, ink, moveLevel, clickLevel } = prefs
      config = { ...effectiveEffects(move, click, reduced), reduced, dark, ink, moveLevel, clickLevel,
        moveOnTerminal: true, clickOnTerminal: true }
      clear()
      break
    }
    case 'clear':
      clear()
      break
    case 'leave':
      // Finish old particles on this monitor and hide its spotlight immediately.
      state.spot.a = 0
      state.spot.visible = false
      state.lastX = state.lastY = -99
      if (!state.move.length && !state.click.length) release()
      break
    case 'move':
      if (config && prefs) {
        const { set, size } = prefs
        addMove(state, config.move, packet.x, packet.y, performance.now(), config.moveLevel, config.ink, config.dark, true,
          config.move === 'ghost' ? () => ghostCursor(set, 'default', set === 'system' ? 32 : size) : undefined)
        wake()
      }
      break
    case 'press':
      if (config) {
        addClick(state, config.click, packet.x, packet.y, performance.now(), config.clickLevel, config.ink, config.dark)
        wake()
      }
      break
  }
})

window.addEventListener('resize', wake)
document.addEventListener('visibilitychange', () => { if (document.hidden) clear() })
