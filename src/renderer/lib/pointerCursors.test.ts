import { describe, expect, it } from 'vitest'
import { CURSOR_SETS, CURSOR_SIZES, cursorHotspot } from './pointerCursors'

// The text pointer's stem: the paths drawn straight down (`M<x> 5v22`) and their widths
const stems = (svg: string) => [...svg.matchAll(/<path d="M([\d.]+) 5v22" [^>]*stroke-width="([\d.]+)"/g)].map(([, x, width]) => ({ x: Number(x), width: Number(width) }))

describe('the text pointer', () => {
  it('keeps the stem thin on the hotspot\u2019s pixel column in every drawn set, so a drag starts where it shows', () => {
    for (const set of CURSOR_SETS.filter(item => !item.system && item.id !== 'pixel')) {
      const found = stems(set.shapes.text.svg)
      expect(found, set.id).toHaveLength(2)
      // The whole stem, outline included, is at most 3 of 32 units wide (the high contrast one was 7)
      expect(Math.max(...found.map(stem => stem.width)), set.id).toBeLessThanOrEqual(3)
      for (const size of CURSOR_SIZES) {
        const [x] = cursorHotspot(set, 'text', size)
        const scale = size / 32
        // The hotspot pixel [x, x + 1) lies under the stem's 1-unit core
        expect(Math.abs((x + 0.5) - found[1].x * scale), `${set.id} ${size}`).toBeLessThanOrEqual(scale / 2 + 0.5)
      }
    }
  })

  it('draws the pixel set\u2019s stem one unit wide on the hotspot column, with a one-unit edge', () => {
    const svg = CURSOR_SETS.find(set => set.id === 'pixel')!.shapes.text.svg
    expect(svg).toContain('<rect x="15" y="4" width="3" height="24" fill="#000"')
    expect(svg).toContain('<rect x="16" y="4" width="1" height="24" fill="#fff"')
    expect(cursorHotspot(CURSOR_SETS.find(set => set.id === 'pixel')!, 'text', 32)).toEqual([16, 16])
  })
})
