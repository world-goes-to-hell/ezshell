// CodeMirror parts of the log view: line colours by level (only the lines on screen are looked at),
// adding the lines a followed log printed, and moving between problems and markers (keys and wheel).
import { Compartment, Prec, RangeSetBuilder, Transaction, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { classifyLine, type LogLevel, type JumpLevel } from '../../lib/logLevels'
import { planAppend, type AppendLimits, type AppendPlan } from '../../lib/logAppend'
import { countProblems, findProblem, logProblemField, problemsOf, type JumpOutcome, type ProblemTarget } from '../../lib/logProblems'
import { findMarker, logMarkerField, markersOf, type MarkerTarget } from '../../lib/logMarkers'
import { createWheelStepper } from '../../lib/logWheel'

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
 * Add text at the end (oldest lines dropped past the limit); the plan tells what changed, and how
 * many errors the new text brought. Kept out of the undo history: it would hold every dropped line
 * and break the window's memory limit.
 */
export function appendLog(view: EditorView, text: string, limits: AppendLimits): AppendPlan & { newErrors: number } {
  const { doc } = view.state
  const plan = planAppend(doc, text, limits)
  // The last line is counted on both sides: the new text may finish it
  const before = countProblems(problemsOf(view.state), doc.line(doc.lines).from).error
  view.dispatch({ changes: plan.changes, annotations: Transaction.addToHistory.of(false) })
  const after = countProblems(problemsOf(view.state), plan.resumedAt).error
  return { ...plan, newErrors: Math.max(0, after - before) }
}

export function isAtBottom(view: EditorView): boolean {
  const scroller = view.scrollDOM
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
}

export function scrollToEnd(view: EditorView): void {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }) })
}

/** Long lines folded at the window's width, or one line each with a sideways scroll */
const wrapSlot = new Compartment()

export function setWrapped(view: EditorView, isWrapped: boolean): void {
  view.dispatch({ effects: wrapSlot.reconfigure(isWrapped ? EditorView.lineWrapping : []) })
}

export const PROBLEM_LEVELS: ReadonlySet<JumpLevel> = new Set<JumpLevel>(['error', 'warn'])

export type { JumpOutcome }
export type NavKind = 'problem' | 'marker'
export type NavTarget = ProblemTarget & MarkerTarget

/**
 * Where "next" and "previous" start: the cursor's line while it is on screen, otherwise the edge of
 * what is shown (the wheel scrolls without moving the cursor, and going on from a cursor left far
 * away would jump to a place the user is not looking at).
 */
function referencePos(view: EditorView, direction: 1 | -1): number {
  const head = view.state.doc.lineAt(view.state.selection.main.head)
  const top = view.scrollDOM.scrollTop
  const bottom = top + view.scrollDOM.clientHeight
  const block = view.lineBlockAt(head.from)
  if (block.bottom > top && block.top < bottom) return head.from
  return direction === 1 ? view.lineBlockAtHeight(top).from - 1 : view.lineBlockAtHeight(bottom).to + 1
}

const startPos = (view: EditorView, target: NavTarget): number => (typeof target === 'number' ? referencePos(view, target) : 0)

/** Cursor on the line at `pos`, the line in the middle of the view (or at its top) */
export function revealLine(view: EditorView, pos: number, y: 'center' | 'start' = 'center'): void {
  const at = Math.min(pos, view.state.doc.length)
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, y === 'start' ? { y, yMargin: 32 } : { y }) })
}

/** Go to the next / previous / first / last problem of `levels` (a stack trace is one problem) */
export function goToProblem(view: EditorView, target: NavTarget, levels: ReadonlySet<JumpLevel> = PROBLEM_LEVELS, wrap = true): JumpOutcome {
  const { outcome, problem } = findProblem(problemsOf(view.state), startPos(view, target), target, levels, wrap)
  if (problem) revealLine(view, problem.pos)
  return outcome
}

/** Go to the next / previous / first / last marker; its band comes to the top of the view */
export function goToMarker(view: EditorView, target: NavTarget, wrap = true): JumpOutcome {
  if (markersOf(view.state).length === 0) return 'none'
  const marker = findMarker(view.state, startPos(view, target), target, wrap)
  if (!marker) return 'end'
  revealLine(view, marker.pos, 'start')
  return 'found'
}

export type NavReport = (kind: NavKind, outcome: JumpOutcome, target: NavTarget) => void

/** Alt + wheel: one problem a notch; Alt + Shift + wheel: one marker a notch. Stops at the ends. */
const wheelNavigation = (report: NavReport) => ViewPlugin.define((view) => {
  const stepOf = createWheelStepper()
  const onWheel = (event: WheelEvent) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return
    // The text must not scroll while the key is held
    event.preventDefault()
    event.stopPropagation()
    const step = stepOf(event)
    if (step === 0) return
    const kind: NavKind = event.shiftKey ? 'marker' : 'problem'
    report(kind, kind === 'marker' ? goToMarker(view, step, false) : goToProblem(view, step, PROBLEM_LEVELS, false), step)
  }
  view.scrollDOM.addEventListener('wheel', onWheel, { passive: false })
  return { destroy: () => view.scrollDOM.removeEventListener('wheel', onWheel) }
})

function navigationKeys(report: NavReport): Extension {
  const bind = (key: string, kind: NavKind, target: NavTarget) => ({
    key,
    preventDefault: true,
    run: (view: EditorView) => {
      report(kind, kind === 'marker' ? goToMarker(view, target) : goToProblem(view, target), target)
      return true
    }
  })
  const keysFor = (name: string, kind: NavKind) => [
    bind(name, kind, 1), bind(`Shift-${name}`, kind, -1), bind(`Mod-${name}`, kind, 'last'), bind(`Shift-Mod-${name}`, kind, 'first')
  ]
  return Prec.high(keymap.of([...keysFor('F8', 'problem'), ...keysFor('F9', 'marker')]))
}

/**
 * Colours, the problem list, and moving: F8 problems, F9 markers (Shift: previous, Ctrl: last,
 * Ctrl+Shift: first), Alt + wheel. `onState` gets the state whenever the text, the cursor or the
 * markers change (for the status line and the list panel).
 */
export function logExtensions({ isWrapped, onNavigate, onState }: {
  isWrapped: boolean
  onNavigate: NavReport
  onState: (state: EditorState) => void
}): Extension[] {
  return [
    logProblemField,
    levelColours,
    levelTheme,
    wrapSlot.of(isWrapped ? EditorView.lineWrapping : []),
    navigationKeys(onNavigate),
    wheelNavigation(onNavigate),
    EditorView.updateListener.of((update) => {
      const markersChanged = update.startState.field(logMarkerField, false) !== update.state.field(logMarkerField, false)
      if (update.docChanged || update.selectionSet || markersChanged) onState(update.state)
    })
  ]
}
