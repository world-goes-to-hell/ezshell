/** Where the terminal's view sits in its scrollback: for the jump-to-top / jump-to-bottom buttons of a server log */
export interface ScrollPlace {
  scrollable: boolean
  atTop: boolean
  atBottom: boolean
}

export function scrollPlace(buffer: { viewportY: number; baseY: number; type: string }): ScrollPlace {
  const scrollable = buffer.type === 'normal' && buffer.baseY > 0
  return { scrollable, atTop: buffer.viewportY <= 0, atBottom: buffer.viewportY >= buffer.baseY }
}

export const samePlace = (a: ScrollPlace, b: ScrollPlace) =>
  a.scrollable === b.scrollable && a.atTop === b.atTop && a.atBottom === b.atBottom
