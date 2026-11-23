// Pointer sets drawn as SVG (designed in mockups/cursor-themes.html). Each set draws the eleven
// pointer states on a 32-unit grid; the image is scaled to the chosen size and so is its hotspot.

export const CURSOR_STATES = [
  'default', 'pointer', 'text', 'wait', 'progress', 'not-allowed', 'grab', 'grabbing', 'col-resize', 'row-resize', 'crosshair'
] as const
export type CursorState = typeof CURSOR_STATES[number]

export const CURSOR_SET_IDS = ['system', 'big', 'contrast', 'fine', 'paw', 'jelly', 'star', 'heart', 'pixel'] as const
export type CursorSetId = typeof CURSOR_SET_IDS[number]

export const CURSOR_SIZES = [32, 48, 64] as const
export type CursorSize = typeof CURSOR_SIZES[number]

interface Shape { svg: string; hotspot: [number, number] }
type Shapes = Record<CursorState, Shape>

export interface CursorSet {
  id: CursorSetId
  kind: 'practical' | 'cute'
  name: string
  description: string
  /** The OS pointer: nothing is replaced (the cards still show a drawing of it) */
  system?: boolean
  shapes: Shapes
}

function star(cx: number, cy: number, outer: number, inner: number, points = 5) {
  let d = ''
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / points
    const radius = i % 2 ? inner : outer
    d += (i ? 'L' : 'M') + (cx + Math.cos(angle) * radius).toFixed(2) + ' ' + (cy + Math.sin(angle) * radius).toFixed(2)
  }
  return d + 'Z'
}

function heartPath(cx: number, cy: number, s: number) {
  return `M${cx} ${cy + 11 * s}C${cx - 12 * s} ${cy + 2 * s} ${cx - 12 * s} ${cy - 8 * s} ${cx - 5.5 * s} ${cy - 8 * s}` +
    `C${cx - 2.5 * s} ${cy - 8 * s} ${cx - 0.5 * s} ${cy - 6 * s} ${cx} ${cy - 4 * s}` +
    `C${cx + 0.5 * s} ${cy - 6 * s} ${cx + 2.5 * s} ${cy - 8 * s} ${cx + 5.5 * s} ${cy - 8 * s}` +
    `C${cx + 12 * s} ${cy - 8 * s} ${cx + 12 * s} ${cy + 2 * s} ${cx} ${cy + 11 * s}Z`
}

function sparkle(cx: number, cy: number, s: number) {
  return `M${cx} ${cy - s}L${cx + s * 0.28} ${cy - s * 0.28}L${cx + s} ${cy}L${cx + s * 0.28} ${cy + s * 0.28}` +
    `L${cx} ${cy + s}L${cx - s * 0.28} ${cy + s * 0.28}L${cx - s} ${cy}L${cx - s * 0.28} ${cy - s * 0.28}Z`
}

interface Style {
  fill: string; stroke: string; sw: number; line: string; lineOutline: string | null; accent: string; bad: string
  join: 'miter' | 'round'; cap: 'butt' | 'round'; k: number; lw: number; ring: boolean
}

interface Tools {
  o: Style
  two: (inner: string, fill?: string) => string
  arrow: (extra?: string, k?: number, fill?: string) => string
  handShape: string
}

const ARROW = 'M6 3V24.5L11 19.7L14.4 27.2L18.2 25.5L14.8 18.1H21.4Z'
/** Where the arrow's visible tip goes (also its hotspot): inside the image, so no edge cuts it off */
export const ARROW_TIP = 1.5
// The outline reaches past the tip vertex along this direction (away from the arrow's inside angle).
// Its sharp corner is folded (miter limit) so it reaches about half the outline width, like a round one:
// a full miter at that angle went 2.65 times as far, past the top of the image.
const TIP_OUT = [0.387, 0.922] as const
const tipReach = (style: Pick<Style, 'sw'>, k: number) => style.sw * k
const RESIZE = '<path d="M3.5 16L10 10.5V21.5Z"/><path d="M28.5 16L22 10.5V21.5Z"/><rect x="9" y="14.8" width="14" height="2.4"/><rect x="14.5" y="6" width="3" height="20" rx="1.5"/>'

/** A vector set: every state from the same rules, `override` replaces some of them */
function vectorSet(style: Partial<Style>, override?: (tools: Tools) => Partial<Shapes>): Shapes {
  const o: Style = {
    fill: '#fff', stroke: '#111', sw: 1.6, line: '#fff', lineOutline: null, accent: '#4fd1a5', bad: '#e5253b',
    join: 'miter', cap: 'butt', k: 1, lw: 2.4, ring: false, ...style
  }
  const outline = o.lineOutline || o.stroke
  const two = (inner: string, fill?: string) =>
    `<g fill="${o.stroke}" stroke="${o.stroke}" stroke-width="${o.sw * 2}" stroke-linejoin="${o.join}" stroke-linecap="${o.cap}">${inner}</g><g fill="${fill || o.fill}">${inner}</g>`
  const line = (d: string, color: string, width: number) =>
    `<g fill="none" stroke-linecap="${o.cap}" stroke-linejoin="${o.join}"><path d="${d}" stroke="${outline}" stroke-width="${width + o.sw * 2}"/><path d="${d}" stroke="${color}" stroke-width="${width}"/></g>`
  const arrow = (extra = '', k = o.k, fill?: string) => {
    const reach = tipReach(o, k)
    const x = ARROW_TIP + reach * TIP_OUT[0]
    const y = ARROW_TIP + reach * TIP_OUT[1]
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k}) translate(-6 -3)">${two(`<path d="${ARROW}" stroke-miterlimit="2"/>`, fill)}${extra}</g>`
  }
  const handShape = '<rect x="11" y="3" width="5" height="16" rx="2.5"/><rect x="7" y="14" width="19" height="14" rx="6"/>'
  const ring = (r: number, width: number, color: string) =>
    `<circle cx="16" cy="16" r="${r}" fill="none" stroke="${o.stroke}" stroke-width="${width + o.sw * 2}"/><circle cx="16" cy="16" r="${r}" fill="none" stroke="${color}" stroke-width="${width}"/>`
  const shapes: Shapes = {
    default: { svg: arrow(), hotspot: [ARROW_TIP, ARROW_TIP] },
    pointer: {
      svg: two(handShape) + `<path d="M13 22v3M17.5 21v4M22 22v3" fill="none" stroke="${o.stroke}" stroke-width="1.1" stroke-linecap="round"/>`,
      hotspot: [13.5, 3]
    },
    text: { svg: line('M11.5 5h9M16 5v22M11.5 27h9', o.line, o.lw), hotspot: [16, 16] },
    wait: {
      svg: ring(9, 3.6, o.fill) + `<path d="M16 7A9 9 0 0 1 25 16" fill="none" stroke="${o.accent}" stroke-width="3.6" stroke-linecap="round"/>`,
      hotspot: [16, 16]
    },
    progress: {
      svg: arrow('', o.k * 0.8) +
        `<circle cx="23" cy="23" r="5" fill="none" stroke="${o.stroke}" stroke-width="${3 + o.sw * 2}"/><circle cx="23" cy="23" r="5" fill="none" stroke="${o.fill}" stroke-width="3"/>` +
        `<path d="M23 18A5 5 0 0 1 28 23" fill="none" stroke="${o.accent}" stroke-width="3" stroke-linecap="round"/>`,
      hotspot: [ARROW_TIP, ARROW_TIP]
    },
    'not-allowed': {
      svg: ring(9.5, 4, o.bad) +
        `<path d="M9.3 22.7L22.7 9.3" stroke="${o.stroke}" stroke-width="${4 + o.sw * 2}" stroke-linecap="round"/><path d="M9.3 22.7L22.7 9.3" stroke="${o.bad}" stroke-width="4" stroke-linecap="round"/>`,
      hotspot: [16, 16]
    },
    grab: {
      svg: two('<rect x="7" y="13" width="18" height="14" rx="6"/><circle cx="10.6" cy="12.5" r="2.8"/><circle cx="15" cy="10.8" r="2.8"/><circle cx="19.4" cy="10.8" r="2.8"/><circle cx="23" cy="12.8" r="2.6"/>'),
      hotspot: [16, 16]
    },
    grabbing: {
      svg: two('<rect x="7" y="15" width="18" height="12" rx="5"/><circle cx="10.6" cy="15" r="2.6"/><circle cx="14.9" cy="14.2" r="2.6"/><circle cx="19.2" cy="14.2" r="2.6"/><circle cx="23" cy="15.5" r="2.4"/>'),
      hotspot: [16, 16]
    },
    'col-resize': { svg: two(RESIZE), hotspot: [16, 16] },
    'row-resize': { svg: `<g transform="rotate(90 16 16)">${two(RESIZE)}</g>`, hotspot: [16, 16] },
    crosshair: {
      svg: line('M16 3v10M16 19v10M3 16h10M19 16h10', o.line, o.lw * 0.8) +
        `<circle cx="16" cy="16" r="2.1" fill="${o.accent}" stroke="${o.stroke}" stroke-width="1"/>` +
        (o.ring ? `<circle cx="16" cy="16" r="6.5" fill="none" stroke="${o.stroke}" stroke-width="${1.2 + o.sw}"/><circle cx="16" cy="16" r="6.5" fill="none" stroke="${o.line}" stroke-width="1"/>` : ''),
      hotspot: [16, 16]
    }
  }
  return override ? { ...shapes, ...override({ o, two, arrow, handShape }) } : shapes
}

/* Pixel retro: a 16x16 grid in 2-unit cells. '#' black, 'o' white, anything else pink */
function grid(rows: string[], px = 2) {
  let rects = ''
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === '.') return
      const color = c === '#' ? '#000' : c === 'o' ? '#fff' : '#ff3b6b'
      rects += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${color}"/>`
    })
  })
  return `<g shape-rendering="crispEdges">${rects}</g>`
}

type Rect = [number, number, number, number]

/** Rectangles with a 2-unit black outline, and pink accent rectangles on top */
function blocks(rects: Rect[], fill = '#fff', accents: Rect[] = []) {
  const g = 2
  const outer = rects.map(([x, y, w, h]) => `<rect x="${x - g}" y="${y - g}" width="${w + g * 2}" height="${h + g * 2}"/>`).join('')
  const inner = rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')
  const accent = accents.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')
  return `<g shape-rendering="crispEdges"><g fill="#000">${outer}</g><g fill="${fill}">${inner}</g><g fill="#ff3b6b">${accent}</g></g>`
}

const PX_ARROW = ['#...............', '##..............', '#o#.............', '#oo#............', '#ooo#...........', '#oooo#..........',
  '#ooooo#.........', '#oooooo#........', '#ooooooo#.......', '#oooo#####......', '#oo#o#..........', '#o#.#o#.........',
  '##..#o#.........', '#....#o#........', '.....#o#........', '......##........']
const PX_HAND = ['....##..........', '...#oo#.........', '...#oo#.........', '...#oo#.........', '...#oo#####.....', '.###oo#oo#oo##..',
  '#oo#oooooooooo#.', '#ooooooooooooo#.', '.#oooooooooooo#.', '..#ooooooooooo#.', '..#oooooooooo#..', '...#ooooooooo#..',
  '...#ooooooooo#..', '....#oooooo#....', '....#oooooo#....', '....########....']
const turned = (rects: Rect[]): Rect[] => rects.map(([x, y, w, h]) => [y, x, h, w])
const PX_COL: Rect[] = [[4, 15, 24, 2], [4, 15, 2, 2], [6, 13, 2, 6], [8, 11, 2, 10], [26, 15, 2, 2], [24, 13, 2, 6], [22, 11, 2, 10], [15, 6, 2, 20]]

const PIXEL: Shapes = {
  default: { svg: grid(PX_ARROW), hotspot: [1, 1] },
  pointer: { svg: grid(PX_HAND), hotspot: [9, 1] },
  text: { svg: blocks([[8, 4, 16, 2], [15, 4, 2, 24], [8, 26, 16, 2]]), hotspot: [16, 16] },
  wait: {
    svg: blocks([[8, 4, 16, 2], [8, 26, 16, 2], [10, 6, 12, 2], [12, 8, 8, 2], [14, 10, 4, 2], [15, 12, 2, 8], [14, 20, 4, 2], [12, 22, 8, 2], [10, 24, 12, 2]],
      '#fff', [[14, 20, 4, 2], [12, 22, 8, 2], [10, 24, 12, 2]]),
    hotspot: [16, 16]
  },
  progress: { svg: grid(PX_ARROW) + blocks([[20, 20, 8, 8]], '#fff', [[22, 22, 4, 4]]), hotspot: [1, 1] },
  'not-allowed': {
    svg: '<g shape-rendering="crispEdges"><polygon points="11,3 21,3 29,11 29,21 21,29 11,29 3,21 3,11" fill="none" stroke="#000" stroke-width="7" stroke-linejoin="miter"/>' +
      '<polygon points="11,3 21,3 29,11 29,21 21,29 11,29 3,21 3,11" fill="none" stroke="#ff3b6b" stroke-width="3"/>' +
      '<path d="M9 23L23 9" stroke="#000" stroke-width="7"/><path d="M9 23L23 9" stroke="#ff3b6b" stroke-width="3"/></g>',
    hotspot: [16, 16]
  },
  grab: { svg: blocks([[8, 14, 16, 12], [8, 10, 4, 4], [12, 8, 4, 6], [16, 8, 4, 6], [20, 10, 4, 4]]), hotspot: [16, 16] },
  grabbing: { svg: blocks([[8, 16, 16, 10], [8, 14, 4, 2], [12, 14, 4, 2], [16, 14, 4, 2], [20, 14, 4, 2]]), hotspot: [16, 16] },
  'col-resize': { svg: blocks(PX_COL), hotspot: [16, 16] },
  'row-resize': { svg: blocks(turned(PX_COL.filter((_, i) => i !== 1 && i !== 4))), hotspot: [16, 16] },
  crosshair: { svg: blocks([[15, 3, 2, 10], [15, 19, 2, 10], [3, 15, 10, 2], [19, 15, 10, 2]], '#fff', [[15, 15, 2, 2]]), hotspot: [16, 16] }
}

export const CURSOR_SETS: readonly CursorSet[] = [
  {
    id: 'system', kind: 'practical', name: '시스템 기본', description: 'OS 의 모양 그대로. 바꾸지 않음', system: true,
    shapes: vectorSet({ fill: '#fff', stroke: '#000', sw: 1.2, line: '#222', lineOutline: '#fff' })
  },
  {
    id: 'big', kind: 'practical', name: '큼직한 화살표', description: '흰 몸통에 굵은 검정 테두리. 어떤 배경에서도 잘 보임',
    shapes: vectorSet({ fill: '#fff', stroke: '#111', sw: 2, line: '#fff', accent: '#ff7a00', k: 1.15, lw: 3 })
  },
  {
    id: 'contrast', kind: 'practical', name: '고대비', description: '검정 몸통 + 노랑 테두리. 시력이 낮거나 화면 공유용',
    shapes: vectorSet({ fill: '#000', stroke: '#ffe600', sw: 2, line: '#000', accent: '#fff', bad: '#ff3355', k: 1.1, lw: 3 })
  },
  {
    id: 'fine', kind: 'practical', name: '정밀', description: '가는 선, 작은 화살표. 칸 맞추기·캡처에 알맞음',
    shapes: vectorSet({ fill: '#fff', stroke: '#111', sw: 1, line: '#fff', lineOutline: '#111', accent: '#e5253b', k: 0.9, lw: 1.3, ring: true })
  },
  {
    id: 'paw', kind: 'cute', name: '고양이 발바닥', description: '분홍 젤리 발바닥이 손가락 자리에',
    shapes: vectorSet({ fill: '#fff3e6', stroke: '#7b4b3a', sw: 1.8, line: '#fff3e6', accent: '#ff8fab', bad: '#e5575f', join: 'round', cap: 'round', lw: 2.6, k: 1.05 }, t => ({
      default: { svg: t.arrow('<g fill="#ff8fab"><circle cx="8.9" cy="9.5" r="1.1"/><circle cx="8.9" cy="13.3" r="1.1"/><circle cx="8.9" cy="17.1" r="1.1"/></g>', t.o.k, '#ffd9b8'), hotspot: [ARROW_TIP, ARROW_TIP] },
      pointer: { svg: t.two('<ellipse cx="16" cy="21.5" rx="7.2" ry="5.8"/><circle cx="8.4" cy="15" r="3.1"/><circle cx="13.2" cy="9.6" r="3.3"/><circle cx="19.2" cy="9.6" r="3.3"/><circle cx="24" cy="15" r="3.1"/>', '#ffc2d1'), hotspot: [16, 8] }
    }))
  },
  {
    id: 'jelly', kind: 'cute', name: '말랑 젤리', description: '둥글둥글 파스텔. 통통한 테두리',
    shapes: vectorSet({ fill: '#ffb8d9', stroke: '#d1569a', sw: 2.2, line: '#cfe3ff', lineOutline: '#5c6bc0', accent: '#7be0c3', bad: '#ff6b81', join: 'round', cap: 'round', k: 1.1, lw: 3.2 }, t => ({
      default: { svg: t.arrow('<ellipse cx="8.6" cy="10" rx="1.1" ry="2.8" fill="#fff" opacity=".75" transform="rotate(-8 8.6 10)"/>'), hotspot: [ARROW_TIP, ARROW_TIP] },
      pointer: { svg: t.two(t.handShape, '#a8f0d8') + '<ellipse cx="13.4" cy="8" rx="1" ry="3" fill="#fff" opacity=".75"/><ellipse cx="12" cy="20" rx="1.6" ry="2.6" fill="#fff" opacity=".6"/>', hotspot: [13.5, 3] }
    }))
  },
  {
    id: 'star', kind: 'cute', name: '별사탕 · 반짝 별', description: '노란 화살표에 반짝이, 손가락은 별',
    shapes: vectorSet({ fill: '#ffe066', stroke: '#c27a00', sw: 1.8, line: '#fff7c2', lineOutline: '#c27a00', accent: '#ff9ecb', bad: '#ff5c7a', join: 'round', cap: 'round', k: 1.05, lw: 2.6 }, t => ({
      default: { svg: t.arrow('') + `<path d="${sparkle(24, 24, 5)}" fill="#fff" stroke="#c27a00" stroke-width=".9" stroke-linejoin="round"/>`, hotspot: [ARROW_TIP, ARROW_TIP] },
      pointer: { svg: t.two(`<path d="${star(16, 17, 13, 5.6)}"/>`, '#ffe066') + `<path d="${sparkle(25, 6, 3)}" fill="#fff" stroke="#c27a00" stroke-width=".7"/>`, hotspot: [16, 16] }
    }))
  },
  {
    id: 'heart', kind: 'cute', name: '하트', description: '분홍 화살표 + 하트. 손가락 자리는 큰 하트',
    shapes: vectorSet({ fill: '#ff7aa8', stroke: '#b02a5c', sw: 1.8, line: '#ffd1e0', lineOutline: '#b02a5c', accent: '#ff4f8b', bad: '#7a1d3d', join: 'round', cap: 'round', k: 1.05, lw: 2.6 }, t => ({
      default: { svg: t.arrow('') + `<path d="${heartPath(24, 22, 0.62)}" fill="#fff" stroke="#b02a5c" stroke-width="1" stroke-linejoin="round"/>`, hotspot: [ARROW_TIP, ARROW_TIP] },
      pointer: { svg: t.two(`<path d="${heartPath(16, 15, 1.12)}"/>`, '#ff7aa8') + '<ellipse cx="10.5" cy="11.5" rx="2" ry="1.3" fill="#fff" opacity=".7" transform="rotate(-30 10.5 11.5)"/>', hotspot: [16, 16] }
    }))
  },
  { id: 'pixel', kind: 'cute', name: '픽셀 레트로', description: '8비트 도트. 또렷한 계단 모양', shapes: PIXEL }
]

export function cursorSet(id: CursorSetId): CursorSet {
  return CURSOR_SETS.find(set => set.id === id) ?? CURSOR_SETS[0]
}

/** The SVG document of one state at a pixel size (the drawing is on a 32-unit grid) */
export function cursorSvg(set: CursorSet, state: CursorState, size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${set.shapes[state].svg}</svg>`
}

/** The hotspot grows with the image */
export function cursorHotspot(set: CursorSet, state: CursorState, size: number): [number, number] {
  const [x, y] = set.shapes[state].hotspot
  const scale = size / 32
  return [Math.round(x * scale), Math.round(y * scale)]
}

/** The CSS custom property a state's pointer goes in (scripts/postcss-cursor-vars.cjs writes the readers) */
export const cursorVariable = (state: CursorState) => `--ez-cursor-${state}`

/** `url("…") x y, <keyword>`: the OS pointer of the same meaning stays as the fallback */
export function cursorValue(url: string, hotspot: [number, number], state: CursorState): string {
  return `url("${url}") ${hotspot[0]} ${hotspot[1]}, ${state}`
}
