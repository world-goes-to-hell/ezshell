import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { RiArrowRightUpLine, RiGlobalLine, RiHistoryLine, RiStarFill, RiStarLine } from 'react-icons/ri'
import { useBrowserBookmarkStore } from '../../stores/browserBookmarkStore'
import { inlineCompletion, suggestAddresses, type AddressSuggestion } from '../../lib/browserAddressSuggestions'

/**
 * The browser tab's address bar. It suggests pages visited or bookmarked before: a list under the bar
 * (arrow keys, Enter, click) and the best address that begins with the typed text completed inline, the
 * added part selected so typing on replaces it (2026-11-26 user request).
 * The list lies over the page, which is a native view above the app: BrowserReview hides the page while
 * the list is shown (`.browser-address-suggestions` is one of its app overlays).
 */
export function BrowserAddressBar({ url, localFile, bookmarked, disabledBookmark, onToggleBookmark, onNavigate }: {
  url: string
  localFile: string | undefined
  bookmarked: boolean
  disabledBookmark: boolean
  onToggleBookmark: () => void
  onNavigate: (address: string) => void
}) {
  const localPreview = localFile !== undefined
  const history = useBrowserBookmarkStore(store => store.history)
  const bookmarks = useBrowserBookmarkStore(store => store.bookmarks)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [address, setAddress] = useState('')
  // What the user typed: the address may hold more, an inline completion or a highlighted suggestion
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  // The page an inline completion or highlighted suggestion stands for, while the address still shows it
  const [chosen, setChosen] = useState<{ text: string; url: string } | null>(null)
  const pendingSelection = useRef<[number, number] | null>(null)
  // Each completion renders again: typing the next letter of the same completion leaves the address as it
  // was, and React would skip the render that selects the added part
  const [completions, setCompletions] = useState(0)
  const suggestions = useMemo(() => localPreview ? [] : suggestAddresses(typed, history, bookmarks), [localPreview, typed, history, bookmarks])
  const showList = open && suggestions.length > 0

  useEffect(() => {
    setAddress(localFile ?? url)
    setOpen(false)
    setChosen(null)
  }, [localFile, url])

  useLayoutEffect(() => {
    const range = pendingSelection.current
    pendingSelection.current = null
    if (range && input.current === document.activeElement) input.current?.setSelectionRange(range[0], range[1])
  }, [address, completions])

  function close() {
    setOpen(false)
    setHighlight(-1)
  }

  function complete(value: string) {
    const completion = inlineCompletion(value, suggestAddresses(value, history, bookmarks))
    if (!completion) return
    pendingSelection.current = [value.length, completion.text.length]
    setCompletions(count => count + 1)
    setAddress(completion.text)
    setChosen(completion)
  }

  function change(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value
    const native = event.nativeEvent as InputEvent
    setAddress(value)
    setTyped(value)
    setChosen(null)
    setHighlight(-1)
    setOpen(true)
    const atEnd = event.target.selectionStart === value.length
    // Only while typing on at the end: deleting must not bring the completion back, and an IME
    // completes once its composition ends
    if (atEnd && native.inputType?.startsWith('insert') && !native.isComposing) complete(value)
  }

  function go(target: string) {
    close()
    if (target.trim()) onNavigate(target)
  }

  function pick(index: number) {
    const suggestion: AddressSuggestion | undefined = suggestions[index]
    setHighlight(index)
    if (!suggestion) {
      setAddress(typed)
      setChosen(null)
      return
    }
    setAddress(suggestion.display)
    setChosen({ text: suggestion.display, url: suggestion.url })
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (showList && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      // Past either end comes back to what was typed (-1)
      const next = highlight + step < -1 ? suggestions.length - 1 : highlight + step >= suggestions.length ? -1 : highlight + step
      pick(next)
    } else if (event.key === 'Escape' && (showList || chosen)) {
      event.preventDefault()
      event.stopPropagation()
      close()
      setAddress(typed)
      setChosen(null)
    }
  }

  return (
    <form className="browser-review-address" onSubmit={event => {
      event.preventDefault()
      if (!localPreview) go(chosen && address === chosen.text ? chosen.url : address)
    }}>
      <RiGlobalLine aria-hidden="true" />
      <input ref={input} type="text" inputMode="url" aria-label={localPreview ? '로컬 파일 경로' : '웹 주소'}
        placeholder="https://example.com 또는 localhost:5173" readOnly={localPreview} title={localFile}
        role={localPreview ? undefined : 'combobox'} aria-autocomplete={localPreview ? undefined : 'both'}
        aria-expanded={localPreview ? undefined : showList} aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        value={address} spellCheck={false} autoComplete="off" autoFocus
        onFocus={event => { event.target.select(); setTyped(event.target.value) }}
        onBlur={close}
        onChange={change}
        onCompositionEnd={event => {
          const target = event.currentTarget
          if (target.selectionStart === target.value.length) complete(target.value)
        }}
        onKeyDown={keyDown} />
      {!localPreview && <>
        <button type="submit" title="주소 열기" aria-label="주소 열기" disabled={!address.trim()}>
          <RiArrowRightUpLine />
        </button>
        <button type="button" className="browser-review-bookmark" aria-label="현재 페이지 즐겨찾기"
          aria-pressed={bookmarked} title={bookmarked ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'}
          disabled={disabledBookmark} onClick={onToggleBookmark}>
          {bookmarked ? <RiStarFill aria-hidden="true" /> : <RiStarLine aria-hidden="true" />}
        </button>
      </>}
      {showList && (
        <ul className="browser-address-suggestions" id={listId} role="listbox" aria-label="방문한 페이지">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.url} id={`${listId}-${index}`} role="option" aria-selected={index === highlight}
              // Pressing must not blur the address first: the blur closes the list
              onMouseDown={event => event.preventDefault()}
              onClick={() => go(suggestion.url)}>
              <RiHistoryLine aria-hidden="true" />
              <span className="browser-address-suggestion-url">{suggestion.display}</span>
              {suggestion.title && <span className="browser-address-suggestion-title">{suggestion.title}</span>}
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
