import { initialPace, retryWait, nextPace, waitFor, type PaceKind } from '../../lib/logPollPace'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RiArrowDownLine, RiEyeLine, RiFlagLine, RiListCheck2, RiPauseLine, RiPlayLine, RiRefreshLine, RiTextWrap } from 'react-icons/ri'
import type { EditorState } from '@codemirror/state'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { CodeEditor, type CodeEditorHandle, type CursorInfo } from './CodeEditor'
import {
  appendLog, goToMarker, goToProblem, isAtBottom, logExtensions, revealLine, scrollToEnd, setWrapped, PROBLEM_LEVELS,
  type JumpOutcome, type NavKind, type NavTarget
} from './logView'
import { markerLine, type JumpLevel } from '../../lib/logLevels'
import type { RemoteFileLoaded, RemoteFileTailResult } from '../../types'
import { formatBytes } from '../../lib/mcpLabels'
import { fileNameOf, toEditorText } from '../../lib/remoteFileText'
import { toast } from '../../stores/toastStore'
import { addMarkerAtEnd, logMarkerExtensions, type MarkerNotice } from './logMarkerView'
import { logMarkerField, removeMarker, renameMarker, MAX_MARKERS } from '../../lib/logMarkers'
import { buildOutline, sameOutline, type LogOutline } from '../../lib/logOutline'
import { readLogViewPrefs, saveLogViewPrefs } from '../../lib/logViewPrefs'
import { LogOutlinePanel, StepButtons, type ProblemFilter } from './LogOutlinePanel'
import './RemoteLog.css'

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

const LEVELS_OF: Record<ProblemFilter, ReadonlySet<JumpLevel>> = {
  all: PROBLEM_LEVELS,
  error: new Set<JumpLevel>(['error']),
  warn: new Set<JumpLevel>(['warn'])
}
const FILTER_NAME: Record<ProblemFilter, string> = { all: '오류·경고', error: '오류', warn: '경고' }

/** The wheel can reach an end many times in a row: say so once in a while */
const END_NOTICE_GAP_MS = 1500

function reportMarkerNotice(notice: MarkerNotice): void {
  if (notice === 'limit') toast.info(`기준점은 ${MAX_MARKERS}개까지 둘 수 있습니다`, '띠의 ✕ 로 지운 뒤 다시 찍어 주세요')
  else toast.info('로그 끝에 이미 기준점이 있습니다', '새 줄이 쌓인 뒤에 다시 찍을 수 있습니다')
}

const EMPTY_OUTLINE: LogOutline = {
  counts: { error: 0, warn: 0 }, ordinal: 0, total: 0, markers: [], latestMarker: null,
  currentMarkerId: null, currentProblemPos: null, rows: [], matching: 0
}

/**
 * A text file to look at, and a log to follow ("실시간 보기"): errors red, warnings yellow, a list of
 * markers and problems beside it, F8 / F9 and Ctrl + wheel between them. Nothing here writes to the server.
 */
export function RemoteLogView({ docId, file, onRefresh }: RemoteLogViewProps) {
  const editorRef = useRef<CodeEditorHandle>(null)
  const isTailMode = file.mode === 'tail'
  const [isLive, setIsLive] = useState(isTailMode)
  const [follow, setFollow] = useState<Follow>({ kind: 'off' })
  // Whether the view sticks to the end: true while the user looks at the last lines
  const stickRef = useRef(isTailMode)
  const [unseen, setUnseen] = useState({ lines: 0, errors: 0 })
  const [isTrimmed, setIsTrimmed] = useState(false)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 })
  // The answer last shown: main moves on only when a look names its cursor (a dropped answer comes again)
  const followRef = useRef(file.follow)
  const name = fileNameOf(file.path)
  // Up to 5MB: converted once, the editor reads it only when it is made
  const initialText = useMemo(() => toEditorText(file.content), [file.content])

  const [prefs, setPrefs] = useState(readLogViewPrefs)
  const [filter, setFilter] = useState<ProblemFilter>('all')
  const [outline, setOutline] = useState<LogOutline>(EMPTY_OUTLINE)
  // What the outline is built for; the editor's listener reads it through a ref (made once)
  const outlineOptions = useRef({ levels: LEVELS_OF[filter], withRows: prefs.isOutlineOpen })
  outlineOptions.current = { levels: LEVELS_OF[filter], withRows: prefs.isOutlineOpen }
  const lostRef = useRef(0)

  const onState = useCallback((state: EditorState) => {
    const next = buildOutline(state, outlineOptions.current)
    setOutline(previous => (sameOutline(previous, next) ? previous : next))
    const { lost } = state.field(logMarkerField)
    if (lost > lostRef.current) {
      toast.info('오래된 줄이 정리되면서 기준점이 사라졌습니다', `${lost - lostRef.current}개`)
      lostRef.current = lost
    }
  }, [])

  // The list's choice (전체 / 오류 / 경고) is also what F8, the wheel and the arrows move between
  const filterRef = useRef(filter)
  filterRef.current = filter
  const endNoticeAt = useRef(0)
  /** What a move did: the view stops following the end, and the user hears why nothing moved */
  const onNavigate = useCallback((kind: NavKind, outcome: JumpOutcome, target: NavTarget, levelName = FILTER_NAME[filterRef.current]) => {
    const what = kind === 'marker' ? '기준점' : `${levelName} 줄`
    if (outcome === 'found' || outcome === 'wrapped') stickRef.current = false
    if (outcome === 'wrapped') toast.info(target === 1 ? '끝을 지나 처음부터 다시 찾았습니다' : '처음을 지나 끝에서부터 다시 찾았습니다')
    else if (outcome === 'none' && kind === 'marker') toast.info('기준점이 없습니다', 'Ctrl+M 으로 지금 로그 끝에 찍을 수 있습니다')
    else if (outcome === 'none') toast.info(`다른 ${what}이 없습니다`)
    else if (outcome === 'end' && Date.now() - endNoticeAt.current > END_NOTICE_GAP_MS) {
      endNoticeAt.current = Date.now()
      toast.info(target === 1 ? `마지막 ${what}입니다` : `첫 ${what}입니다`)
    }
  }, [])

  const extensions = useMemo(() => [
    // Read once: the editor is made once, later changes go through setWrapped
    ...logExtensions({ isWrapped: readLogViewPrefs().isWrapped, levels: () => LEVELS_OF[filterRef.current], onNavigate, onState }),
    ...logMarkerExtensions({ onNotice: reportMarkerNotice })
  ], [onNavigate, onState])

  // Start at the end when following, and track whether the user left the end
  useEffect(() => {
    const view = editorRef.current?.getView()
    if (!view) return
    onState(view.state)
    if (isTailMode) scrollToEnd(view)
    const onScroll = () => {
      stickRef.current = isAtBottom(view)
      if (stickRef.current) setUnseen({ lines: 0, errors: 0 })
    }
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    return () => view.scrollDOM.removeEventListener('scroll', onScroll)
  }, [isTailMode, onState])

  // The list's level and the panel being open change what the outline holds
  useEffect(() => {
    const view = editorRef.current?.getView()
    if (view) onState(view.state)
  }, [filter, prefs.isOutlineOpen, onState])

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
    const plan = appendLog(view, text, LIMITS)
    if (plan.trimmed) setIsTrimmed(true)
    if (sticks) scrollToEnd(view)
    else setUnseen(previous => ({ lines: previous.lines + plan.addedLines, errors: previous.errors + plan.newErrors }))
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
    // A container's log is read by running a command each time: those looks are further apart
    const kind: PaceKind = file.pace === 'command' ? 'command' : 'file'
    let pace = initialPace(kind)
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
        pace = nextPace(pace, 'text' in result && result.text.length > 0, kind)
        schedule(waitFor(pace, document.hidden, kind))
      } else {
        setFollow({ kind: 'error', message: result.error })
        schedule(retryWait(kind))
      }
    }
    setFollow({ kind: 'live' })
    void look()
    return () => {
      isCancelled = true
      window.clearTimeout(timer)
    }
  }, [isLive, docId, file.pace])

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
    setUnseen({ lines: 0, errors: 0 })
    scrollToEnd(view)
  }

  const markNow = () => {
    const view = editorRef.current?.getView()
    if (!view) return
    addMarkerAtEnd(view, reportMarkerNotice)
    view.focus()
  }

  const updatePrefs = (change: Partial<typeof prefs>) => {
    const next = { ...prefs, ...change }
    setPrefs(next)
    saveLogViewPrefs(next)
    const view = editorRef.current?.getView()
    if (view && change.isWrapped !== undefined) setWrapped(view, change.isWrapped)
  }

  /** A row of the list: the line comes into view and the view stops following the end */
  const goTo = (pos: number, kind: NavKind) => {
    const view = editorRef.current?.getView()
    if (!view) return
    stickRef.current = false
    revealLine(view, pos, kind === 'marker' ? 'start' : 'center')
    view.focus()
  }

  const stepProblem = (target: NavTarget, levels: ProblemFilter = filter) => {
    const view = editorRef.current?.getView()
    if (!view) return
    onNavigate('problem', goToProblem(view, target, LEVELS_OF[levels]), target, FILTER_NAME[levels])
    view.focus()
  }

  const stepMarker = (target: NavTarget) => {
    const view = editorRef.current?.getView()
    if (!view) return
    onNavigate('marker', goToMarker(view, target), target)
    view.focus()
  }

  const dispatchMarker = (effect: ReturnType<typeof removeMarker.of> | ReturnType<typeof renameMarker.of>) => {
    editorRef.current?.getView()?.dispatch({ effects: effect })
  }

  const { counts, latestMarker } = outline
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
      <button
        type="button"
        className={`title-bar-btn popout-title-action${prefs.isWrapped ? ' is-active' : ''}`}
        onClick={() => updatePrefs({ isWrapped: !prefs.isWrapped })}
        title={prefs.isWrapped ? '줄바꿈 끄기 (긴 줄을 한 줄로)' : '줄바꿈 (긴 줄을 창 너비에서 접기)'}
        aria-label="줄바꿈"
        aria-pressed={prefs.isWrapped}
      >
        <RiTextWrap size={16} />
      </button>
      <button
        type="button"
        className={`title-bar-btn popout-title-action${prefs.isOutlineOpen ? ' is-active' : ''}`}
        onClick={() => updatePrefs({ isOutlineOpen: !prefs.isOutlineOpen })}
        title={prefs.isOutlineOpen ? '기준점·오류 목록 닫기' : '기준점·오류 목록 열기'}
        aria-label="기준점·오류 목록"
        aria-pressed={prefs.isOutlineOpen}
      >
        <RiListCheck2 size={16} />
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
      <div className="remote-file-body">
        <div className="remote-log-body">
          <CodeEditor ref={editorRef} initialText={initialText} fileName={name} readOnly onCursor={setCursor} extensions={extensions} />
          {unseen.lines > 0 && (
            <button type="button" className={`remote-log-new-lines${unseen.errors > 0 ? ' has-error' : ''}`} onClick={goToEnd}>
              새 줄 {unseen.lines.toLocaleString()}개
              {unseen.errors > 0 && <strong> · 오류 {unseen.errors.toLocaleString()}</strong>}
              <RiArrowDownLine size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {prefs.isOutlineOpen && (
          <LogOutlinePanel
            outline={outline}
            filter={filter}
            onFilter={setFilter}
            onGoTo={goTo}
            onStepProblem={target => stepProblem(target)}
            onStepMarker={stepMarker}
            onMark={markNow}
            onRename={(id, label) => dispatchMarker(renameMarker.of({ id, label }))}
            onRemove={id => dispatchMarker(removeMarker.of(id))}
          />
        )}
      </div>
      <div className="remote-file-status">
        <span className={`remote-log-follow is-${follow.kind}`} role="status">{followLabel(follow, isTailMode)}</span>
        {isTrimmed && <span className="remote-log-note" title="창에는 최근 약 5MB 만 둡니다">오래된 줄 정리됨</span>}
        <span className="remote-file-status-spacer" />
        {latestMarker && (
          <button type="button" className="remote-log-count remote-log-marker" onClick={() => goTo(latestMarker.pos, 'marker')}
            title={`가장 최근 기준점(${latestMarker.time})으로 이동 · 기준점 ${outline.markers.length}개 · F9 로 기준점 사이를 이동합니다`}>
            <RiFlagLine size={12} aria-hidden="true" /> {latestMarker.label ?? `기준점 ${latestMarker.id}`} · 뒤 {latestMarker.linesAfter.toLocaleString()}줄
            {latestMarker.after.error > 0 && <span className="remote-log-marker-errors"> · 오류 {latestMarker.after.error.toLocaleString()}</span>}
          </button>
        )}
        <button type="button" className={`remote-log-count${counts.error > 0 ? ' is-error' : ''}`} disabled={counts.error === 0}
          onClick={() => stepProblem(1, 'error')} title="다음 오류로 이동 (스택 트레이스는 한 건으로 셉니다)">오류 {counts.error.toLocaleString()}</button>
        <button type="button" className={`remote-log-count${counts.warn > 0 ? ' is-warn' : ''}`} disabled={counts.warn === 0}
          onClick={() => stepProblem(1, 'warn')} title="다음 경고로 이동">경고 {counts.warn.toLocaleString()}</button>
        <StepButtons name={FILTER_NAME[filter]} keyName="F8" disabled={outline.total === 0} onStep={target => stepProblem(target)}
          position={outline.total > 0 ? `${filter === 'all' ? '' : `${FILTER_NAME[filter]} `}${outline.ordinal.toLocaleString()}/${outline.total.toLocaleString()}` : undefined} />
        <span>줄 {cursor.line}, 열 {cursor.column}</span>
        <span className="remote-file-status-keys">F8 오류·경고 · F9 기준점 · Ctrl+휠 이동 · Ctrl+M 기준점 찍기</span>
      </div>
    </div>
  )
}
