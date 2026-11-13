/**
 * How many terminal cells text takes. Programs that print tables (psql, docker ps) pad their
 * columns counting a Korean or Chinese character as two cells; a browser draws it in whatever
 * width the font has, so columns after such text drift. Text shown as a terminal would show it is
 * split into runs, and each wide run is given exactly two cells per character.
 */

// [first, last] code points that take two cells (East Asian Wide and Fullwidth, and emoji)
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo (leading consonants)
  [0x2e80, 0x303e], // CJK radicals, punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Hangul compatibility Jamo, CJK symbols
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji
  [0x1f900, 0x1f9ff], // Emoji (supplemental)
  [0x20000, 0x3fffd] // CJK extensions B and later
]

/** Whether a character takes two cells in a terminal */
export function isWideCodePoint(codePoint: number): boolean {
  if (codePoint < 0x1100) return false
  return WIDE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last)
}

export interface TextRun {
  text: string
  /** Wide characters: each takes two cells */
  isWide: boolean
  /** Cells the run takes (wide runs only; a narrow run may hold line breaks and tabs) */
  cells: number
}

/** Text as runs of narrow and wide characters, in order; joined they give the text back */
export function splitWideRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  let current = ''
  let isCurrentWide = false
  let cells = 0
  const flush = () => {
    if (current) runs.push({ text: current, isWide: isCurrentWide, cells: isCurrentWide ? cells : 0 })
    current = ''
    cells = 0
  }
  for (const char of text) {
    const isWide = isWideCodePoint(char.codePointAt(0) ?? 0)
    if (isWide !== isCurrentWide) {
      flush()
      isCurrentWide = isWide
    }
    current += char
    if (isWide) cells += 2
  }
  flush()
  return runs
}

/** Whether text holds any wide character (most output does not: it is then shown as it is) */
export function hasWideCharacters(text: string): boolean {
  for (const char of text) if (isWideCodePoint(char.codePointAt(0) ?? 0)) return true
  return false
}
