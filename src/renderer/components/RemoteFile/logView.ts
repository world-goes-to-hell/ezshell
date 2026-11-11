// CodeMirror parts of the log view: line colours by level (only the lines on screen are looked at),
// adding the lines a followed log printed, and moving between errors.
import { RangeSetBuilder, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { classifyLine, type LogLevel, findLevelLine, type JumpLevel } from '../../lib/logLevels'
import { planAppend, type AppendLimits, type AppendPlan, type LevelCounts } from '../../lib/logAppend'

const LINE_CLASS: Record<LogLevel, Decoration> = {
  error: Decoration.line({ class: 'cm-log-error' }),
  warn: Decoration.line({ class: 'cm-log-warn' }),
  debug: Decoration.line({ class: 'cm-log-debug' }),
  marker: Decoration.line({ class: 'cm-log-marker' })
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { doc } = view.state
  for (const { from, to } of view.visibleRanges) {
    for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number++) {
      const line = doc.line(number)
      const level = classifyLine(line.text)
      if (level) builder.add(line.from, line.from, LINE_CLASS[level])
    }
  }
  return builder.finish()
}

const levelColours = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = decorate(view) }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view)
  }
}, { decorations: plugin => plugin.decorations })

const levelTheme = EditorView.theme({
  '.cm-log-error': {
    backgroundColor: 'color-mix(in srgb, var(--error-text) 15%, transparent)',
    boxShadow: 'inset 3px 0 0 var(--error-text)'
  },
  '.cm-log-warn': {
    backgroundColor: 'color-mix(in srgb, var(--warning) 13%, transparent)',
    boxShadow: 'inset 3px 0 0 var(--warning)'
  },
  '.cm-log-debug': { opacity: '0.55' },
  '.cm-log-marker': { color: 'var(--accent)', fontStyle: 'italic', backgroundColor: 'var(--bg-secondary)' }
})

/**
 * Add text at the end (oldest lines dropped past the limit); the plan tells what changed. Kept out
 * of the undo history: it would hold every dropped line and break the window's memory limit.
 */
export function appendLog(view: EditorView, text: string, counts: LevelCounts, limits: AppendLimits): AppendPlan {
  const plan = planAppend(view.state.doc, text, counts, limits)
  view.dispatch({ changes: plan.changes, annotations: Transaction.addToHistory.of(false) })
  return plan
}

export function isAtBottom(view: EditorView): boolean {
  const scroller = view.scrollDOM
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
}

export function scrollToEnd(view: EditorView): void {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }) })
}

export const PROBLEM_LEVELS: ReadonlySet<JumpLevel> = new Set<JumpLevel>(['error', 'warn'])

export type JumpOutcome = 'found' | 'wrapped' | 'none'

/**
 * Put the cursor on the next (1) or previous (-1) line of one of `levels`, going round the end of the
 * log. 'wrapped' when it went past the end, 'none' when the log has no other such line.
 */
export function jumpToLevel(view: EditorView, direction: 1 | -1, levels: ReadonlySet<JumpLevel> = PROBLEM_LEVELS): JumpOutcome {
  const doc = view.state.doc
  const current = doc.lineAt(view.state.selection.main.head).number
  const hit = findLevelLine(doc.lines, (number) => doc.line(number).text, current, direction, levels)
  if (!hit) return 'none'
  const line = doc.line(hit.line)
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
  return hit.wrapped ? 'wrapped' : 'found'
}

/** Colours, and F8 / Shift+F8 between error and warning lines. */
export function logExtensions(onJump: (outcome: JumpOutcome) => void): Extension[] {
  return [
    levelColours,
    levelTheme,
    keymap.of([
      { key: 'F8', run: (view) => { onJump(jumpToLevel(view, 1)); return true }, preventDefault: true },
      { key: 'Shift-F8', run: (view) => { onJump(jumpToLevel(view, -1)); return true }, preventDefault: true }
    ])
  ]
}
