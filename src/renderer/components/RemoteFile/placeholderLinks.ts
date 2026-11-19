// `${NAME}` / `${NAME:default}` placeholders in the file window's editor: underlined, and Ctrl + click
// asks where the name is set (docs/plan/2026-11-19-config-placeholder-definitions.md). Also the
// line flash used when a definition is opened at its line.
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

export interface PlaceholderHit {
  name: string
  fallback: string | null
  /** Where to show the list, in window coordinates */
  x: number
  y: number
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_.\-[\]]*)(?::([^}]*))?\}/g
const HINT = 'Ctrl+클릭: 이 값을 정하는 곳 찾기'

/** The placeholder at a column of a line, or null */
export function placeholderAt(line: string, column: number): { name: string; fallback: string | null } | null {
  for (const match of line.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0
    if (column >= start && column <= start + match[0].length) return { name: match[1], fallback: match[2] ?? null }
  }
  return null
}

const marks = new MatchDecorator({
  regexp: PLACEHOLDER,
  decoration: () => Decoration.mark({ class: 'cm-placeholder-ref', attributes: { title: HINT } })
})

const underline = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = marks.createDeco(view) }
  update(update: ViewUpdate) { this.decorations = marks.updateDeco(update, this.decorations) }
}, { decorations: plugin => plugin.decorations })

/**
 * Underlines placeholders; Ctrl (Cmd on macOS) + click on one calls `onFind` instead of adding a
 * cursor (CodeMirror's own Ctrl + click).
 */
export function placeholderLinks(onFind: (hit: PlaceholderHit) => void): Extension {
  return [
    underline,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        const line = view.state.doc.lineAt(pos)
        const hit = placeholderAt(line.text, pos - line.from)
        if (!hit) return false
        event.preventDefault()
        onFind({ ...hit, x: event.clientX, y: event.clientY })
        return true
      }
    })
  ]
}

const flashLine = StateEffect.define<number | null>()
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(flashLine)) continue
      if (effect.value === null) return Decoration.none
      return Decoration.set([Decoration.line({ class: 'cm-revealed-line' }).range(effect.value)])
    }
    return value.map(tr.changes)
  },
  provide: field => EditorView.decorations.from(field)
})

/** The line highlight a revealed line gets; part of the editor's extensions */
export const revealedLine: Extension = flashField

const FLASH_MS = 2000
const timers = new WeakMap<EditorView, number>()

/** Puts the cursor on a line (1-based), scrolls it to the middle and highlights it for a moment */
export function revealEditorLine(view: EditorView, lineNumber: number): void {
  const doc = view.state.doc
  const line = doc.line(Math.min(Math.max(1, lineNumber), doc.lines))
  view.dispatch({
    selection: { anchor: line.from },
    effects: [EditorView.scrollIntoView(line.from, { y: 'center' }), flashLine.of(line.from)]
  })
  view.focus()
  window.clearTimeout(timers.get(view))
  timers.set(view, window.setTimeout(() => view.dispatch({ effects: flashLine.of(null) }), FLASH_MS))
}
