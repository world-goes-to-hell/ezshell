import { EditorState, Prec, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import {
  addMarker, removeMarker, logMarkerField, markerAtEnd, markersOf, toggleMarkerAtLine, MAX_MARKERS,
  type LogMarker
} from '../../lib/logMarkers'

/** "15:42:10" */
export function clockTime(date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export type MarkerNotice = 'limit' | 'duplicate'

/** A band above the marked line: label and a remove button. Not text in the document. */
class MarkerWidget extends WidgetType {
  constructor(private readonly marker: LogMarker) { super() }

  eq(other: MarkerWidget): boolean {
    return other.marker.id === this.marker.id && other.marker.time === this.marker.time
  }

  toDOM(view: EditorView): HTMLElement {
    const band = document.createElement('div')
    band.className = 'cm-log-marker'
    const label = document.createElement('span')
    label.className = 'cm-log-marker-label'
    label.textContent = `기준점 ${this.marker.id} · ${this.marker.time}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'cm-log-marker-remove'
    remove.textContent = '✕'
    remove.title = `기준점 ${this.marker.id} 지우기`
    remove.setAttribute('aria-label', `기준점 ${this.marker.id} 지우기`)
    remove.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ effects: removeMarker.of(this.marker.id) })
    })
    band.append(label, remove)
    return band
  }

  /** Clicks on the band do not move the cursor or start a selection */
  ignoreEvent(): boolean {
    return true
  }
}

const markerDecorations = EditorView.decorations.compute([logMarkerField], (state) =>
  Decoration.set(markersOf(state).map(marker =>
    Decoration.widget({ widget: new MarkerWidget(marker), block: true, side: -1 }).range(marker.pos)
  ))
)

const markerTheme = EditorView.baseTheme({
  '.cm-log-marker': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '2px 0',
    padding: '1px 8px',
    borderTop: '2px solid var(--accent, #f5c451)',
    background: 'var(--accent-alpha, rgba(245, 196, 81, 0.12))',
    color: 'var(--accent, #f5c451)',
    fontFamily: 'var(--font-sans, inherit)',
    fontSize: '11.5px',
    fontWeight: '600',
    lineHeight: '18px'
  },
  '.cm-log-marker-label': { flex: '1' },
  '.cm-log-marker-remove': {
    border: 'none',
    background: 'none',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '11px',
    opacity: '0.7',
    padding: '0 2px'
  },
  '.cm-log-marker-remove:hover': { opacity: '1' },
  '.cm-lineNumbers .cm-gutterElement': { cursor: 'pointer' }
})

/** Adds a marker at the end of the log, unless the limit is reached or one is already there */
export function addMarkerAtEnd(view: EditorView, onNotice: (notice: MarkerNotice) => void): boolean {
  const { state } = view
  const target = markerAtEnd(state, clockTime())
  if (markersOf(state).some(m => m.pos === target.pos)) {
    onNotice('duplicate')
    return false
  }
  if (markersOf(state).length >= MAX_MARKERS) {
    onNotice('limit')
    return false
  }
  view.dispatch({ effects: addMarker.of(target) })
  return true
}

/** Clicking a line number puts a marker above that line, or takes it away */
const lineNumberClicks = (onNotice: (notice: MarkerNotice) => void) => ViewPlugin.define((view) => {
  const onDown = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.cm-lineNumbers .cm-gutterElement')) return
    const block = view.lineBlockAtHeight(event.clientY - view.documentTop)
    const line = view.state.doc.lineAt(block.from).number
    const effect = toggleMarkerAtLine(view.state, line, clockTime())
    if (effect.is(addMarker) && markersOf(view.state).length >= MAX_MARKERS) {
      onNotice('limit')
      return
    }
    event.preventDefault()
    view.dispatch({ effects: effect })
  }
  view.dom.addEventListener('mousedown', onDown)
  return { destroy: () => view.dom.removeEventListener('mousedown', onDown) }
})

/**
 * Markers for the log view: the field, the bands, line-number clicks and Ctrl+M (marker at the end).
 * `onChange` gets the state whenever the markers or the document change (for the status line).
 */
export function logMarkerExtensions({ onChange, onNotice }: {
  onChange: (state: EditorState) => void
  onNotice: (notice: MarkerNotice) => void
}): Extension[] {
  return [
    logMarkerField,
    markerDecorations,
    markerTheme,
    lineNumberClicks(onNotice),
    Prec.high(keymap.of([{ key: 'Mod-m', run: (view) => { addMarkerAtEnd(view, onNotice); return true }, preventDefault: true }])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.startState.field(logMarkerField) !== update.state.field(logMarkerField)) onChange(update.state)
    })
  ]
}
