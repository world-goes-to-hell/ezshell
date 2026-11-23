import { describe, expect, it } from 'vitest'
import {
  clearCards, MAX_SAVED_CARDS, parseMapLayout, saveCard, saveZoom, touchCards, type MapLayout
} from './agentMapLayout'
import { cardBounds, centerView, clampPan, fitView, zoomAround, zoomStep } from './agentMapView'
import { MAP_CARD_HEIGHT, MAP_CARD_WIDTH, placeAgentMessageMap } from './agentMessageMap'

const now = 1_800_000_000_000
const day = 24 * 60 * 60 * 1000
const key = (n: number) => n.toString(16).padStart(16, '0')

describe('saved map layout', () => {
  it('keeps only well-formed cards and zooms', () => {
    const raw = JSON.stringify({
      scopes: {
        'C:/work': {
          zoom: 1.5,
          cards: {
            [key(1)]: { x: 200, y: 120, usedAt: now - day },
            [key(2)]: { x: Number.NaN, y: 1, usedAt: now },
            [key(3)]: { x: -5, y: 1, usedAt: now },
            [key(4)]: { x: 1, y: 1e9, usedAt: now },
            'claude-1': { x: 1, y: 1, usedAt: now },
            [key(5)]: { x: '10', y: 1, usedAt: now },
            [key(6)]: { x: 10, y: 10, usedAt: now + day }
          }
        },
        'C:/bad-zoom': { zoom: 9, cards: [] },
        '': { cards: { [key(7)]: { x: 1, y: 1, usedAt: now } } }
      }
    })
    const layout = parseMapLayout(raw, now)
    expect(Object.keys(layout.scopes)).toEqual(['C:/work'])
    expect(layout.scopes['C:/work']).toEqual({ zoom: 1.5, cards: { [key(1)]: { x: 200, y: 120, usedAt: now - day }, [key(6)]: { x: 10, y: 10, usedAt: now } } })
    for (const text of [null, '', '{', '[]', '{"scopes":[]}', '"x"']) expect(parseMapLayout(text, now)).toEqual({ scopes: {} })
  })

  it('drops cards unused for 30 days and keeps the 500 most recent', () => {
    const cards: Record<string, { x: number; y: number; usedAt: number }> = {}
    for (let i = 0; i < MAX_SAVED_CARDS + 20; i++) cards[key(i)] = { x: 100, y: 100, usedAt: now - i * 1000 }
    cards[key(9999)] = { x: 100, y: 100, usedAt: now - 31 * day }
    const layout = parseMapLayout(JSON.stringify({ scopes: { a: { cards } } }), now)
    const kept = Object.keys(layout.scopes.a.cards)
    expect(kept).toHaveLength(MAX_SAVED_CARDS)
    expect(kept).toContain(key(0))
    expect(kept).not.toContain(key(MAX_SAVED_CARDS + 5))
    expect(kept).not.toContain(key(9999))
  })

  it('saves, touches and clears a scope without touching the others', () => {
    let layout: MapLayout = { scopes: {} }
    layout = saveCard(layout, 'a', key(1), { x: 300, y: 200 }, now)
    layout = saveCard(layout, 'b', key(2), { x: -40, y: 99_999_999 }, now)
    layout = saveCard(layout, 'a', 'not-a-key', { x: 1, y: 1 }, now)
    layout = saveZoom(layout, 'a', 3, now)
    expect(layout.scopes.a).toEqual({ zoom: 2, cards: { [key(1)]: { x: 300, y: 200, usedAt: now } } })
    expect(layout.scopes.b.cards[key(2)]).toEqual({ x: 0, y: 50_000, usedAt: now })
    expect(touchCards(layout, 'a', [key(1)], now + 1000)).toBe(layout)
    expect(touchCards(layout, 'a', [key(1)], now + 2 * day).scopes.a.cards[key(1)].usedAt).toBe(now + 2 * day)
    const cleared = clearCards(layout, 'a')
    expect(cleared.scopes.a).toEqual({ zoom: 2, cards: {} })
    expect(cleared.scopes.b).toBe(layout.scopes.b)
    expect(clearCards(cleared, 'b').scopes.b).toBeUndefined()
  })
})

describe('map zoom and fit', () => {
  it('steps through the zoom presets within 50–200%', () => {
    expect(zoomStep(1, 1)).toBe(1.1)
    expect(zoomStep(1, -1)).toBe(0.9)
    expect(zoomStep(0.8, 1)).toBe(0.9)
    expect(zoomStep(2, 1)).toBe(2)
    expect(zoomStep(0.5, -1)).toBe(0.5)
  })

  it('zooms around the pointer, keeping the map point under it', () => {
    const view = { zoom: 1, x: 10, y: 20 }
    const anchor = { x: 210, y: 120 }
    const next = zoomAround(view, 2, anchor)
    const before = { x: (anchor.x - view.x) / view.zoom, y: (anchor.y - view.y) / view.zoom }
    expect({ x: (anchor.x - next.x) / next.zoom, y: (anchor.y - next.y) / next.zoom }).toEqual(before)
    expect(zoomAround(view, 7, anchor).zoom).toBe(2)
  })

  it('fits every card in view at most at 100% and centers a saved zoom', () => {
    const bounds = cardBounds([{ x: 100, y: 100 }, { x: 1100, y: 700 }])!
    expect(bounds).toEqual({ left: 100 - MAP_CARD_WIDTH / 2, top: 100 - MAP_CARD_HEIGHT / 2, right: 1100 + MAP_CARD_WIDTH / 2, bottom: 700 + MAP_CARD_HEIGHT / 2 })
    const viewport = { width: 800, height: 500 }
    const fitted = fitView(bounds, viewport)
    expect(fitted.zoom).toBeLessThan(1)
    expect(bounds.left * fitted.zoom + fitted.x).toBeGreaterThanOrEqual(23)
    expect(bounds.right * fitted.zoom + fitted.x).toBeLessThanOrEqual(viewport.width - 23)
    expect(bounds.bottom * fitted.zoom + fitted.y).toBeLessThanOrEqual(viewport.height - 23)
    expect(fitView(cardBounds([{ x: 200, y: 100 }])!, viewport).zoom).toBe(1)
    // Past 50% the cards no longer all fit: the zoom stops at its floor
    expect(fitView(cardBounds([{ x: 0, y: 0 }, { x: 5000, y: 0 }])!, viewport).zoom).toBe(0.5)
    const centered = centerView(bounds, viewport, 1.5)
    expect(centered.zoom).toBe(1.5)
    expect((bounds.left + bounds.right) / 2 * 1.5 + centered.x).toBeCloseTo(400)
  })

  it('does not let a pan lose the cards', () => {
    const bounds = cardBounds([{ x: 200, y: 200 }])!
    const viewport = { width: 600, height: 400 }
    const far = clampPan({ zoom: 1, x: 5000, y: -5000 }, bounds, viewport)
    expect(bounds.left + far.x).toBeLessThanOrEqual(viewport.width - 48)
    expect(bounds.bottom + far.y).toBeGreaterThanOrEqual(48)
  })
})

describe('placing cards', () => {
  it('keeps placed cards and puts the others on free grid places', () => {
    const ids = ['a', 'b', 'c', 'd']
    const auto = placeAgentMessageMap(ids, new Map(), 900, 500)
    const takenSpot = auto.positions.get('a')!
    const placed = placeAgentMessageMap(ids, new Map([['d', takenSpot]]), 900, 500)
    expect(placed.positions.get('d')).toEqual(takenSpot)
    for (const id of ['a', 'b', 'c']) {
      const point = placed.positions.get(id)!
      const apart = Math.abs(point.x - takenSpot.x) >= MAP_CARD_WIDTH + 16 || Math.abs(point.y - takenSpot.y) >= MAP_CARD_HEIGHT + 16
      expect(apart, id).toBe(true)
    }
    const points = [...placed.positions.values()]
    expect(new Set(points.map(point => `${point.x},${point.y}`)).size).toBe(points.length)
  })

  it('grows the map to hold a card put far away', () => {
    const placed = placeAgentMessageMap(['a', 'b'], new Map([['a', { x: 3000, y: 2000 }]]), 600, 400)
    expect(placed.width).toBeGreaterThanOrEqual(3000 + MAP_CARD_WIDTH / 2)
    expect(placed.height).toBeGreaterThanOrEqual(2000 + MAP_CARD_HEIGHT / 2)
    expect(placeAgentMessageMap(['a'], new Map([['a', { x: -50, y: -50 }]]), 600, 400).positions.get('a')).toEqual({ x: MAP_CARD_WIDTH / 2 + 6, y: MAP_CARD_HEIGHT / 2 + 6 })
  })
})
