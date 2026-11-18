import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { RiAddLine, RiArrowDownSLine, RiArrowUpSLine, RiCloseLine, RiFlagLine, RiPencilLine, RiSkipDownLine, RiSkipUpLine } from 'react-icons/ri'
import type { LogOutline, MarkerRow } from '../../lib/logOutline'
import { MAX_LABEL_LENGTH } from '../../lib/logMarkers'
import type { NavTarget } from './logView'

export type ProblemFilter = 'all' | 'error' | 'warn'

const FILTERS: Array<{ id: ProblemFilter; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'error', label: '오류' },
  { id: 'warn', label: '경고' }
]

interface StepButtonsProps {
  /** "오류·경고", "기준점" */
  name: string
  /** "F8", "F9" */
  keyName: string
  disabled?: boolean
  onStep: (target: NavTarget) => void
  /** Shown between the arrows: "3/15" */
  position?: string
}

/** First, previous, next, last: the same four buttons for problems and for markers */
export function StepButtons({ name, keyName, disabled, onStep, position }: StepButtonsProps) {
  const button = (target: NavTarget, title: string, icon: ReactNode) => (
    <button type="button" className="remote-file-icon-btn remote-log-step" disabled={disabled} onClick={() => onStep(target)} title={title} aria-label={title}>
      {icon}
    </button>
  )
  return (
    <span className="remote-log-steps">
      {button('first', `맨 위 ${name} (Ctrl+Shift+${keyName})`, <RiSkipUpLine size={14} />)}
      {button(-1, `이전 ${name} (Shift+${keyName})`, <RiArrowUpSLine size={16} />)}
      {position !== undefined && <span className="remote-log-position">{position}</span>}
      {button(1, `다음 ${name} (${keyName})`, <RiArrowDownSLine size={16} />)}
      {button('last', `맨 아래 ${name} (Ctrl+${keyName})`, <RiSkipDownLine size={14} />)}
    </span>
  )
}

const afterText = (marker: MarkerRow): string => [
  `뒤 ${marker.linesAfter.toLocaleString()}줄`,
  marker.after.error > 0 ? `오류 ${marker.after.error.toLocaleString()}` : '',
  marker.after.warn > 0 ? `경고 ${marker.after.warn.toLocaleString()}` : ''
].filter(Boolean).join(' · ')

interface LogOutlinePanelProps {
  outline: LogOutline
  filter: ProblemFilter
  onFilter: (filter: ProblemFilter) => void
  onGoTo: (pos: number, kind: 'problem' | 'marker') => void
  onStepProblem: (target: NavTarget) => void
  onStepMarker: (target: NavTarget) => void
  onMark: () => void
  onRename: (id: number, label: string) => void
  onRemove: (id: number) => void
}

/** Beside the log: the markers (what came after each) and the latest errors and warnings. A click goes there. */
export function LogOutlinePanel({ outline, filter, onFilter, onGoTo, onStepProblem, onStepMarker, onMark, onRename, onRemove }: LogOutlinePanelProps) {
  const [editing, setEditing] = useState<{ id: number; label: string } | null>(null)

  const finishEdit = (isSaved: boolean) => {
    if (editing && isSaved) onRename(editing.id, editing.label)
    setEditing(null)
  }
  const onEditKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') finishEdit(true)
    else if (event.key === 'Escape') finishEdit(false)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <aside className="remote-log-outline" aria-label="기준점과 오류·경고 목록">
      <section className="remote-log-outline-section is-markers">
        <header className="remote-log-outline-head">
          <span className="remote-log-outline-title">기준점 {outline.markers.length > 0 && <em>{outline.markers.length}</em>}</span>
          <StepButtons name="기준점" keyName="F9" disabled={outline.markers.length === 0} onStep={onStepMarker} />
          <button type="button" className="remote-file-icon-btn remote-log-step" onClick={onMark} title="지금 로그 끝에 기준점 찍기 (Ctrl+M)" aria-label="기준점 찍기">
            <RiAddLine size={15} />
          </button>
        </header>
        {outline.markers.length === 0 ? (
          <p className="remote-log-outline-empty">기준점이 없습니다. <kbd>Ctrl+M</kbd> 을 누르거나 줄 번호를 누르면 그 자리에 찍고, 그 뒤에 쌓인 줄과 오류 수를 여기서 봅니다.</p>
        ) : (
          <ul className="remote-log-outline-list">
            {outline.markers.map(marker => (
              <li key={marker.id} className={`remote-log-marker-row${marker.id === outline.currentMarkerId ? ' is-current' : ''}`}>
                {editing?.id === marker.id ? (
                  <input
                    className="remote-log-marker-input"
                    autoFocus
                    value={editing.label}
                    maxLength={MAX_LABEL_LENGTH}
                    placeholder={`기준점 ${marker.id} 의 이름`}
                    aria-label={`기준점 ${marker.id} 의 이름`}
                    onChange={event => setEditing({ id: marker.id, label: event.target.value })}
                    onKeyDown={onEditKey}
                    onBlur={() => finishEdit(true)}
                  />
                ) : (
                  <button type="button" className="remote-log-row-main" onClick={() => onGoTo(marker.pos, 'marker')} title={`기준점 ${marker.id} 로 이동 (${marker.line.toLocaleString()}번 줄)`}>
                    <span className="remote-log-row-top">
                      <RiFlagLine size={12} aria-hidden="true" />
                      <span className="remote-log-marker-name">{marker.label ?? `기준점 ${marker.id}`}</span>
                      <span className="remote-log-row-time">{marker.time}</span>
                    </span>
                    <span className={`remote-log-row-sub${marker.after.error > 0 ? ' has-error' : ''}`}>{afterText(marker)}</span>
                  </button>
                )}
                <button type="button" className="remote-file-icon-btn remote-log-step" onClick={() => setEditing({ id: marker.id, label: marker.label ?? '' })} title="이름 붙이기" aria-label={`기준점 ${marker.id} 이름 붙이기`}>
                  <RiPencilLine size={13} />
                </button>
                <button type="button" className="remote-file-icon-btn remote-log-step" onClick={() => onRemove(marker.id)} title="기준점 지우기" aria-label={`기준점 ${marker.id} 지우기`}>
                  <RiCloseLine size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="remote-log-outline-section is-problems">
        <header className="remote-log-outline-head">
          <span className="remote-log-outline-title">오류·경고 {outline.matching > 0 && <em>{outline.matching.toLocaleString()}</em>}</span>
          <StepButtons name="오류·경고" keyName="F8" disabled={outline.matching === 0} onStep={onStepProblem} />
        </header>
        <div className="remote-log-filter" role="group" aria-label="목록에 보일 수준">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className={filter === id ? 'is-active' : ''} aria-pressed={filter === id} onClick={() => onFilter(id)}>{label}</button>
          ))}
        </div>
        {outline.rows.length === 0 ? (
          <p className="remote-log-outline-empty">{filter === 'all' ? '오류·경고 줄이 없습니다.' : `${filter === 'error' ? '오류' : '경고'} 줄이 없습니다.`}</p>
        ) : (
          <ul className="remote-log-outline-list is-scroll">
            {outline.rows.map(row => (
              <li key={row.pos}>
                <button
                  type="button"
                  className={`remote-log-problem-row is-${row.level}${row.pos === outline.currentProblemPos ? ' is-current' : ''}`}
                  onClick={() => onGoTo(row.pos, 'problem')}
                  title={`${row.line.toLocaleString()}번 줄로 이동`}
                >
                  <span className="remote-log-row-time">{row.time ?? `줄 ${row.line.toLocaleString()}`}</span>
                  <span className="remote-log-problem-text">{row.text}</span>
                </button>
              </li>
            ))}
            {outline.matching > outline.rows.length && (
              <li className="remote-log-outline-more">최근 {outline.rows.length}건만 보입니다. 그 앞의 {(outline.matching - outline.rows.length).toLocaleString()}건은 화살표나 F8 로 이동합니다.</li>
            )}
          </ul>
        )}
      </section>
    </aside>
  )
}
