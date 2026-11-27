// A notice box a CLI plugin draws over the top right of Claude's screen (this PC's ko-ui plugin:
// "╭──╮ / │ ko-ui … │ / ╰──╯", seen with Claude Code 2.1.332). It covers the right part of the rows it lies
// on: the blank row under the question dialog's tab strip, where its bottom border was read as the first
// row of the question, and the end of the question's own rows. The chat then showed no card, or the card
// stopped after the first answer and handed the rest to the terminal (2026-11-27 user report,
// docs/fix/2026-11-27-chat-question-under-notice-box.md).

// A box row at the end of a row: its top or bottom border, or its text between two bars
const BOX_END = /(?:╭─+╮|╰─+╯|│[^│]*│)\s*$/u
// A box from the row's start is the row's own frame (a dialog drawn in a box), not something laid over it
const OWN_FRAME_MAX = 2

/** The row without a box laid over its right part, and whether there was one (`cut`) */
function splitOverlayBox(line) {
  const text = String(line ?? '')
  const match = BOX_END.exec(text)
  return match && match.index > OWN_FRAME_MAX ? { text: text.slice(0, match.index).trimEnd(), cut: true } : { text, cut: false }
}

const withoutOverlayBox = line => splitOverlayBox(line).text

/**
 * Whether the pieces read from rows a box covered in part (spaces removed) appear in `full` in order, the
 * first at its start: a covered row shows only the beginning of its text, the next row goes on after it
 */
function piecesInOrder(pieces, full) {
  const shown = pieces.filter(Boolean)
  let at = 0
  for (const [index, piece] of shown.entries()) {
    const found = full.indexOf(piece, at)
    if (found < 0 || (index === 0 && found !== 0)) return false
    at = found + piece.length
  }
  return shown.length > 0
}

module.exports = { splitOverlayBox, withoutOverlayBox, piecesInOrder }
