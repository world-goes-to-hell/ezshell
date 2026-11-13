/**
 * The "file zone" of a terminal: the output printed since the shell last changed folder. Relative
 * names in it ("catalina.log") mean files of the folder the tab is in now; names printed before the
 * last `cd` belong to another folder, so they are not looked up as relative names. Rows are buffer
 * rows (0-based, scrollback included).
 */
export interface FileZone {
  start: number
  end: number
}

/**
 * From the row where the folder last changed (null: no folder known) to the row above the cursor
 * (the prompt being typed at is not output). None in a full-screen program or before any output.
 */
export function fileZone({ start, cursorRow, isAlternate }: { start: number | null; cursorRow: number; isAlternate: boolean }): FileZone | null {
  if (start === null || isAlternate) return null
  const end = cursorRow - 1
  return start <= end ? { start, end } : null
}

/** The part of the zone on screen, and whether it goes on above or below it */
export function visiblePart(zone: FileZone, viewportTop: number, rows: number): { top: number; height: number; cutTop: boolean; cutBottom: boolean } | null {
  const bottom = viewportTop + rows - 1
  const top = Math.max(zone.start, viewportTop)
  const last = Math.min(zone.end, bottom)
  if (top > last) return null
  return { top, height: last - top + 1, cutTop: zone.start < viewportTop, cutBottom: zone.end > bottom }
}

/** A name found relative to the terminal's folder (not `/...` or `~...`) */
export function isRelativeName(name: string): boolean {
  return !name.startsWith('/') && !name.startsWith('~')
}

/** Whether a name on `row` may be looked up: relative names only inside the zone */
export function allowsName(name: string, row: number, zone: FileZone | null): boolean {
  if (!isRelativeName(name)) return true
  return zone !== null && row >= zone.start && row <= zone.end
}
