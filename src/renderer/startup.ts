import iconMarkup from './assets/app-icon.svg?raw'
import { createStartupPalette, mixRgb } from './lib/startupPalette'
import { useThemeStore } from './stores/themeStore'
import type { ThemeDefinition } from './types/theme'

const width = 540
const height = 270
const pitch = 4.5
const logoSize = 468
const centerX = width / 2
const centerY = height / 2
const logoLeft = (width - logoSize) / 2 - 11
const promptEnd = logoLeft + logoSize * 100 / 256
const cursorLeft = 102 * pitch
const assemblyDuration = 1740
const cursorBeat = 280
const cursorOnTime = 138
const blinkCount = 3
const introDuration = assemblyDuration + cursorBeat * (blinkCount - 1) + cursorOnTime
const scatterDuration = 540
const fadeDuration = 280
const defaultBackdrop = '#1c1d21'

type LogoDot = {
  x: number
  y: number
  coverage: number
  grain: number
  targetAngle: number
  targetRadius: number
  orbitRadius: number
  travel: number
  gatherAt: number
  settleAt: number
  cursor: boolean
  scatterAngle: number
  scatterDistance: number
  scatterDelay: number
}

type PaintLogo = (introElapsed: number, scatterProgress?: number, backdropColor?: string, coverOpacity?: number) => void

const canvas = document.querySelector<HTMLCanvasElement>('.startup-logo')!
const backdrop = document.querySelector<HTMLCanvasElement>('.startup-backdrop')!
const logo = new DOMParser().parseFromString(iconMarkup, 'image/svg+xml').documentElement
// Use the actual prompt mark from the app icon without its rounded backplate.
logo.querySelector(':scope > rect')?.remove()

function showStaticLogo() {
  logo.setAttribute('viewBox', '0 64 256 128')
  logo.setAttribute('class', 'startup-logo startup-logo-fallback')
  logo.setAttribute('aria-hidden', 'true')
  canvas.replaceWith(logo)
}

function smoothstep(start: number, end: number, value: number) {
  const progress = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return progress * progress * (3 - 2 * progress)
}

function mix(from: number, to: number, progress: number) {
  return from + (to - from) * progress
}

function randomDot(seed: number) {
  const first = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b)
  const mixed = Math.imul(first ^ (first >>> 16), 0x45d9f3b)
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 0x100000000
}

function createBackdropPainter(viewWidth: number, viewHeight: number) {
  const columns = Math.max(1, Math.ceil(viewWidth / 7))
  const rows = Math.max(1, Math.ceil(viewHeight / 7))
  backdrop.width = columns
  backdrop.height = rows
  const context = backdrop.getContext('2d')
  if (!context) throw new Error('Startup backdrop is unavailable')

  const field = context.createImageData(columns, rows)
  const arrivals = new Float32Array(columns * rows)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column
      const x = (column + .5) / columns - .5
      const y = (row + .5) / rows - .5
      const distance = Math.hypot(x, y) * Math.SQRT2
      arrivals[index] = .13 + .59 * distance ** .86 + .17 * randomDot(index + 101)
        + .044 * Math.sin(x * 31 + y * 18)
    }
  }

  return (progress: number, color: string, opacity: number) => {
    context.clearRect(0, 0, columns, rows)
    if (progress <= 0 || opacity <= 0) return

    context.fillStyle = defaultBackdrop
    context.fillStyle = color
    if (progress >= 1) {
      context.globalAlpha = opacity
      context.fillRect(0, 0, columns, rows)
      context.globalAlpha = 1
      return
    }
    for (let index = 0; index < arrivals.length; index++) {
      const arrival = arrivals[index]
      field.data[index * 4 + 3] = 255 * smoothstep(arrival - .12, arrival + .10, progress)
    }
    context.putImageData(field, 0, 0)
    context.globalCompositeOperation = 'source-in'
    context.fillRect(0, 0, columns, rows)
    context.globalCompositeOperation = 'source-over'
  }
}

async function createLogoPainter(theme: ThemeDefinition): Promise<PaintLogo> {
  const dotsAcross = width / pitch
  const dotsDown = height / pitch
  const samples = 3
  const mask = document.createElement('canvas')
  mask.width = dotsAcross * samples
  mask.height = dotsDown * samples
  const sample = mask.getContext('2d')
  const context = canvas.getContext('2d')
  if (!sample || !context) throw new Error('Startup canvas is unavailable')

  const palette = createStartupPalette(theme)
  canvas.style.setProperty('--startup-outline', palette.outline)
  canvas.style.setProperty('--startup-glow', `rgb(${palette.prompt.join(' ')} / 34%)`)

  const logoUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(logo)], {
    type: 'image/svg+xml',
  }))
  const image = new Image()
  try {
    image.src = logoUrl
    await image.decode()
    const scale = samples / pitch
    sample.drawImage(image, logoLeft * scale, (height - logoSize) * scale / 2,
      logoSize * scale, logoSize * scale)
    sample.fillRect(cursorLeft * scale, 14 * pitch * scale, 3 * pitch * scale, 32 * pitch * scale)
  } finally {
    URL.revokeObjectURL(logoUrl)
  }

  const alpha = sample.getImageData(0, 0, mask.width, mask.height).data
  const dots: LogoDot[] = []
  for (let row = 0; row < dotsDown; row++) {
    for (let column = 0; column < dotsAcross; column++) {
      let coverage = 0
      for (let dy = 0; dy < samples; dy++) {
        for (let dx = 0; dx < samples; dx++) {
          const pixel = (row * samples + dy) * mask.width + column * samples + dx
          coverage += alpha[pixel * 4 + 3]
        }
      }
      coverage /= 255 * samples * samples
      if (coverage < .08) continue

      const seed = (row * dotsAcross + column) * 8
      const grain = randomDot(seed + 1)
      const x = (column + .5) * pitch
      const y = (row + .5) * pitch
      // The logo's two paths are separated by a gap in the viewBox at x = 100.
      const prompt = x < promptEnd
      const gatherAt = (prompt ? .20 : .38 + .12 * x / width) + .12 * randomDot(seed + 2)
      const targetAngle = Math.atan2(y - centerY, x - centerX)
      dots.push({
        x, y, coverage, grain, gatherAt,
        targetAngle,
        targetRadius: Math.hypot(x - centerX, y - centerY),
        orbitRadius: mix(105, 246, Math.sqrt(randomDot(seed + 3))),
        travel: 3.4 + randomDot(seed + 4) * Math.PI * 2,
        settleAt: gatherAt + .29 + .095 * randomDot(seed + 5),
        cursor: x > cursorLeft,
        scatterAngle: targetAngle + mix(-.95, 1.15, randomDot(seed + 6)),
        scatterDistance: mix(42, 122, randomDot(seed + 7)),
        scatterDelay: .075 * randomDot(seed + 8),
      })
    }
  }
  if (!dots.some(dot => !dot.cursor)) throw new Error('Startup logo could not be sampled')

  const { width: viewWidth, height: viewHeight } = canvas.getBoundingClientRect()
  const density = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(4_000_000 / (viewWidth * viewHeight)))
  canvas.width = Math.round(viewWidth * density)
  canvas.height = Math.round(viewHeight * density)
  const logoScale = Math.min(1, viewWidth / width, viewHeight / height)
  const scale = density * logoScale
  const burstX = 1.35 * viewWidth / (width * logoScale)
  const burstY = 1.10 * viewHeight / (height * logoScale)
  const offsetX = (canvas.width - width * scale) / 2
  const offsetY = (canvas.height - height * scale) / 2
  const paintBackdrop = createBackdropPainter(viewWidth, viewHeight)

  return (introElapsed, scatterProgress = 0, backdropColor = theme.colors.bgPrimary, coverOpacity = 1) => {
    const progress = Math.min(1, introElapsed / assemblyDuration)
    const cursorElapsed = introElapsed - assemblyDuration
    // Leave the third pulse lit into the scatter so the cursor breaks into the same dust.
    const cursorLit = cursorElapsed >= 0 && (cursorElapsed >= cursorBeat * (blinkCount - 1)
      || cursorElapsed % cursorBeat < cursorOnTime)
    paintBackdrop(scatterProgress, backdropColor, coverOpacity)
    context.resetTransform()
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (scatterProgress >= 1) return
    context.setTransform(scale, 0, 0, scale, offsetX, offsetY)
    for (const dot of dots) {
      if (dot.cursor && !cursorLit) continue
      const { x, y, coverage, grain } = dot
      const settling = dot.cursor ? 1 : smoothstep(dot.gatherAt, dot.settleAt, progress)
      let drawX = x
      let drawY = y
      if (settling < 1) {
        // Keep turning in the same direction as the ellipse tightens around the target dot.
        const orbitTime = Math.min(1, progress / dot.settleAt)
        const remainingTurn = (1 - orbitTime) * (1 - orbitTime)
        const angle = dot.targetAngle - dot.travel * remainingTurn
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        const radius = dot.orbitRadius + 9 * Math.sin(angle * 3 + grain * 8)
        const offsetX = cos * mix(radius, dot.targetRadius, settling)
        const offsetY = sin * mix(radius * .45, dot.targetRadius, settling)
        drawX = centerX + offsetX
        drawY = centerY + offsetY - offsetX * .10 * (1 - settling)
      }

      const glowUp = smoothstep(.50, 1, settling)
      const shimmer = .5 + .5 * Math.sin(progress * 20 + grain * 40)
      const band = .5 + .5 * Math.cos(x * .032 - y * .05 + progress * 4.8)
      const hueBlend = smoothstep(.40, .83, x / width + .26 * band - .1 * y / height)
      const glow = .22 * band + mix(.38 * shimmer, 0, settling)
      const color = x < promptEnd ? palette.prompt : mixRgb(palette.lettering, palette.secondary, hueBlend)
      const [red, green, blue] = dot.cursor ? palette.cursor : mixRgb(color, palette.highlight, .7 * glow)
      const dustSize = .65 + 1.25 * grain ** 2
      const dotSize = pitch * (.59 + .13 * coverage + .08 * glow)
      let size = mix(dustSize, dotSize, glowUp)
      const dustAlpha = (.28 + .48 * grain) * (.72 + .28 * shimmer)
      const dotAlpha = coverage * (.75 + .14 * grain + .1 * glow)
      let opacity = mix(dustAlpha, dotAlpha, glowUp)
      if (scatterProgress > 0) {
        const time = Math.max(0, (scatterProgress - dot.scatterDelay) / (1 - dot.scatterDelay))
        const drift = dot.scatterDistance * (1 - (1 - time) ** 2.5)
        drawX += Math.cos(dot.scatterAngle) * drift * burstX
        drawY += Math.sin(dot.scatterAngle) * drift * burstY
        size = mix(size, dustSize, smoothstep(0, .56, time))
        opacity *= 1 - smoothstep(.16, 1, time)
      }
      context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${opacity})`
      context.fillRect(drawX - size / 2, drawY - size / 2, size, size)
    }
  }
}

function animate(duration: number, paint: (elapsed: number) => void) {
  return new Promise<void>(resolve => {
    let start: number
    function frame(now: number) {
      start ??= now
      const elapsed = Math.min(duration, now - start)
      paint(elapsed)
      if (elapsed < duration) requestAnimationFrame(frame)
      else resolve()
    }
    requestAnimationFrame(frame)
  })
}

async function playStartupMotion(paint: PaintLogo, readyToReveal: Promise<string>, showApp: () => Promise<void>) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (reducedMotion.matches) {
    paint(introDuration)
    await readyToReveal
    return
  }
  await animate(introDuration, paint)
  const color = await readyToReveal
  if (reducedMotion.matches) return
  await animate(scatterDuration, elapsed => paint(introDuration, elapsed / scatterDuration, color))
  await showApp()
  await animate(fadeDuration, elapsed => paint(introDuration, 1, color, 1 - smoothstep(0, fadeDuration, elapsed)))
}

async function start() {
  const theme = useThemeStore.getState().getCurrentTheme()
  const managed = new URLSearchParams(location.search).has('startupMode')
  const readyToReveal = managed
    ? new Promise<string>(resolve => window.addEventListener('ezshell-startup-reveal',
      event => resolve((event as CustomEvent<string>).detail || theme.colors.bgPrimary), { once: true }))
    : Promise.resolve(theme.colors.bgPrimary)
  const showApp = managed
    ? () => new Promise<void>(resolve => {
      window.addEventListener('ezshell-startup-app-shown', () => resolve(), { once: true })
      requestAnimationFrame(() => window.dispatchEvent(new Event('ezshell-startup-covered')))
    })
    : () => Promise.resolve()
  try {
    const paint = await createLogoPainter(theme)
    await playStartupMotion(paint, readyToReveal, showApp)
  } catch {
    showStaticLogo()
    await readyToReveal
  }
  window.dispatchEvent(new Event('ezshell-startup-finished'))
}

void start()
