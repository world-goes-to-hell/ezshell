// Where the user put the cards of the agent message map, and its zoom, kept per map scope (the local
// project or folder the map shows). Cards are keyed by the opaque `layoutKey` main derives from the
// agent's conversation (agentMessages.js): agent ids (claude-1 …) start again at every app start.
// Not in the screen settings backup: the keys mean something only on this PC's conversations.

export const AGENT_MAP_LAYOUT_KEY = 'ezshell.agentMessageMapLayout'
export const AGENT_MAP_LARGE_KEY = 'ezshell.agentMessageMapLarge'

export const MAX_SAVED_CARDS = 500
export const SAVED_CARD_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_SCOPE_LENGTH = 1024
/** Cards can be put far out, but not anywhere a number can say */
export const MAX_COORDINATE = 50_000
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 2

const LAYOUT_KEY = /^[0-9a-f]{16}$/

export interface SavedCard { x: number; y: number; usedAt: number }
export interface ScopeLayout { zoom?: number; cards: Record<string, SavedCard> }
export interface MapLayout { scopes: Record<string, ScopeLayout> }

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finiteIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export const isLayoutKey = (value: unknown): value is string => typeof value === 'string' && LAYOUT_KEY.test(value)

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100))

/** Drops what is too old and, past the limit, the least recently used cards */
function tidy(layout: MapLayout, now: number): MapLayout {
  const oldest = now - SAVED_CARD_DAYS * DAY_MS
  const all: [string, string, SavedCard][] = []
  for (const [scope, value] of Object.entries(layout.scopes)) {
    for (const [key, card] of Object.entries(value.cards)) if (card.usedAt > oldest) all.push([scope, key, card])
  }
  all.sort((a, b) => b[2].usedAt - a[2].usedAt)
  const scopes: Record<string, ScopeLayout> = {}
  for (const [scope, value] of Object.entries(layout.scopes)) {
    if (value.zoom !== undefined) scopes[scope] = { zoom: value.zoom, cards: {} }
  }
  for (const [scope, key, card] of all.slice(0, MAX_SAVED_CARDS)) {
    scopes[scope] ??= { cards: {} }
    scopes[scope].cards[key] = card
  }
  return { scopes }
}

/** Stored text → layout. Anything malformed is left out, entry by entry. */
export function parseMapLayout(raw: string | null | undefined, now: number): MapLayout {
  let value: unknown = null
  try { value = raw ? JSON.parse(raw) : null } catch { /* nothing kept */ }
  const scopes: Record<string, ScopeLayout> = {}
  if (isObject(value) && isObject(value.scopes)) {
    for (const [scope, stored] of Object.entries(value.scopes)) {
      if (!scope || scope.length > MAX_SCOPE_LENGTH || !isObject(stored)) continue
      const cards: Record<string, SavedCard> = {}
      if (isObject(stored.cards)) {
        for (const [key, card] of Object.entries(stored.cards)) {
          if (!isLayoutKey(key) || !isObject(card)) continue
          const { x, y, usedAt } = card
          if (!finiteIn(x, 0, MAX_COORDINATE) || !finiteIn(y, 0, MAX_COORDINATE) || !finiteIn(usedAt, 0, Number.MAX_SAFE_INTEGER)) continue
          cards[key] = { x, y, usedAt: Math.min(usedAt, now) }
        }
      }
      const zoom = finiteIn(stored.zoom, MIN_ZOOM, MAX_ZOOM) ? clampZoom(stored.zoom) : undefined
      scopes[scope] = zoom === undefined ? { cards } : { zoom, cards }
    }
  }
  return tidy({ scopes }, now)
}

export function readMapLayout(now = Date.now()): MapLayout {
  try { return parseMapLayout(localStorage.getItem(AGENT_MAP_LAYOUT_KEY), now) } catch { return { scopes: {} } }
}

export function writeMapLayout(layout: MapLayout): void {
  try { localStorage.setItem(AGENT_MAP_LAYOUT_KEY, JSON.stringify(layout)) } catch { /* kept for this run */ }
}

const withScope = (layout: MapLayout, scope: string, change: (value: ScopeLayout) => ScopeLayout): MapLayout => ({
  scopes: { ...layout.scopes, [scope]: change(layout.scopes[scope] ?? { cards: {} }) }
})

export function saveCard(layout: MapLayout, scope: string, key: string, point: { x: number; y: number }, now: number): MapLayout {
  if (!isLayoutKey(key) || !scope || scope.length > MAX_SCOPE_LENGTH) return layout
  const x = Math.min(MAX_COORDINATE, Math.max(0, point.x))
  const y = Math.min(MAX_COORDINATE, Math.max(0, point.y))
  return tidy(withScope(layout, scope, value => ({ ...value, cards: { ...value.cards, [key]: { x, y, usedAt: now } } })), now)
}

/** Marks cards still in use so the 30-day tidy keeps them; unchanged layout when nothing was stale */
export function touchCards(layout: MapLayout, scope: string, keys: readonly string[], now: number): MapLayout {
  const value = layout.scopes[scope]
  const stale = keys.filter(key => value?.cards[key] && now - value.cards[key].usedAt > DAY_MS)
  if (!value || stale.length === 0) return layout
  const cards = { ...value.cards }
  for (const key of stale) cards[key] = { ...cards[key], usedAt: now }
  return { scopes: { ...layout.scopes, [scope]: { ...value, cards } } }
}

export function saveZoom(layout: MapLayout, scope: string, zoom: number, now: number): MapLayout {
  if (!scope || scope.length > MAX_SCOPE_LENGTH) return layout
  return tidy(withScope(layout, scope, value => ({ ...value, zoom: clampZoom(zoom) })), now)
}

/** 배치 초기화: the scope's card positions go; its zoom stays */
export function clearCards(layout: MapLayout, scope: string): MapLayout {
  const value = layout.scopes[scope]
  if (!value) return layout
  const scopes = { ...layout.scopes }
  if (value.zoom === undefined) delete scopes[scope]
  else scopes[scope] = { zoom: value.zoom, cards: {} }
  return { scopes }
}

export const parseLargeView = (raw: string | null) => raw === '1'
