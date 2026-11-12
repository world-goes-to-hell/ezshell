import { INITIAL_PACE, RETRY_MS, nextPace, waitFor } from '../../lib/logPollPace'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RiArrowDownLine, RiArrowDownSLine, RiArrowUpSLine, RiEyeLine, RiFlagLine, RiPauseLine, RiPlayLine, RiRefreshLine } from 'react-icons/ri'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { CodeEditor, type CodeEditorHandle, type CursorInfo } from './CodeEditor'
import { appendLog, isAtBottom, jumpToLevel, logExtensions, scrollToEnd, PROBLEM_LEVELS, type JumpOutcome } from './logView'
import type { JumpLevel } from '../../lib/logLevels'
import { countLevels, NO_COUNTS, type LevelCounts } from '../../lib/logAppend'
import { markerLine } from '../../lib/logLevels'
import type { RemoteFileLoaded, RemoteFileTailResult } from '../../types'
import { formatBytes } from '../../lib/mcpLabels'
import { fileNameOf, toEditorText } from '../../lib/remoteFileText'
import { toast } from '../../stores/toastStore'
import { addMarkerAtEnd, logMarkerExtensions, type MarkerNotice } from './logMarkerView'
import { logMarkerField, markerSummary, neighbourMarker, MAX_MARKERS, type LogMarker } from '../../lib/logMarkers'

export type TextPreviewFile = Extract<RemoteFileLoaded, { kind: 'text'; editable: false }>

// The wait between looks follows the log (lib/logPollPace): 0.2s while lines arrive, back to 1s when
// quiet, 5s while hidden; a failed look waits 3s. The next look is set only after the previous answer
// came, so looks never pile up on a slow server.
// The window keeps the latest ~5MB of text; past that the oldest lines go (down to 4MB)
const LIMITS = { maxChars: 5_000_000, keepChars: 4_000_000 }

type Follow =
  | { kind: 'off' }
  | { kind: 'live'; note?: string }
  | { kind: 'error'; message: string }

interface RemoteLogViewProps {
  docId: string
  file: TextPreviewFile
  onRefresh: () => void
}

/** The line the window adds before text that does not simply continue what is shown. */
function markerFor(result: Extract<RemoteFileTailResult, { text: string }>): string | null {
  const skipped = result.status !== 'append' && result.skippedBytes ? `${formatBytes(result.skippedBytes)} 건너뜀` : ''
  if (result.status === 'rotated') return markerLine(skipped ? `파일이 새로 시작됨 · 앞 ${skipped}` : '파일이 새로 시작됨')
  if (result.status === 'skipped') return markerLine(`한 번에 읽는 양(1MB)을 넘어 ${skipped}`)
  return null
}

function followLabel(follow: Follow, isTailMode: boolean): string {
  if (follow.kind === 'live') return follow.note ? `실시간 · ${follow.note}` : '실시간'
  if (follow.kind === 'error') return `${follow.message} · 다시 연결되면 이어서 봅니다`
  return isTailMode ? '일시정지' : '미리보기 (읽기 전용)'
}

const ERROR_ONLY: ReadonlySet<JumpLevel> = new Set<JumpLevel>(['error'])
const WARN_ONLY: ReadonlySet<JumpLevel> = new Set<JumpLevel>(['warn'])

function reportMarkerNotice(notice: MarkerNotice): void {
  if (notice === 'limit') toast.info(`기준점은 ${MAX_MARKERS}개까지 둘 수 있습니다`, '띠의 ✕ 로 지운 뒤 다시 찍어 주세요')
  else toast.info('로그 끝에 이미 기준점이 있습니다', '새 줄이 쌓인 뒤에 다시 찍을 수 있습니다')
}

function reportJump(outcome: JumpOutcome, name: string): void {
  if (outcome === 'none') toast.info(`다른 ${name} 줄이 없습니다`)
  else if (outcome === 'wrapped') toast.info('끝을 지나 처음부터 다시 찾았습니다')
}

/** A text file to look at, and a log to follow ("실시간 보기"): errors red, warnings yellow, F8 between errors. Nothing here writes to the server. */
export function RemoteLogView({ docId, file, onRefresh }: RemoteLogViewProps) {
  const editorRef = useRef<CodeEditorHandle>(null)
  const isTailMode = file.mode === 'tail'
  const [isLive, setIsLive] = useState(isTailMode)
  const [follow, setFollow] = useState<Follow>({ kind: 'off' })
  const [counts, setCounts] = useState<LevelCounts>(NO_COUNTS)
  const countsRef = useRef<LevelCounts>(NO_COUNTS)
  // Whether the view sticks to the end: true while the user looks at the last lines
  const stickRef = useRef(isTailMode)
  const [newLines, setNewLines] = useState(0)
  const [isTrimmed, setIsTrimmed] = useState(false)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 })
  // The answer last shown: main moves on only when a look names its cursor (a dropped answer comes again)
  const followRef = useRef(file.follow)
  const name = fileNameOf(file.path)
  // Up to 5MB: converted once, the editor reads it only when it is made
  const initialText = useMemo(() => toEditorText(file.content), [file.content])

  // Markers ("기준점"): the status line shows the latest one; trimmed-away ones are reported
  const [markers, setMarkers] = useState<ReturnType<typeof markerSummary>>(null)
  const lostRef = useRef(0)
  const onMarkerState = useCallback((state: EditorState) => {
    setMarkers(markerSummary(state))
    const { lost } = state.field(logMarkerField)
    if (lost > lostRef.current) {
      toast.info('오래된 줄이 정리되면서 기준점이 사라졌습니다', `${lost - lostRef.current}개`)
      lostRef.current = lost
    }
  }, [])

  const extensions = useMemo(() => [
    ...logExtensions((outcome) => reportJump(outcome, '오류·경고')),
    ...logMarkerExtensions({ onChange: onMarkerState, onNotice: reportMarkerNotice })
  ], [onMarkerState])

  // Count what the file showed at first, start at its end when following, and track whether the user left the end
  useEffect(() => {
    const view = editorRef.current?.getView()
    if (!view) return
    countsRef.current = countLevels(view.state.doc)
    setCounts(countsRef.current)
    if (isTailMode) scrollToEnd(view)
    const onScroll = () => {
      stickRef.current = isAtBottom(view)
      if (stickRef.current) setNewLines(0)
    }
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    return () => view.scrollDOM.removeEventListener('scroll', onScroll)
  }, [isTailMode])

  const showAdded = useCallback((result: Extract<RemoteFileTailResult, { text: string }>) => {
    const view = editorRef.current?.getView()
    if (!view) return
    const doc = view.state.doc
    const marker = markerFor(result)
    const startsLine = doc.length === 0 || doc.sliceString(doc.length - 1) === '\n'
    // Line breaks as the editor keeps them (a lone \r would count as a line there but not in planAppend)
    const added = toEditorText(result.text)
    const text = marker ? `${startsLine ? '' : '\n'}${marker}\n${added}` : added
    if (!text) return
    const sticks = stickRef.current
    const plan = appendLog(view, text, countsRef.current, LIMITS)
    countsRef.current = plan.counts
    setCounts(plan.counts)
    if (plan.trimmed) setIsTrimmed(true)
    if (sticks) scrollToEnd(view)
    else setNewLines(count => count + plan.addedLines)
    // A new error while the user looks elsewhere: flash the taskbar button (no notification)
    if (plan.newErrors > 0 && !document.hasFocus()) window.electronAPI.remoteFileAttention?.(docId)
  }, [docId])

  const handle = useCallback((result: RemoteFileTailResult) => {
    // 'busy': a look still runs; 'stale': from before a refresh (this view is about to be replaced)
    if (result.cursor === undefined) return
    const note = result.status === 'missing' ? '파일이 없어 다시 생기기를 기다립니다' : undefined
    setFollow(previous => (previous.kind === 'live' && previous.note === note ? previous : { kind: 'live', note }))
    if ('text' in result) showAdded(result)
    followRef.current = { ...followRef.current, cursor: result.cursor }
  }, [showAdded])
  const handleRef = useRef(handle)
  handleRef.current = handle

  useEffect(() => {
    if (!isLive) {
      setFollow({ kind: 'off' })
      return
    }
    let isCancelled = false
    let timer: number | undefined
    let pace = INITIAL_PACE
    const schedule = (ms: number) => { timer = window.setTimeout(() => void look(), ms) }
    async function look() {
      const tail = window.electronAPI.remoteFileTail
      if (!tail) {
        setFollow({ kind: 'error', message: '앱을 다시 시작한 뒤에 사용할 수 있습니다' })
        return
      }
      const { generation, cursor: taken } = followRef.current
      const result = await tail(docId, generation, taken).catch(() => ({ success: false as const, error: '파일을 읽지 못했습니다.' }))
      // Paused or closed meanwhile: the answer is not shown, so its cursor is not passed on (main sends it again)
      if (isCancelled) return
      if (result.success) {
        handleRef.current(result)
        pace = nextPace(pace, 'text' in result && result.text.length > 0)
        schedule(waitFor(pace, document.hidden))
      } else {
        setFollow({ kind: 'error', message: result.error })
        schedule(RETRY_MS)
      }
    }
    setFollow({ kind: 'live' })
    void look()
    return () => {
      isCancelled = true
      window.clearTimeout(timer)
    }
  }, [isLive, docId])

  const toggleLive = () => {
    const view = editorRef.current?.getView()
    if (!isLive && view) {
      stickRef.current = true
      scrollToEnd(view)
    }
    setIsLive(live => !live)
  }

  const goToEnd = () => {
    const view = editorRef.current?.getView()
    if (!view) return
    stickRef.current = true
    setNewLines(0)
    scrollToEnd(view)
  }

  const markNow = () => {
    const view = editorRef.current?.getView()
    if (!view) return
    addMarkerAtEnd(view, reportMarkerNotice)
    view.focus()
  }

  /** Puts the marker's line at the top; the view stops following the end so it stays there */
  const goToMarker = (marker: LogMarker | null) => {
    const view = editorRef.current?.getView()
    if (!view || !marker) return
    stickRef.current = false
    view.dispatch({ selection: { anchor: marker.pos }, effects: EditorView.scrollIntoView(marker.pos, { y: 'start', yMargin: 32 }) })
    view.focus()
  }

  const stepMarker = (direction: 1 | -1) => {
    const view = editorRef.current?.getView()
    if (view) goToMarker(neighbourMarker(view.state, view.state.selection.main.head, direction))
  }

  /** Arrows and F8 go through errors and warnings; the counts jump within their own level */
  const jump = (direction: 1 | -1, levels: ReadonlySet<JumpLevel> = PROBLEM_LEVELS, name = '오류·경고') => {
    const view = editorRef.current?.getView()
    if (!view) return
    reportJump(jumpToLevel(view, direction, levels), name)
    view.focus()
  }

  const actions = (
    <>
      <button
        type="button"
        className={`title-bar-btn popout-title-action${isLive ? ' is-active' : ''}`}
        onClick={toggleLive}
        title={isLive ? '실시간 보기 멈추기' : '실시간 보기 (새로 쌓이는 줄 계속 보기)'}
        aria-label={isLive ? '실시간 보기 멈추기' : '실시간 보기'}
        aria-pressed={isLive}
      >
        {isLive ? <RiPauseLine size={16} /> : <RiPlayLine size={16} />}
      </button>
      <button type="button" className="title-bar-btn popout-title-action" onClick={markNow} title="기준점 찍기 (Ctrl+M): 지금 로그 끝에 표시하고, 이후 줄은 그 아래로 쌓입니다. 줄 번호를 눌러 그 줄에도 찍을 수 있습니다" aria-label="기준점 찍기">
        <RiFlagLine size={16} />
      </button>
      <button type="button" className="title-bar-btn popout-title-action" onClick={onRefresh} title="처음부터 다시 읽기" aria-label="새로고침">
        <RiRefreshLine size={16} />
      </button>
    </>
  )

  return (
    <div className="remote-file-window">
      <PopoutTitleBar icon={<RiEyeLine size={16} />} title={name} subtitle={`${file.sessionName} · ${file.path}`} actions={actions} />
      {file.truncated && (
        <div className="remote-file-banner">파일이 커서 ({formatBytes(file.size)}) 마지막 1MB 부터 보여 줍니다. 앞부분은 생략했습니다.</div>
      )}
      <div className="remote-file-body remote-log-body">
        <CodeEditor ref={editorRef} initialText={initialText} fileName={name} readOnly onCursor={setCursor} extensions={extensions} />
        {newLines > 0 && (
          <button type="button" className="remote-log-new-lines" onClick={goToEnd}>
            새 줄 {newLines.toLocaleString()}개 <RiArrowDownLine size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="remote-file-status">
        <span className={`remote-log-follow is-${follow.kind}`} role="status">{followLabel(follow, isTailMode)}</span>
        {isTrimmed && <span className="remote-log-note" title="창에는 최근 약 5MB 만 둡니다">오래된 줄 정리됨</span>}
        <span className="remote-file-status-spacer" />
        {markers && (
          <>
            <button type="button" className="remote-log-count remote-log-marker" onClick={() => goToMarker(markers.latest)}
              title={`가장 최근 기준점(${markers.latest.time})으로 이동 · 기준점 ${markers.count}개`}>
              <RiFlagLine size={12} aria-hidden="true" /> 기준점 {markers.latest.id} · 뒤 {markers.linesAfter.toLocaleString()}줄
            </button>
            {markers.count > 1 && (
              <>
                <button type="button" className="remote-file-icon-btn remote-log-jump" onClick={() => stepMarker(-1)} title="이전 기준점" aria-label="이전 기준점">
                  <RiArrowUpSLine size={16} />
                </button>
                <button type="button" className="remote-file-icon-btn remote-log-jump" onClick={() => stepMarker(1)} title="다음 기준점" aria-label="다음 기준점">
                  <RiArrowDownSLine size={16} />
                </button>
              </>
            )}
          </>
        )}
        <button type="button" className={`remote-log-count${counts.error > 0 ? ' is-error' : ''}`} disabled={counts.error === 0}
          onClick={() => jump(1, ERROR_ONLY, '오류')} title="다음 오류 줄로 이동">오류 {counts.error.toLocaleString()}</button>
        <button type="button" className={`remote-log-count${counts.warn > 0 ? ' is-warn' : ''}`} disabled={counts.warn === 0}
          onClick={() => jump(1, WARN_ONLY, '경고')} title="다음 경고 줄로 이동">경고 {counts.warn.toLocaleString()}</button>
        <button type="button" className="remote-file-icon-btn remote-log-jump" onClick={() => jump(-1)} title="이전 오류·경고 (Shift+F8)" aria-label="이전 오류·경고">
          <RiArrowUpSLine size={16} />
        </button>
        <button type="button" className="remote-file-icon-btn remote-log-jump" onClick={() => jump(1)} title="다음 오류·경고 (F8)" aria-label="다음 오류·경고">
          <RiArrowDownSLine size={16} />
        </button>
        <span>줄 {cursor.line}, 열 {cursor.column}</span>
        <span className="remote-file-status-keys">F8 다음 오류·경고 · Ctrl+M 기준점 · Ctrl+F 찾기 · Ctrl+G 줄 이동</span>
      </div>
    </div>
  )
}
