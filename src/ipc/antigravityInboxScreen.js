const MODEL_FOOTER = /\s+·\s+(?:minimal|low|medium|high|max)\s*$/i
const IDLE_FOOTER = /^\? for shortcuts\s{2,}\S/i
const WORKING_FOOTER = /^\s*esc to cancel\b/i
const RULE = /^─{8,}$/u
const SCROLLED_DRAFT = /^> ↑ [1-9]\d* more lines?\s*$/u
const MENU_KEYS = /^\s*(?:[↑↓/]+\s+Navigate\s+·|Keyboard:)\s*.*\benter (?:Select|Confirm|Save)\b/iu
const QUESTION = /^\s*Question [1-9]\d*\/[1-9]\d*:\s*\S/i
const SELECTED_CHOICE = /^>\s+[1-9]\d*\.\s+\S/
const TRUST = /^\s*Do you trust the contents of this project\?\s*$/i

/** Antigravity CLI's normal inline editor, verified from the rules, footer, and live caret. */
function readAntigravityScreen(screen) {
  const buffer = screen.buffer.active
  const cellLine = row => buffer.getLine(buffer.baseY + row)
  const rows = Array.from({ length: screen.rows }, (_, row) => cellLine(row)?.translateToString(true) ?? '')
  const footer = rows.findLastIndex(row => MODEL_FOOTER.test(row))
  const nearFooter = rows.slice(Math.max(0, footer - 9), footer < 0 ? rows.length : footer)
  const blocked = nearFooter.some(row => MENU_KEYS.test(row) || TRUST.test(row)) ||
    (nearFooter.some(row => QUESTION.test(row)) && nearFooter.some(row => SELECTED_CHOICE.test(row)))
  const unavailable = { blocked, composer: null }
  if (blocked || buffer.type !== 'normal' || !screen.modes.bracketedPasteMode || footer < 3 || WORKING_FOOTER.test(rows[footer])) return unavailable

  const bottom = footer - 1
  if (!RULE.test(rows[bottom])) return unavailable
  const first = rows.slice(0, bottom).findLastIndex(row => RULE.test(row)) + 1
  const clipped = SCROLLED_DRAFT.test(rows[first])
  // A clipped editor is evidence of a visible draft only, even if the first rule is off-screen.
  if ((first === 0 && !clipped) || (rows[first] !== '>' && !rows[first]?.startsWith('> '))) return unavailable
  const { cursorX, cursorY } = buffer
  if (cursorY < first || cursorY >= bottom || (cursorY === first && cursorX < 2)) return unavailable

  const draft = rows.slice(first, bottom)
  draft[0] = clipped ? '' : draft[0].slice(2)
  const display = draft.map(row => row.trimEnd()).join('\n')
  const text = display.replace(/\s/g, '')
  const atStart = !clipped && draft.length === 1 && rows[first].trimEnd() === '>' && cursorY === first && cursorX === 2 && IDLE_FOOTER.test(rows[footer])
  if (clipped && !text) return unavailable
  if (!atStart && !text) return unavailable
  const afterCursor = cellLine(cursorY)?.translateToString(false, cursorX) ?? ''
  const endsAtCursor = !clipped && !afterCursor.trim() && !rows.slice(cursorY + 1, bottom).some(row => row.trim())
  return { blocked, composer: { atStart, endsAtCursor, text, display } }
}

module.exports = { readAntigravityScreen }
