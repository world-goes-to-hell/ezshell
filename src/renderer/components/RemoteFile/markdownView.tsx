// How a Markdown file is shown in the edit window: the editor (일반), the document (마크다운), or both
// side by side (나란히) with a divider to drag. Side by side, the document follows the typing.
// The editor stays mounted in every mode (it holds the text, the undo history and the unsaved state).
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { RiCodeLine, RiLayoutColumnLine, RiMarkdownLine } from 'react-icons/ri'
import type { CodeEditorHandle } from './CodeEditor'
import { DEFAULT_SPLIT, loadSplit, saveSplit, splitAt } from '../../lib/markdownSplit'

export type MarkdownMode = 'code' | 'markdown' | 'split'

// Typing side by side redraws the document this long after the last key
const FOLLOW_MS = 150

export function useMarkdownView(editorRef: RefObject<CodeEditorHandle | null>, isMarkdown: boolean, isComparing: boolean) {
  const [mode, setModeState] = useState<MarkdownMode>('code')
  const [text, setText] = useState('')
  const [split, setSplit] = useState(loadSplit)
  const bodyRef = useRef<HTMLDivElement>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const timer = useRef<number | undefined>(undefined)

  const shown: MarkdownMode = isMarkdown && !isComparing ? mode : 'code'
  const setMode = useCallback((next: MarkdownMode) => {
    if (next !== 'code') setText(editorRef.current?.getText() ?? '')
    setModeState(next)
  }, [editorRef])

  // Given to the editor once (its extensions are fixed for its life); reads the mode through a ref
  const followTyping: Extension = useMemo(() => EditorView.updateListener.of((update) => {
    if (!update.docChanged || modeRef.current !== 'split') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setText(update.view.state.doc.toString()), FOLLOW_MS)
  }), [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Dragging the divider: listeners on the window from the press (the 6px handle is left at once)
  const startDrag = (event: ReactPointerEvent) => {
    const body = bodyRef.current
    if (!body || event.button !== 0) return
    event.preventDefault()
    const { left, width } = body.getBoundingClientRect()
    let latest = split
    const move = (moveEvent: PointerEvent) => {
      latest = splitAt(moveEvent.clientX, left, width)
      setSplit(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing-markdown')
      saveSplit(latest)
    }
    document.body.classList.add('is-resizing-markdown')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const resetSplit = () => {
    setSplit(DEFAULT_SPLIT)
    saveSplit(DEFAULT_SPLIT)
  }

  return { mode: shown, setMode, text, split, bodyRef, followTyping, startDrag, resetSplit }
}

const OPTIONS: Array<{ mode: MarkdownMode; label: string; title: string; Icon: typeof RiCodeLine }> = [
  { mode: 'code', label: '일반', title: '일반 보기 (편집)', Icon: RiCodeLine },
  { mode: 'split', label: '나란히', title: '편집과 마크다운을 나란히 (가운데 선을 끌어 폭 조절)', Icon: RiLayoutColumnLine },
  { mode: 'markdown', label: '마크다운', title: '마크다운 보기', Icon: RiMarkdownLine }
]

export function MarkdownViewSwitch({ mode, onMode }: { mode: MarkdownMode; onMode: (mode: MarkdownMode) => void }) {
  return (
    <div className="remote-view-switch" role="group" aria-label="보기 방식">
      {OPTIONS.map(({ mode: option, label, title, Icon }) => (
        <button key={option} type="button" className={`remote-view-option${mode === option ? ' is-active' : ''}`} aria-pressed={mode === option} onClick={() => onMode(option)} title={title} data-mode={option}>
          <Icon size={15} aria-hidden="true" /><span>{label}</span>
        </button>
      ))}
    </div>
  )
}

export function MarkdownDivider({ onPointerDown, onReset }: { onPointerDown: (event: ReactPointerEvent) => void; onReset: () => void }) {
  return (
    <div
      className="markdown-split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="편집기와 마크다운 사이 (끌어서 폭 조절, 두 번 눌러 반반)"
      title="끌어서 폭 조절 · 두 번 눌러 반반"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  )
}
