import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, FormEvent } from 'react'
import {
  RiArrowDownSLine, RiArrowLeftLine, RiArrowRightLine, RiArrowRightUpLine, RiBookmark3Line, RiCloseLine,
  RiCodeSSlashLine, RiCursorLine, RiGlobalLine, RiImageAddLine, RiKey2Line, RiRefreshLine, RiSendPlane2Line, RiStarFill, RiStarLine, RiToolsLine
} from 'react-icons/ri'
import type { BrowserReviewAction, BrowserReviewState, LocalAgentStatus } from '../../types'
import { uncoveredBox } from '../../lib/browserViewClip'
import { hasBookmark, useBrowserBookmarkStore } from '../../stores/browserBookmarkStore'
import { BrowserReviewHistory } from './BrowserReviewHistory'
import { BrowserLoginsDialog } from './BrowserLoginsDialog'
import { BrowserDataImportDialog } from './BrowserDataImportDialog'
import { BrowserSavedPages } from './BrowserSavedPages'
import './BrowserReview.css'

const statusLabels: Record<LocalAgentStatus, string> = {
  unknown: '연결됨', starting: '시작 중', idle: '대기 중', working: '작업 중',
  blocked: '응답 필요', error: '오류', ended: '종료됨', sleeping: '잠듦'
}

const MAX_ADDRESS_LENGTH = 4096

const appOverlays = '[role="menu"], [role="dialog"], [role="alertdialog"], .context-menu, .tab-context-menu, .command-palette-overlay, .modal-overlay, .batch-overlay'
/** Panels that slide over the tab from a side: the page narrows to give way instead of hiding */
const sidePanels = '.sidebar.rail.peek-open .sidebar-panel, .sidebar-popover, .mcp-activity-panel:not(.is-window)'

type BrowserTool = 'element-picker'

export default function BrowserReview({ tabId, isVisible, onActivate }: {
  tabId: string
  isVisible: boolean
  onActivate: () => void
}) {
  const api = window.electronAPI
  const viewport = useRef<HTMLDivElement>(null)
  const bookmarksButton = useRef<HTMLButtonElement>(null)
  const importButton = useRef<HTMLButtonElement>(null)
  const loginsButton = useRef<HTMLButtonElement>(null)
  const [state, setState] = useState<BrowserReviewState | null>(null)
  const [address, setAddress] = useState('')
  const [agentId, setAgentId] = useState('')
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<{ id: string; url: string }[]>([])
  const previewUrls = useRef(new Map<string, string>())
  const draftBusy = useRef(false)
  const [readingImages, setReadingImages] = useState(false)
  const [browserError, setBrowserError] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const [sending, setSending] = useState(false)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [expandedBookmarkFolders, setExpandedBookmarkFolders] = useState<ReadonlySet<string>>(() => new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [loginsOpen, setLoginsOpen] = useState<boolean | { profileId?: string }>(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [openTool, setOpenTool] = useState<BrowserTool | null>(null)
  const bookmarks = useBrowserBookmarkStore(store => store.bookmarks)
  const toggleBookmark = useBrowserBookmarkStore(store => store.toggleBookmark)
  const bookmarksId = useId()
  const toolsId = useId()
  const elementPickerId = `${toolsId}-element-picker`
  const agentFieldId = `${elementPickerId}-agent`
  const draftFieldId = `${elementPickerId}-draft`
  const url = state?.url ?? ''
  const localFile = state?.localFile
  const localPreview = localFile !== undefined
  const selection = state?.selection
  const agents = state?.agents ?? []
  const recipient = agents.find(agent => agent.id === agentId)
  const elementPickerOpen = toolsOpen && openTool === 'element-picker'
  const canPick = Boolean(!localPreview && url && !state?.loading && !state?.error)
  const bookmarked = hasBookmark(bookmarks, url)

  useEffect(() => {
    let mounted = true
    const off = api.onBrowserReviewState((id, next) => { if (id === tabId) setState(next) })
    void api.browserReviewState(tabId).then(next => {
      if (mounted && next) setState(next)
    }).catch(() => { if (mounted) setBrowserError('브라우저 상태를 불러올 수 없습니다.') })
    return () => { mounted = false; off() }
  }, [api, tabId])

  useEffect(() => { setAddress(localFile ?? url) }, [localFile, url])
  useEffect(() => { if (!isVisible) setLoginsOpen(false) }, [isVisible])

  const releaseAttachment = useCallback((id: string) => {
    const url = previewUrls.current.get(id)
    if (url) URL.revokeObjectURL(url)
    previewUrls.current.delete(id)
    api.browserReviewRemoveImage(tabId, id)
  }, [api, tabId])

  useEffect(() => {
    const urls = previewUrls.current
    return () => { for (const id of urls.keys()) releaseAttachment(id) }
  }, [releaseAttachment])

  useEffect(() => api.onBrowserReviewFocus(id => { if (id === tabId && isVisible) onActivate() }), [api, isVisible, onActivate, tabId])

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || !isVisible) {
      api.browserReviewBounds(tabId, null)
      return
    }
    let frame = 0
    let lastBounds: string | undefined
    const report = () => {
      frame = 0
      // The page has a native view above this renderer. Hide it while the app draws a popup over it.
      const blocked = !element.isConnected || !element.checkVisibility({ visibilityProperty: true })
        || Array.from(document.querySelectorAll(appOverlays)).some(overlay => overlay.checkVisibility({ visibilityProperty: true }))
      const panels = Array.from(document.querySelectorAll(sidePanels)).filter(panel => panel.checkVisibility({ visibilityProperty: true }))
      // A panel still sliding in has no final edge yet: hide the page until it settles (transitionend)
      const sliding = panels.some(panel => panel.getAnimations().some(animation => animation.playState === 'running'))
      const { x, y, width, height } = element.getBoundingClientRect()
      const titleTip = document.querySelector('.browser-tab-title-tooltip.is-visible')?.getBoundingClientRect()
      const tipOverPage = titleTip && titleTip.left < x + width && titleTip.right > x && titleTip.top < y + height && titleTip.bottom > y
      const bounds = blocked || sliding || tipOverPage ? null : uncoveredBox({ x, y, width, height }, panels.map(panel => panel.getBoundingClientRect()))
      const key = bounds ? [bounds.x, bounds.y, bounds.width, bounds.height].join(',') : ''
      if (lastBounds === key) return
      lastBounds = key
      api.browserReviewBounds(tabId, bounds)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(report)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const layout = new MutationObserver(schedule)
    layout.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-state', 'hidden'] })
    window.addEventListener('resize', schedule)
    document.addEventListener('transitionend', schedule, true)
    document.addEventListener('transitioncancel', schedule, true)
    schedule()
    return () => {
      resize.disconnect()
      layout.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('transitionend', schedule, true)
      document.removeEventListener('transitioncancel', schedule, true)
      window.cancelAnimationFrame(frame)
      api.browserReviewBounds(tabId, null)
    }
  }, [api, isVisible, tabId])

  async function act(action: BrowserReviewAction) {
    setBrowserError('')
    try {
      const result = await api.browserReviewAction(tabId, action)
      if (!result.success) setBrowserError(result.error)
    } catch {
      setBrowserError('브라우저 동작을 완료할 수 없습니다.')
    }
  }

  function closeBookmarks() {
    setBookmarksOpen(false)
    bookmarksButton.current?.focus({ preventScroll: true })
  }

  function toggleTools() {
    if (toolsOpen) {
      if (elementPickerOpen) void act({ type: 'cancel' })
      setOpenTool(null)
    }
    setToolsOpen(!toolsOpen)
  }

  function toggleElementPicker() {
    if (elementPickerOpen) {
      setOpenTool(null)
      void act({ type: 'cancel' })
      return
    }
    setOpenTool('element-picker')
    if (canPick && !selection) {
      setFeedback(null)
      void act({ type: 'pick' })
    }
  }

  async function addImages(source: 'files' | 'clipboard') {
    if (draftBusy.current) return
    const mountedViewport = viewport.current
    draftBusy.current = true
    setReadingImages(true)
    setFeedback(null)
    try {
      const result = await api.browserReviewAddImages(tabId, source)
      if (viewport.current !== mountedViewport) {
        if (result.ok && result.kind === 'images') {
          for (const { id } of result.images) releaseAttachment(id)
        }
        return
      }
      if (!result.ok) {
        setFeedback({ text: result.error, error: true })
      } else if (result.kind === 'images') {
        const added = result.images.map(({ id, preview }) => {
          const url = URL.createObjectURL(new Blob([preview], { type: 'image/png' }))
          previewUrls.current.set(id, url)
          return { id, url }
        })
        if (added.length) setAttachments(current => [...current, ...added])
      } else {
        setFeedback({ text: '붙여넣을 이미지를 읽을 수 없습니다.', error: true })
      }
    } catch {
      setFeedback({ text: '첨부할 이미지를 읽을 수 없습니다.', error: true })
    } finally {
      draftBusy.current = false
      setReadingImages(false)
    }
  }

  function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const { clipboardData } = event
    if (clipboardData.getData('text/plain') || !Array.from(clipboardData.items).some(item => item.type.startsWith('image/'))) return
    event.preventDefault()
    void addImages('clipboard')
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!selection || !recipient || (!text && !attachments.length) || draftBusy.current) return
    draftBusy.current = true
    setSending(true)
    setFeedback(null)
    try {
      const result = await api.browserReviewAction(tabId, {
        type: 'send', selectionId: selection.id, agentId, text, imageIds: attachments.map(image => image.id)
      })
      if (result.success) {
        for (const { id } of attachments) releaseAttachment(id)
        setAttachments([])
        setDraft('')
        setFeedback({ text: `${recipient.id}에게 수정 요청을 보냈습니다.` })
      } else {
        setFeedback({ text: result.error, error: true })
      }
    } catch {
      setFeedback({ text: '수정 요청을 보내지 못했습니다.', error: true })
    } finally {
      draftBusy.current = false
      setSending(false)
    }
  }

  return (
    <section className="browser-review" data-browser-tab-id={tabId} aria-label="브라우저">
      <header className="browser-review-toolbar">
        <div className="browser-review-navigation">
          <button type="button" title="뒤로" aria-label="뒤로" disabled={!state?.canGoBack} onClick={() => void act({ type: 'back' })}>
            <RiArrowLeftLine />
          </button>
          <button type="button" title="앞으로" aria-label="앞으로" disabled={!state?.canGoForward} onClick={() => void act({ type: 'forward' })}>
            <RiArrowRightLine />
          </button>
          <button type="button" title="새로고침" aria-label="새로고침" disabled={!url || state?.loading} onClick={() => void act({ type: 'reload' })}>
            <RiRefreshLine className={state?.loading ? 'browser-review-spinning' : ''} />
          </button>
        </div>
        <form className="browser-review-address" onSubmit={event => {
          event.preventDefault()
          if (!localPreview) void act({ type: 'navigate', address })
        }}>
          <RiGlobalLine aria-hidden="true" />
          <input type="text" inputMode="url" aria-label={localPreview ? '로컬 파일 경로' : '웹 주소'} placeholder="https://example.com 또는 localhost:5173"
            readOnly={localPreview} title={localFile}
            value={address} spellCheck={false} autoFocus onFocus={event => event.target.select()}
            onChange={event => setAddress(event.target.value)} />
          {!localPreview && <>
            <button type="submit" title="주소 열기" aria-label="주소 열기" disabled={!address.trim()}>
              <RiArrowRightUpLine />
            </button>
            <button type="button" className="browser-review-bookmark" aria-label="현재 페이지 즐겨찾기"
              aria-pressed={bookmarked} title={bookmarked ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'}
              disabled={!bookmarked && (!canPick || url.length > MAX_ADDRESS_LENGTH)}
              onClick={() => state && toggleBookmark(state)}>
              {bookmarked ? <RiStarFill aria-hidden="true" /> : <RiStarLine aria-hidden="true" />}
            </button>
          </>}
        </form>
        {!localPreview && <>
          <button ref={bookmarksButton} type="button" className="browser-review-bookmarks-toggle" title="즐겨찾기 및 방문 기록"
            aria-label="즐겨찾기 및 방문 기록" aria-expanded={bookmarksOpen} aria-controls={bookmarksId}
            onClick={() => setBookmarksOpen(open => !open)}>
            <RiBookmark3Line aria-hidden="true" />
          </button>
          <button ref={loginsButton} type="button" className="browser-review-logins" title="로그인 정보" aria-label="로그인 정보"
            aria-haspopup="dialog" aria-expanded={!!loginsOpen} onClick={() => setLoginsOpen(true)}>
            <RiKey2Line aria-hidden="true" />
          </button>
        </>}
        {/* The page's own developer tools, in a window of their own (F12 / Ctrl+Shift+I in the page too) */}
        <button type="button" className="browser-review-devtools" disabled={!url}
          title={state?.devToolsOpen ? '개발자 도구 닫기 (F12)' : '개발자 도구 열기 (F12)'} aria-label="개발자 도구"
          aria-pressed={!!state?.devToolsOpen} onClick={() => void act({ type: 'devtools' })}>
          <RiCodeSSlashLine aria-hidden="true" />
        </button>
        {!localPreview && <button type="button" className="browser-review-tools-toggle" title="브라우저 부가기능" aria-label="브라우저 부가기능"
          aria-expanded={toolsOpen} aria-controls={toolsId} onClick={toggleTools}>
          <RiToolsLine aria-hidden="true" />
        </button>}
      </header>
      {isVisible && loginsOpen && <BrowserLoginsDialog tabId={tabId} origin={state?.loginOrigin ?? null}
        trigger={loginsButton.current} importOptions={typeof loginsOpen === 'object' ? loginsOpen : undefined}
        onClose={() => setLoginsOpen(false)} />}
      {isVisible && importOpen && <BrowserDataImportDialog tabId={tabId} trigger={importButton.current} onClose={() => setImportOpen(false)}
        onShowPasswords={profileId => { setImportOpen(false); setLoginsOpen({ profileId }) }} />}
      {bookmarksOpen && (
        <BrowserSavedPages id={bookmarksId} importTrigger={importButton} expandedFolders={expandedBookmarkFolders}
          onExpandedFoldersChange={setExpandedBookmarkFolders} onImport={() => setImportOpen(true)} onClose={closeBookmarks}
          onNavigate={address => { closeBookmarks(); void act({ type: 'navigate', address }) }} />
      )}
      {browserError && <p className="browser-review-error" role="alert">{browserError}</p>}
      <div className={`browser-review-workspace${toolsOpen ? ' has-tools' : ''}`}>
        <div className="browser-review-viewport" ref={viewport}>
          {(!url || state?.error) && <div className="browser-review-placeholder">
            <RiGlobalLine aria-hidden="true" />
            <p role={state?.error ? 'alert' : undefined}>{state?.error || '주소를 입력해 웹페이지를 열어 주세요.'}</p>
          </div>}
        </div>
        {toolsOpen && (
          <aside className="browser-review-tools" id={toolsId} aria-label="브라우저 부가기능">
            <div className="browser-review-tool">
              <button type="button" className="browser-review-tool-toggle" aria-expanded={elementPickerOpen}
                aria-controls={elementPickerId} onClick={toggleElementPicker}>
                <RiCursorLine aria-hidden="true" />
                <span>요소 선택</span>
                <RiArrowDownSLine className="browser-review-tool-chevron" aria-hidden="true" />
              </button>
              {elementPickerOpen && (
                <form className="browser-review-compose" id={elementPickerId} onSubmit={send}>
                  <div className="browser-review-compose-head">
                    <h1>요소 수정 요청</h1>
                    <button type="button" className="browser-review-pick" aria-pressed={Boolean(state?.picking)}
                      aria-label={state?.picking ? '선택 취소' : '페이지에서 요소 선택'}
                      title={state?.picking ? '선택 취소' : '페이지에서 요소 선택'}
                      disabled={!canPick}
                      onClick={() => { setFeedback(null); void act({ type: state?.picking ? 'cancel' : 'pick' }) }}>
                      <RiCursorLine aria-hidden="true" />
                    </button>
                  </div>
                  {selection ? (
                    <div className="browser-review-selection" aria-label="선택된 요소">
                      <span className="browser-review-selection-tag">{selection.tag}</span>
                      <code title={selection.selector}>{selection.selector}</code>
                      {(selection.text || selection.label) && <span className="browser-review-selection-label">{selection.text || selection.label}</span>}
                      {selection.classes.length > 0 && <span className="browser-review-selection-label" title={selection.classes.join(' ')}>{selection.classes.join(' ')}</span>}
                      {(selection.component || selection.componentFile) && (
                        <span className="browser-review-component" title={selection.componentFile}>{selection.component ?? selection.componentFile}</span>
                      )}
                    </div>
                  ) : (
                    <div className="browser-review-selection browser-review-selection-empty">
                      {state?.picking ? '페이지에서 수정할 요소를 클릭하세요. Esc로 취소할 수 있습니다.'
                        : canPick ? '요소 선택 버튼을 눌러 수정할 곳을 고르세요.' : '페이지를 열면 요소를 선택할 수 있습니다.'}
                    </div>
                  )}
                  <label htmlFor={agentFieldId}>받는 에이전트</label>
                  <select id={agentFieldId} value={recipient?.id ?? ''} disabled={!agents.length || sending}
                    onChange={event => { setAgentId(event.target.value); setFeedback(null) }}>
                    <option value="">{agents.length ? '에이전트 선택' : '연결된 에이전트 없음'}</option>
                    {agents.map(agent => (
                      <option key={agent.id} value={agent.id}>{agent.id} · {statusLabels[agent.status]} · {agent.cwd}</option>
                    ))}
                  </select>
                  {!agents.length && <p className="browser-review-hint">ezShell 터미널에서 Codex 또는 Claude Code를 실행하면 여기에 표시됩니다.</p>}
                  <label htmlFor={draftFieldId}>수정 요청</label>
                  <textarea id={draftFieldId} value={draft} maxLength={4000} disabled={sending}
                    placeholder="예: 이 버튼의 문구를 ‘저장’으로 바꿔줘."
                    onPaste={pasteImage}
                    onChange={event => { setDraft(event.target.value); setFeedback(null) }} />
                  {attachments.length > 0 && (
                    <ul className="browser-review-attachments" aria-label="첨부 이미지">
                      {attachments.map(({ id, url }, index) => (
                        <li key={id}>
                          <img src={url} alt={`첨부 이미지 ${index + 1}`} />
                          <button type="button" aria-label={`이미지 ${index + 1} 첨부 제거`} title="이미지 첨부 제거"
                            disabled={sending || readingImages} onClick={() => {
                              releaseAttachment(id)
                              setAttachments(current => current.filter(image => image.id !== id))
                              setFeedback(null)
                            }}><RiCloseLine aria-hidden="true" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className="browser-review-add-image" disabled={sending || readingImages}
                    title="이미지 파일을 선택하거나 수정 요청란에 스크린샷을 붙여넣으세요." onClick={() => void addImages('files')}>
                    <RiImageAddLine aria-hidden="true" />{readingImages ? '이미지 읽는 중…' : '이미지 첨부'}
                  </button>
                  <button type="submit" className="browser-review-send"
                    disabled={!selection || !recipient || (!draft.trim() && !attachments.length) || sending || readingImages}>
                    <RiSendPlane2Line /> {sending ? '보내는 중…' : '에이전트에게 보내기'}
                  </button>
                  {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'browser-review-compose-error' : 'browser-review-feedback'}>
                    {feedback.text}
                  </p>}
                  <BrowserReviewHistory />
                </form>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  )
}
