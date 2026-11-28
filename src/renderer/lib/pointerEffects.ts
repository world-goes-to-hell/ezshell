// The mouse effects (designed in mockups/cursor-themes.html): particles made by pointer moves and
// presses, drawn on a 2D canvas. The window overlay (pointerAppearance.ts) and the settings cards'
// previews run the same code. Nothing here touches the DOM, so the limits are tested directly.
import { contrastingMonochrome } from './colorContrast'
import type { ClickEffect, EffectLevel, MoveEffect } from './pointerPrefs'

/** Particle limits: a fast pointer or a burst of clicks never grows the work past these */
export const MOVE_CAP = 120
export const CLICK_CAP = 150
const TRAIL_CAP = 44
const GHOST_CAP = 16
const PAW_CAP = 30
/** The trail limit of the effect windows outside the app: they add points between the positions main reads (pointerFill.ts) */
export const DESKTOP_TRAIL_CAP = 132

/** How far the pointer goes before a moving effect adds its next particles (the trails add every point) */
export const MOVE_DISTANCE = {
  sparkle: 12, bubble: 26, petal: 20, ghost: 16, pixel: 8, paw: 46,
  snow: 22, notes: 30, wind: 18, firefly: 16
} as const
const MOVE_LIFE = { snow: 1250, notes: 860, wind: 390, firefly: 1020 } as const
const CLICK_LIFE = { square: 660, orbit: 730, shutter: 510, bloom: 750 } as const

/* eslint-disable @typescript-eslint/no-explicit-any */
type Particle = { k: string; t0: number; life: number; [field: string]: any }
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface EffectState {
  move: Particle[]
  click: Particle[]
  spot: { x: number; y: number; tx: number; ty: number; a: number; visible: boolean }
  lastX: number
  lastY: number
  side: number
}

export interface GhostCursor {
  image: HTMLImageElement
  hotspot: readonly [number, number]
}

export interface EffectConfig {
  reduced: boolean
  dark: boolean
  /** The theme accent, made visible against the app background */
  ink: string
  move: MoveEffect | 'none'
  /** `rs`: the one still ring that replaces every press effect when motion is reduced */
  click: ClickEffect | 'rs'
  moveLevel: EffectLevel
  clickLevel: EffectLevel
  /** Whether a move or press over a terminal pane adds anything (read from the event target, see addMove) */
  moveOnTerminal: boolean
  clickOnTerminal: boolean
}

export function createEffectState(): EffectState {
  return { move: [], click: [], spot: { x: 0, y: 0, tx: 0, ty: 0, a: 0, visible: false }, lastX: -99, lastY: -99, side: 1 }
}

/**
 * The effects to run. With the system's reduced motion, moving effects stop except the spotlight
 * (it then follows without easing) and every press effect becomes one fading ring.
 */
export function effectiveEffects(move: MoveEffect, click: ClickEffect, reduced: boolean): { move: MoveEffect; click: ClickEffect | 'rs' } {
  if (!reduced) return { move, click }
  return { move: move === 'spot' ? 'spot' : 'none', click: click === 'none' ? 'none' : 'rs' }
}

const random = Math.random
const palette = (ink: string, dark: boolean) => (dark ? [ink, '#fff', '#ffe066', '#ff9ecb'] : [ink, '#ff9f1a', '#ff6b9d', '#4aa3ff'])
const BUBBLE_BLUE = '#5aaaf5'
const DARK_OUTLINE = '#000000'
const particlePaint = (color: string) => ({ color, outline: contrastingMonochrome(color) })
type ParticlePaint = ReturnType<typeof particlePaint>

export function rgba(hex: string, alpha: number): string {
  let value = hex.replace('#', '')
  if (value.length === 3) value = [...value].map(c => c + c).join('')
  const n = parseInt(value.slice(0, 6), 16)
  if (!Number.isFinite(n)) return `rgba(79,209,165,${alpha})`
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function put(list: Particle[], particle: Particle, cap: number) {
  if (list.length >= cap) list.shift()
  list.push(particle)
}

/**
 * A pointer move. `visible`: false while the pointer is over a terminal and moving effects are off
 * there: nothing new is added (what is already drifting may cross the terminal), and the spotlight
 * hides at once, already on the pointer, so no frames run for it.
 */
export function addMove(S: EffectState, effect: MoveEffect, x: number, y: number, now: number, level: EffectLevel, ink: string, dark: boolean, visible: boolean, ghost?: () => GhostCursor | null, trailCap = TRAIL_CAP): void {
  if (effect === 'spot') {
    const s = S.spot
    s.tx = x
    s.ty = y
    if (!visible) { Object.assign(s, { x, y, a: 0, visible: false }); return }
    if (!s.visible && s.a < 0.02) { s.x = x; s.y = y }
    s.visible = true
    return
  }
  if (effect === 'none' || !visible) return
  const A = S.move
  const L = level
  if (effect === 'rainbow' || effect === 'comet') {
    put(A, { k: 'tr', v: effect, x, y, t0: now, life: 480 }, trailCap)
    S.lastX = x; S.lastY = y
    return
  }
  const dx = x - S.lastX
  const dy = y - S.lastY
  if (Math.hypot(dx, dy) <= MOVE_DISTANCE[effect]) return
  const angle = (effect === 'paw' || effect === 'wind') && S.lastX > -90 ? Math.atan2(dy, dx) : 0
  S.lastX = x; S.lastY = y
  if (effect === 'sparkle') {
    const colors = palette(ink, dark)
    for (let i = 0; i < L; i++) {
      put(A, { k: 'sp', x: x + (random() - 0.5) * 8, y: y + (random() - 0.5) * 8, vx: (random() - 0.5) * 0.7, vy: 0.15 + random() * 0.5,
        t0: now, life: 520 + random() * 420, size: 3 + random() * (2 + L * 1.6), rot: random() * 6, paint: particlePaint(colors[random() * 4 | 0]) }, MOVE_CAP)
    }
  } else if (effect === 'bubble') {
    for (let i = 0, n = L > 2 ? 2 : 1; i < n; i++) {
      put(A, { k: 'bu', x: x + (random() - 0.5) * 10, y, vx: (random() - 0.5) * 0.3, vy: -(0.35 + random() * 0.5), ph: random() * 6,
        r: 4 + random() * (4 + L * 2), t0: now, life: 950 + random() * 500 }, MOVE_CAP)
    }
  } else if (effect === 'petal') {
    for (let i = 0, n = L > 1 ? 2 : 1; i < n; i++) {
      put(A, { k: 'pe', x: x + (random() - 0.5) * 10, y: y + (random() - 0.5) * 6, vx: (random() - 0.5) * 0.5, vy: 0.35 + random() * 0.45,
        ph: random() * 6, rot: random() * 6, vr: (random() - 0.5) * 0.08, size: 3.5 + random() * (2 + L),
        color: random() < 0.5 ? '#ff9fc0' : '#ffd0e0', t0: now, life: 1100 + random() * 600 }, MOVE_CAP)
    }
  } else if (effect === 'ghost') {
    const cursor = ghost?.()
    if (cursor) put(A, { k: 'gh', x, y, t0: now, life: 240 + L * 70, cursor }, GHOST_CAP)
  } else if (effect === 'pixel') {
    for (let i = 0; i < L; i++) {
      put(A, { k: 'px', x: x + (random() - 0.5) * 8, y: y + (random() - 0.5) * 8, vx: (random() - 0.5) * 0.8, vy: -0.2 + random() * 0.6,
        s: 2 * (1 + (random() * 2 | 0)), paint: particlePaint([ink, dark ? '#fff' : '#222', '#ff3b6b', '#ffd23f'][random() * 4 | 0]),
        t0: now, life: 380 + random() * 260 }, MOVE_CAP)
    }
  } else if (effect === 'paw') {
    S.side *= -1
    put(A, { k: 'pw', x: x + Math.cos(angle + 1.5708) * 7 * S.side, y: y + Math.sin(angle + 1.5708) * 7 * S.side, ang: angle,
      sc: 0.8 + L * 0.2, t0: now, life: 1200 }, PAW_CAP)
  } else {
    put(A, { k: effect, x, y, ang: angle, ph: random() * Math.PI * 2, s: 3 + L + random() * 2,
      t0: now, life: MOVE_LIFE[effect] }, MOVE_CAP)
  }
}

export function addClick(S: EffectState, effect: ClickEffect | 'rs', x: number, y: number, now: number, level: EffectLevel, ink: string, dark: boolean): void {
  const A = S.click
  const colors = palette(ink, dark)
  const L = level
  switch (effect) {
    case 'none': return
    case 'rs': put(A, { k: 'rs', x, y, t0: now, life: 380 }, CLICK_CAP); break
    case 'ripple': put(A, { k: 'rp', x, y, t0: now, life: 700 }, CLICK_CAP); break
    case 'pulse': for (let i = 0; i < 3; i++) put(A, { k: 'pl', x, y, t0: now + i * 130, life: 620 }, CLICK_CAP); break
    case 'press': put(A, { k: 'pr', x, y, t0: now, life: 420 }, CLICK_CAP); break
    case 'heart':
      for (let i = 0, n = 4 + L * 3; i < n; i++) {
        put(A, { k: 'h', x: x + (random() - 0.5) * 10, y, vx: (random() - 0.5) * 1.5, vy: -(0.7 + random() * 1.1), ph: random() * 6,
          size: 7 + random() * (4 + L * 2), paint: particlePaint(colors[random() * 4 | 0]), t0: now, life: 850 + random() * 500 }, CLICK_CAP)
      }
      break
    case 'firework':
      for (let i = 0, n = 10 + L * 5; i < n; i++) {
        const angle = i / n * 6.283 + random() * 0.3
        const speed = 1.6 + random() * (1.2 + L * 0.4)
        put(A, { k: 'fw', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          paint: particlePaint([ink, '#ff6b9d', '#ffd23f', '#4aa3ff', '#4fd1a5'][random() * 5 | 0]), t0: now, life: 700 + random() * 300 }, CLICK_CAP)
      }
      break
    case 'starpop':
      for (let i = 0, n = 5 + L * 2; i < n; i++) {
        const angle = random() * 6.283
        const speed = 1.4 + random() * 1.8
        put(A, { k: 'st', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: 5 + random() * (3 + L * 1.5), rot: random() * 6,
          paint: particlePaint(['#ffd23f', ink, '#ff9ecb'][random() * 3 | 0]), t0: now, life: 560 + random() * 200 }, CLICK_CAP)
      }
      break
    case 'word': put(A, { k: 'wd', x, y, tx: ['톡!', '뿅!', '콕!'][random() * 3 | 0], t0: now, life: 850 }, CLICK_CAP); break
    case 'ink': {
      const blobs = []
      for (let i = 0, n = 4 + L * 2; i < n; i++) blobs.push({ dx: (random() - 0.5) * (26 + L * 8), dy: (random() - 0.5) * (26 + L * 8), r: 6 + random() * (8 + L * 3) })
      put(A, { k: 'ik', x, y, bl: blobs, t0: now, life: 800 }, CLICK_CAP)
      break
    }
    case 'square':
    case 'orbit':
    case 'shutter':
    case 'bloom':
      put(A, { k: effect, x, y, t0: now, life: CLICK_LIFE[effect] }, CLICK_CAP)
      break
    case 'confetti': {
      const colors = ['#ff746d', '#ffd56a', '#55d9c4', '#879aff', '#e3a2fa']
      const count = 6 + L * 3
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI * (0.12 + 0.76 * i / (count - 1))
        const speed = 1.4 + random() * (1.2 + L * 0.25)
        put(A, { k: 'confetti', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, spin: (random() - 0.5) * 10,
          ph: random() * Math.PI * 2, s: 2.5 + L + random() * 2, paint: particlePaint(colors[i % colors.length]),
          t0: now, life: 630 + random() * 260 }, CLICK_CAP)
      }
      break
    }
  }
}

// A thin contrasting outline keeps the colored shape visible over a differently themed pane.
function strokeEffect(ctx: CanvasRenderingContext2D, width: number, color: string, outline: string, alpha: number) {
  ctx.globalAlpha = alpha * 0.72
  ctx.lineWidth = width + 1.6
  ctx.strokeStyle = outline
  ctx.stroke()
  ctx.globalAlpha = alpha
  ctx.lineWidth = width
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.globalAlpha = 1
}

function fillEffect(ctx: CanvasRenderingContext2D, color: string, outline: string, width = 1.2) {
  ctx.strokeStyle = rgba(outline, 0.72)
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.fillStyle = color
  ctx.fill()
}

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, paint: ParticlePaint, alpha: number) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(s / 12, s / 12)
  ctx.beginPath(); ctx.moveTo(0, 10)
  ctx.bezierCurveTo(-12, 2, -12, -8, -5.5, -8); ctx.bezierCurveTo(-2.5, -8, -0.5, -6, 0, -4)
  ctx.bezierCurveTo(0.5, -6, 2.5, -8, 5.5, -8); ctx.bezierCurveTo(12, -8, 12, 2, 0, 10)
  ctx.closePath(); fillEffect(ctx, paint.color, paint.outline, 14.4 / s); ctx.restore()
}

function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, paint: ParticlePaint, alpha: number, rotation: number) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(rotation)
  ctx.beginPath(); ctx.moveTo(0, -s)
  ctx.quadraticCurveTo(0, 0, s, 0); ctx.quadraticCurveTo(0, 0, 0, s); ctx.quadraticCurveTo(0, 0, -s, 0); ctx.quadraticCurveTo(0, 0, 0, -s)
  ctx.closePath(); fillEffect(ctx, paint.color, paint.outline); ctx.restore()
}

function drawMove(ctx: CanvasRenderingContext2D, S: EffectState, now: number, dt: number, c: EffectConfig, outline: string) {
  const ink = c.ink
  const L = c.moveLevel
  const f = dt / 16
  const trail: Particle[] = []
  for (const it of S.move) {
    const age = now - it.t0
    const u = age / it.life
    switch (it.k) {
      case 'tr': trail.push(it); break
      case 'sp':
        it.x += it.vx * f; it.y += it.vy * f
        drawSparkle(ctx, it.x, it.y, it.size * (1 - u * 0.5), it.paint, 1 - u, it.rot + u * 2)
        break
      case 'bu':
        it.x += (Math.sin(age / 260 + it.ph) * 0.35 + it.vx) * f; it.y += it.vy * f
        if (u < 0.86) {
          ctx.beginPath(); ctx.arc(it.x, it.y, it.r, 0, 6.283); ctx.fillStyle = 'rgba(124,196,255,.16)'; ctx.fill()
          strokeEffect(ctx, 1.4, BUBBLE_BLUE, DARK_OUTLINE, 0.9)
          ctx.beginPath(); ctx.arc(it.x, it.y, it.r * 0.62, 3.6, 4.5); ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.stroke()
        } else {
          const q = (u - 0.86) / 0.14
          ctx.beginPath(); ctx.arc(it.x, it.y, it.r * (1 + q * 0.7), 0, 6.283)
          strokeEffect(ctx, 1.4 * (1 - q) + 0.2, BUBBLE_BLUE, DARK_OUTLINE, 0.9 * (1 - q))
          for (let i = 0; i < 6; i++) {
            const a = i * 1.047
            const rr = it.r * (1 + q * 1.4)
            ctx.beginPath(); ctx.arc(it.x + Math.cos(a) * rr, it.y + Math.sin(a) * rr, 1.3, 0, 6.283)
            ctx.fillStyle = `rgba(90,170,245,${1 - q})`; ctx.fill()
          }
        }
        break
      case 'pe':
        it.x += (it.vx + Math.sin(age / 240 + it.ph) * 0.5) * f; it.y += it.vy * f; it.rot += it.vr * f
        ctx.save(); ctx.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1; ctx.translate(it.x, it.y); ctx.rotate(it.rot)
        ctx.beginPath(); ctx.ellipse(0, 0, it.size, it.size * 0.55, 0, 0, 6.283)
        fillEffect(ctx, it.color, DARK_OUTLINE); ctx.restore()
        break
      case 'gh': {
        const { image, hotspot } = it.cursor as GhostCursor
        if (!image.complete || !image.naturalWidth) break
        ctx.globalAlpha = 0.65 * (1 - u)
        ctx.drawImage(image, it.x - hotspot[0], it.y - hotspot[1])
        ctx.globalAlpha = 1
        break
      }
      case 'px':
        it.x += it.vx * f; it.y += it.vy * f; it.vy += 0.03 * f
        ctx.globalAlpha = u > 0.6 ? 0.5 : 1
        ctx.beginPath(); ctx.rect(Math.round(it.x / 2) * 2, Math.round(it.y / 2) * 2, it.s, it.s)
        fillEffect(ctx, it.paint.color, it.paint.outline, 2); ctx.globalAlpha = 1
        break
      case 'pw':
        ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.ang + 1.5708); ctx.scale(it.sc, it.sc)
        ctx.globalAlpha = u < 0.65 ? 0.85 : 0.85 * (1 - (u - 0.65) / 0.35)
        ctx.beginPath(); ctx.ellipse(0, 3, 4.2, 3.4, 0, 0, 6.283); ctx.closePath()
        for (const [a, b, r] of [[-4.4, -1.6, 1.7], [-1.5, -4.6, 1.8], [1.5, -4.6, 1.8], [4.4, -1.6, 1.7]]) {
          ctx.moveTo(a + r, b); ctx.arc(a, b, r, 0, 6.283); ctx.closePath()
        }
        fillEffect(ctx, c.dark ? '#ec96b2' : '#cd6487', DARK_OUTLINE)
        ctx.restore()
        break
      case 'snow': {
        ctx.save()
        ctx.translate(it.x + Math.sin(u * 6 + it.ph) * 5, it.y + u * 24)
        ctx.rotate(it.ph + u)
        ctx.beginPath()
        for (let i = 0; i < 3; i++) {
          const a = i * Math.PI / 3
          const x = Math.cos(a) * it.s
          const y = Math.sin(a) * it.s
          ctx.moveTo(-x, -y); ctx.lineTo(x, y)
        }
        strokeEffect(ctx, 1.4, c.dark ? '#cceaff' : '#367599', c.dark ? DARK_OUTLINE : '#fff', 0.95 * (1 - u))
        ctx.restore()
        break
      }
      case 'notes': {
        const r = it.s
        ctx.save()
        ctx.translate(it.x + Math.sin(u * 4 + it.ph) * 4, it.y - u * 22)
        ctx.rotate(Math.sin(it.ph) * 0.22)
        ctx.globalAlpha = 1 - u
        ctx.beginPath()
        ctx.ellipse(-r * 0.22, r * 0.38, r * 0.49, r * 0.34, -0.35, 0, Math.PI * 2)
        ctx.moveTo(r * 0.19, r * 0.36); ctx.lineTo(r * 0.19, -r)
        ctx.quadraticCurveTo(r * 0.39, -r * 0.65, r * 0.8, -r * 0.58)
        ctx.lineTo(r * 0.8, -r * 0.3); ctx.quadraticCurveTo(r * 0.5, -r * 0.38, r * 0.34, -r * 0.52)
        ctx.lineTo(r * 0.34, r * 0.36); ctx.closePath()
        fillEffect(ctx, ink, outline)
        ctx.restore()
        break
      }
      case 'wind':
        ctx.save()
        ctx.translate(it.x, it.y)
        ctx.rotate(it.ang)
        ctx.lineCap = 'round'
        ctx.beginPath()
        for (let i = -1; i <= 1; i++) {
          const x = -u * 13 - Math.abs(i) * 4
          const y = i * 4
          ctx.moveTo(x - it.s * (i === 0 ? 2.8 : 1.6), y)
          ctx.quadraticCurveTo(x - it.s, y, x, y - 2)
        }
        strokeEffect(ctx, 1.2 + L * 0.25, ink, outline, 0.8 * (1 - u))
        ctx.restore()
        break
      case 'firefly': {
        const x = it.x + (Math.sin(u * 7 + it.ph) - Math.sin(it.ph)) * 7
        const y = it.y - u * 25
        const light = (0.65 + 0.35 * Math.sin(u * 9 + it.ph)) * (1 - u)
        const color = c.dark ? '#d5fb75' : '#617a26'
        ctx.beginPath(); ctx.arc(x, y, it.s * 0.95, 0, Math.PI * 2)
        ctx.fillStyle = rgba(color, light * 0.22); ctx.fill()
        ctx.globalAlpha = light
        ctx.beginPath(); ctx.arc(x, y, it.s * 0.31, 0, Math.PI * 2)
        fillEffect(ctx, color, c.dark ? DARK_OUTLINE : '#fff')
        ctx.globalAlpha = 1
        break
      }
    }
  }
  if (trail.length > 1) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    const comet = trail[0].v === 'comet'
    const inner = c.dark ? '#fff' : ink
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]
      const b = trail[i]
      const k = 1 - (now - b.t0) / b.life
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
      if (comet) {
        ctx.lineWidth = (5 + L * 3) * k; ctx.strokeStyle = rgba(ink, 0.28 * k); ctx.stroke()
        strokeEffect(ctx, (1.4 + L * 0.9) * k, inner, c.dark ? DARK_OUTLINE : outline, Math.min(1, k * 1.2))
      } else {
        const color = `hsl(${(b.t0 * 0.25 + i * 14) % 360},95%,62%)`
        strokeEffect(ctx, (2 + L * 2.2) * k, color, DARK_OUTLINE, 0.9 * k)
      }
    }
  }
  if (c.move === 'spot') {
    const s = S.spot
    if (c.reduced) {
      s.x = s.tx; s.y = s.ty; s.a = s.visible ? 1 : 0
    } else {
      s.x += (s.tx - s.x) * (1 - Math.exp(-dt / 55)); s.y += (s.ty - s.y) * (1 - Math.exp(-dt / 55))
      s.a += ((s.visible ? 1 : 0) - s.a) * (1 - Math.exp(-dt / 90))
    }
    if (s.a > 0.01) {
      const R = 30 + L * 11
      const glow = ctx.createRadialGradient(s.x, s.y, R * 0.2, s.x, s.y, R * 1.7)
      glow.addColorStop(0, rgba(ink, 0)); glow.addColorStop(0.55, rgba(ink, 0.22 * s.a)); glow.addColorStop(1, rgba(ink, 0))
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(s.x, s.y, R * 1.7, 0, 6.283); ctx.fill()
      ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, 6.283)
      strokeEffect(ctx, 2.5, ink, outline, 0.9 * s.a)
    }
  }
}

function drawClick(ctx: CanvasRenderingContext2D, S: EffectState, width: number, height: number, now: number, dt: number, c: EffectConfig, outline: string) {
  const ink = c.ink
  const L = c.clickLevel
  const f = dt / 16
  for (const it of S.click) {
    const age = now - it.t0
    if (age < 0) continue
    const u = age / it.life
    switch (it.k) {
      case 'rs':
        ctx.beginPath(); ctx.arc(it.x, it.y, 14, 0, 6.283)
        strokeEffect(ctx, 2, ink, outline, 0.8 * (1 - u))
        break
      case 'rp': {
        [0, 0.18].forEach((delay, i) => {
          const q = Math.max(0, (u - delay) / (1 - delay))
          if (q <= 0) return
          const e = 1 - Math.pow(1 - q, 3)
          ctx.beginPath(); ctx.arc(it.x, it.y, 6 + e * (34 + L * 16) * (i ? 0.65 : 1), 0, 6.283)
          strokeEffect(ctx, (i ? 1.5 : 2.5) * (1 - q * 0.6), ink, outline, 0.85 * (1 - q))
        })
        const e = 1 - Math.pow(1 - u, 3)
        ctx.beginPath(); ctx.arc(it.x, it.y, 4 + e * 10, 0, 6.283); ctx.fillStyle = rgba(ink, 0.25 * (1 - u)); ctx.fill()
        break
      }
      case 'pl': {
        const e = 1 - Math.pow(1 - u, 2)
        ctx.beginPath(); ctx.arc(it.x, it.y, 8 + e * (26 + L * 12), 0, 6.283)
        strokeEffect(ctx, 4.5 * (1 - u) + 0.5, ink, outline, 0.75 * (1 - u))
        break
      }
      case 'pr': {
        const e = Math.min(1, u * 1.7)
        const r = 5 + (1 - e) * 24
        const a = u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1
        ctx.beginPath()
        for (let d = 0; d < 4; d++) {
          const cx = Math.cos(d * 1.5708)
          const sy = Math.sin(d * 1.5708)
          ctx.moveTo(it.x + cx * r, it.y + sy * r); ctx.lineTo(it.x + cx * (r + 8), it.y + sy * (r + 8))
        }
        ctx.lineCap = 'round'
        strokeEffect(ctx, 2.2, ink, outline, a)
        ctx.globalAlpha = a
        ctx.beginPath(); ctx.arc(it.x, it.y, 1.8, 0, 6.283); fillEffect(ctx, ink, outline)
        ctx.globalAlpha = 1
        break
      }
      case 'h':
        it.x += (it.vx + Math.sin((age + it.ph * 100) / 180) * 0.35) * f; it.y += it.vy * f
        drawHeart(ctx, it.x, it.y, it.size * (0.5 + 0.5 * Math.min(1, u / 0.15)), it.paint, u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1)
        break
      case 'fw':
        it.x += it.vx * f; it.y += it.vy * f; it.vy += 0.045 * f
        ctx.beginPath(); ctx.moveTo(it.x - it.vx * 2.6, it.y - it.vy * 2.6); ctx.lineTo(it.x, it.y)
        ctx.lineCap = 'round'
        strokeEffect(ctx, 2.4 * (1 - u * 0.5), it.paint.color, it.paint.outline, 1 - u)
        break
      case 'st': {
        it.x += it.vx * (1 - u) * f; it.y += it.vy * (1 - u) * f
        const R = it.size * (1 - u * 0.4)
        ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.rot + u * 3); ctx.globalAlpha = 1 - u * u
        ctx.beginPath()
        for (let i = 0; i < 10; i++) {
          const a = -1.5708 + i * 0.6283
          const rr = i % 2 ? R * 0.45 : R
          ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
        }
        ctx.closePath(); fillEffect(ctx, it.paint.color, it.paint.outline); ctx.restore()
        break
      }
      case 'wd': {
        const scale = u < 0.2 ? u / 0.2 * 1.2 : u < 0.3 ? 1.2 - (u - 0.2) / 0.1 * 0.2 : 1
        ctx.save()
        ctx.font = '700 14px "Malgun Gothic","Segoe UI",sans-serif'
        const w = ctx.measureText(it.tx).width + 18
        const side = w * scale / 2 + 2
        const x = Math.max(side, Math.min(width - side, it.x))
        const y = Math.max(12 * scale + 2, Math.min(height - 18 * scale - 2, it.y - 24 - u * 14))
        ctx.translate(x, y); ctx.scale(scale, scale)
        ctx.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(-w / 2, -12, w, 24, 12); else ctx.rect(-w / 2, -12, w, 24)
        ctx.moveTo(-4, 11.5); ctx.lineTo(4, 11.5); ctx.lineTo(0, 18); ctx.closePath()
        fillEffect(ctx, ink, outline, 2)
        ctx.fillStyle = outline; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(it.tx, 0, 1)
        ctx.restore()
        break
      }
      case 'ik': {
        const e = 1 - Math.pow(1 - u, 3)
        ctx.fillStyle = rgba(ink, 0.42 * (1 - u))
        for (const b of it.bl) { ctx.beginPath(); ctx.arc(it.x + b.dx * e, it.y + b.dy * e, b.r * (0.3 + e * 0.9), 0, 6.283); ctx.fill() }
        ctx.globalAlpha = 0.5 * (1 - u)
        ctx.beginPath(); ctx.arc(it.x, it.y, 10 + e * 14, 0, 6.283)
        fillEffect(ctx, ink, outline)
        ctx.globalAlpha = 1
        break
      }
      case 'square': {
        const r = 5 + (1 - (1 - u) ** 3) * (16 + L * 4)
        ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(0.12 + u * 0.4)
        ctx.beginPath(); ctx.roundRect(-r, -r, r * 2, r * 2, 3)
        strokeEffect(ctx, 1.8 + (1 - u) * 1.5, ink, outline, 1 - u)
        ctx.restore()
        break
      }
      case 'orbit': {
        const r = (7 + L * 4) * (0.55 + 0.65 * u)
        ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(-0.42 + u * 0.6)
        ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.56, 0, 0, Math.PI * 2)
        strokeEffect(ctx, 1.35, ink, outline, 0.6 * (1 - u))
        ctx.globalAlpha = 1 - u
        for (let i = 0; i < 3; i++) {
          const angle = (1.55 * u + i / 3) * Math.PI * 2
          ctx.beginPath(); ctx.arc(r * Math.cos(angle), r * 0.56 * Math.sin(angle), 1.8 + L * 0.5, 0, Math.PI * 2)
          fillEffect(ctx, i === 0 ? ink : c.dark ? '#e9f1ff' : '#3e6395', outline)
        }
        ctx.restore()
        break
      }
      case 'confetti': {
        const ticks = age / 16
        const w = it.s * (0.2 + 0.8 * Math.abs(Math.cos(it.ph + u * 12)))
        ctx.save()
        ctx.translate(it.x + it.vx * ticks, it.y + it.vy * ticks + 0.045 * ticks * ticks)
        ctx.rotate(it.ph + u * it.spin)
        ctx.globalAlpha = 1 - u
        ctx.beginPath(); ctx.rect(-w / 2, -it.s * 0.7, w, it.s * 1.4)
        fillEffect(ctx, it.paint.color, it.paint.outline)
        ctx.restore()
        break
      }
      case 'shutter': {
        const r = 9 + L * 2 + 9 * (1 - Math.min(1, u * 4))
        const arm = 5 + L
        ctx.beginPath()
        for (const x of [-1, 1]) {
          for (const y of [-1, 1]) {
            ctx.moveTo(it.x + x * (r - arm), it.y + y * r)
            ctx.lineTo(it.x + x * r, it.y + y * r)
            ctx.lineTo(it.x + x * r, it.y + y * (r - arm))
          }
        }
        strokeEffect(ctx, 2, ink, outline, 1 - u)
        ctx.fillStyle = rgba(ink, 0.24 * (1 - u) ** 5)
        ctx.fillRect(it.x - r + 3, it.y - r + 3, 2 * r - 6, 2 * r - 6)
        break
      }
      case 'bloom': {
        const e = 1 - (1 - u) ** 3
        const r = 2 + e * (4 + L * 2)
        const distance = 3 + e * (8 + L)
        ctx.save()
        ctx.globalAlpha = 1 - u
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3 + u * 0.35
          ctx.beginPath()
          ctx.ellipse(it.x + Math.cos(a) * distance, it.y + Math.sin(a) * distance, r, r * 0.53, a, 0, Math.PI * 2)
          fillEffect(ctx, i % 2 ? '#fa94b7' : '#e874a8', DARK_OUTLINE)
        }
        ctx.beginPath(); ctx.arc(it.x, it.y, 2 + e * 2, 0, Math.PI * 2)
        fillEffect(ctx, '#ffda76', DARK_OUTLINE)
        ctx.restore()
        break
      }
    }
  }
}

/** Drops finished particles (also when nothing is drawn, so the lists cannot grow while hidden) */
export function prune(S: EffectState, now: number): void {
  S.move = S.move.filter(it => now - it.t0 < it.life)
  S.click = S.click.filter(it => now - it.t0 < it.life)
}

/**
 * One frame: clears the canvas and draws what is left. Nothing is cut out where terminals are: a
 * terminal can be covered (chat view, dialogs, the command palette, menus), so only where the pointer
 * was when a particle started decides (addMove / the press handler).
 */
export function drawFrame(ctx: CanvasRenderingContext2D, S: EffectState, width: number, height: number, now: number, dt: number, c: EffectConfig): void {
  ctx.clearRect(0, 0, width, height)
  prune(S, now)
  const step = Math.max(0, dt)
  const outline = contrastingMonochrome(c.ink)
  ctx.save(); drawMove(ctx, S, now, step, c, outline); ctx.restore()
  ctx.save(); drawClick(ctx, S, width, height, now, step, c, outline); ctx.restore()
}

function spotMoving(S: EffectState, c: EffectConfig): boolean {
  if (c.move !== 'spot') return false
  const s = S.spot
  if (c.reduced) return s.a !== (s.visible ? 1 : 0)
  return Math.abs(s.x - s.tx) > 0.3 || Math.abs(s.y - s.ty) > 0.3 || Math.abs(s.a - (s.visible ? 1 : 0)) > 0.01
}

/** Whether another frame is needed. False: the loop stops until the next pointer event. */
export function needsFrame(S: EffectState, c: EffectConfig): boolean {
  return S.move.length > 0 || S.click.length > 0 || spotMoving(S, c)
}

/** The page as the loop sees it: no frames while the window is hidden or another window has the focus */
export interface PageState { hidden: boolean; focused: boolean }

export const pageAllowsEffects = (page: PageState) => !page.hidden && page.focused

/** Whether the loop asks for the next frame */
export function keepRunning(S: EffectState, c: EffectConfig, page: PageState): boolean {
  return pageAllowsEffects(page) && needsFrame(S, c)
}

/** Forgets everything on screen (window hidden or unfocused, effect changed) */
export function clearEffects(S: EffectState): void {
  S.move = []
  S.click = []
  S.spot.visible = false
  S.spot.a = 0
}
