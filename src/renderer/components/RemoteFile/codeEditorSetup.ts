// CodeMirror setup for the server file window: Windows-style keys, Korean search panel, colours from
// the app theme, and the file's language loaded when known.
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView, crosshairCursor, drawSelection, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import {
  HighlightStyle, LanguageDescription, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'

// Labels of CodeMirror's own panels and gutters
const KOREAN_PHRASES: Record<string, string> = {
  Find: '찾기',
  Replace: '바꿀 내용',
  next: '다음',
  previous: '이전',
  all: '모두 선택',
  'match case': '대소문자 구분',
  regexp: '정규식',
  'by word': '단어 단위',
  replace: '바꾸기',
  'replace all': '모두 바꾸기',
  close: '닫기',
  'Go to line': '줄 이동',
  go: '이동',
  'current match': '현재 항목',
  'on line': '줄',
  'replaced match on line $': '$번째 줄을 바꿨습니다',
  'replaced $ matches': '$개를 바꿨습니다',
  'Folded lines': '접은 줄',
  'Unfolded lines': '펼친 줄',
  to: '~',
  'folded code': '접은 코드',
  unfold: '펼치기',
  'Fold line': '줄 접기',
  'Unfold line': '줄 펼치기',
  'Control character': '제어 문자',
  'Selection deleted': '선택 영역 삭제됨'
}

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier], color: 'var(--code-keyword, #c678dd)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string, #98c379)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number, #d19a66)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-function, #61afef)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property, #e5c07b)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--code-type, #56b6c2)' },
  { tag: [tags.tagName, tags.heading], color: 'var(--code-tag, #e06c75)', fontWeight: '600' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--text-secondary)' },
  { tag: tags.invalid, color: 'var(--error-text)' }
])

const appTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text-primary)', backgroundColor: 'var(--bg-primary)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-alpha) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-modifier-hover)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-modifier-selected)', color: 'var(--text-primary)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 30%, transparent)', outline: '1px solid var(--warning)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--bg-modifier-selected)' },
  '.cm-matchingBracket': { outline: '1px solid var(--accent)', backgroundColor: 'transparent' },
  '.cm-panels': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  // Room on the right so the bigger × does not cover the last option
  '.cm-panel.cm-search': { padding: '6px 40px 6px 10px', fontFamily: 'var(--font-sans)', fontSize: '12.5px' },
  '.cm-panel input[type=text], .cm-textfield': {
    backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)',
    padding: '3px 6px', fontSize: '12.5px'
  },
  '.cm-panel input[type=text]:focus, .cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-button': {
    backgroundImage: 'none', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)',
    border: '1px solid var(--border-strong)', padding: '3px 9px', fontSize: '12px'
  },
  '.cm-button:hover': { backgroundColor: 'var(--bg-modifier-selected)' },
  '.cm-panel.cm-search label': { color: 'var(--text-secondary)', fontSize: '12px' },
  // CodeMirror's own `.cm-panel.cm-search [name=close] { font: inherit }` outranks a plainer selector and
  // left the × at text size; this one is as specific plus the element name, so it wins
  '.cm-panel.cm-search button[name=close]': {
    top: '6px', right: '8px', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: '4px', color: 'var(--text-secondary)', fontSize: '18px', lineHeight: '1', cursor: 'pointer'
  },
  '.cm-panel.cm-search button[name=close]:hover': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' },
  '.cm-panel.cm-search button[name=close]:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '1px' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-hover)', border: 'none', color: 'var(--text-secondary)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }
}, { dark: true })

/** Ctrl+H: the search panel with the cursor in the replace field, as in Windows editors. */
export function openReplacePanel(view: EditorView): boolean {
  openSearchPanel(view)
  requestAnimationFrame(() => {
    const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')
    field?.focus()
    field?.select()
  })
  return true
}

interface EditorOptions {
  readOnly: boolean
  /** Ctrl+S */
  onSave?: () => void
}

/** Keys first that differ from CodeMirror's defaults (Ctrl+G goes to a line here, not to the next match). */
function windowsKeys({ onSave }: EditorOptions): Extension {
  return keymap.of([
    { key: 'Mod-s', run: () => { onSave?.(); return true }, preventDefault: true },
    { key: 'Mod-h', run: openReplacePanel, preventDefault: true },
    { key: 'Mod-g', run: gotoLine, preventDefault: true }
  ])
}

export const languageSlot = new Compartment()

export function editorExtensions(options: EditorOptions, onChange: (state: EditorState) => void, onCursor: (state: EditorState) => void): Extension[] {
  return [
    windowsKeys(options),
    lineNumbers(),
    foldGutter(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlightStyle),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    EditorState.readOnly.of(options.readOnly),
    EditorState.phrases.of(KOREAN_PHRASES),
    EditorState.tabSize.of(4),
    languageSlot.of([]),
    appTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state)
      if (update.docChanged || update.selectionSet) onCursor(update.state)
    })
  ]
}

/** The language support for a file name, loaded on demand; null when none matches. */
export async function languageFor(fileName: string): Promise<Extension | null> {
  const description = LanguageDescription.matchFilename(languages, fileName)
  if (!description) return null
  try {
    return await description.load()
  } catch {
    return null
  }
}
