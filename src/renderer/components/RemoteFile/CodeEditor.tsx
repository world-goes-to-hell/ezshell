import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, Text, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { editorExtensions, languageFor, languageSlot, openReplacePanel } from './codeEditorSetup'

export interface CodeEditorHandle {
  /** The text in the editor (\n line breaks) */
  getText: () => string
  /** Replace the text. `asBaseline`: it is what the server has, so the editor is not dirty afterwards. */
  setText: (text: string, options?: { asBaseline?: boolean }) => void
  /** What the server has now is the current text (after a save) */
  markSaved: () => void
  /** What the server has now is `text`, the editor keeps its own (comparing again after a conflict) */
  setBaseline: (text: string) => void
  focus: () => void
  /** The CodeMirror view, for the log view's own changes (null before mount) */
  getView: () => EditorView | null
}

export interface CursorInfo {
  line: number
  column: number
  selected: number
}

interface CodeEditorProps {
  initialText: string
  fileName: string
  readOnly: boolean
  onDirtyChange?: (isDirty: boolean) => void
  onSave?: () => void
  onCursor?: (cursor: CursorInfo) => void
  /** More CodeMirror extensions, fixed for the editor's life (log colours) */
  extensions?: Extension[]
}

function cursorOf(state: EditorState): CursorInfo {
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  return { line: line.number, column: main.head - line.from + 1, selected: Math.abs(main.to - main.from) }
}

/**
 * CodeMirror in React. The view is made once; the text changes only through the handle, so React
 * re-renders never reset what the user typed. Callbacks are read through refs for the same reason.
 */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({ initialText, fileName, readOnly, onDirtyChange, onSave, onCursor, extensions = [] }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const baselineRef = useRef<Text | null>(null)
  const isDirtyRef = useRef(false)
  const callbacks = useRef({ onDirtyChange, onSave, onCursor })
  callbacks.current = { onDirtyChange, onSave, onCursor }

  const reportDirty = (state: EditorState) => {
    const isDirty = baselineRef.current ? !state.doc.eq(baselineRef.current) : false
    if (isDirty === isDirtyRef.current) return
    isDirtyRef.current = isDirty
    callbacks.current.onDirtyChange?.(isDirty)
  }

  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: initialText,
      extensions: [
        ...extensions,
        editorExtensions(
          { readOnly, onSave: () => callbacks.current.onSave?.() },
          reportDirty,
          (next) => callbacks.current.onCursor?.(cursorOf(next))
        )
      ]
    })
    baselineRef.current = state.doc
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    // The editor's keys only reach the text area; in the find box Ctrl+S and Ctrl+H must work too
    const onPanelKey = (event: KeyboardEvent) => {
      if (view.contentDOM.contains(event.target as Node) || !event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        callbacks.current.onSave?.()
      } else if (key === 'h' && !readOnly) {
        event.preventDefault()
        openReplacePanel(view)
      }
    }
    view.dom.addEventListener('keydown', onPanelKey)
    callbacks.current.onCursor?.(cursorOf(state))
    view.focus()

    let isCancelled = false
    void languageFor(fileName).then((language) => {
      if (!isCancelled && language) view.dispatch({ effects: languageSlot.reconfigure(language) })
    })
    return () => {
      isCancelled = true
      view.dom.removeEventListener('keydown', onPanelKey)
      view.destroy()
      viewRef.current = null
    }
    // Made once per file: the parent remounts the editor (key) for another file or mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    getText: () => viewRef.current?.state.doc.toString() ?? '',
    setText: (text, options = {}) => {
      const view = viewRef.current
      if (!view) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      if (options.asBaseline) baselineRef.current = view.state.doc
      reportDirty(view.state)
    },
    markSaved: () => {
      const view = viewRef.current
      if (!view) return
      baselineRef.current = view.state.doc
      reportDirty(view.state)
    },
    setBaseline: (text) => {
      const view = viewRef.current
      if (!view) return
      baselineRef.current = Text.of(text.split('\n'))
      reportDirty(view.state)
    },
    focus: () => viewRef.current?.focus(),
    getView: () => viewRef.current
  }), [])

  return <div className="remote-file-editor" ref={hostRef} />
})
