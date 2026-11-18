import { useState, type CSSProperties } from 'react'
import { RiArrowUpLine, RiArrowDownLine, RiCheckLine } from 'react-icons/ri'
import type { TransferMark } from '../../lib/transferMarks'

const VERB = { upload: '업로드', download: '다운로드' } as const

const RING_SIZE = 14
const RING_STROKE = 2.5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const COMPLETION_MS = 1100

export function transferMarkTitle(mark: TransferMark): string {
  const verb = VERB[mark.direction]
  const percent = `${Math.round(mark.progress ?? 0)}%`
  switch (mark.state) {
    case 'queued': return `${verb} 대기 중`
    case 'transferring': return `${verb} 중 ${percent}`
    case 'paused': return `${verb} 일시정지 (${percent})`
    case 'error': return mark.error ? `${verb} 실패: ${mark.error}` : `${verb} 실패`
    default: return `${verb}됨 (이 세션)`
  }
}

/** Row classes for a file this session sent into the folder */
export function transferMarkClass(mark: TransferMark | undefined): string {
  return mark ? `transfer-mark transfer-mark--${mark.direction} transfer-mark--${mark.state}` : ''
}

/** Donut filled by the transfer's progress (track = the rest; nothing filled while queued) */
function ProgressRing({ progress }: { progress: number }) {
  const center = RING_SIZE / 2
  return (
    <svg className="transfer-ring" width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
      <circle className="transfer-ring-track" cx={center} cy={center} r={RING_RADIUS} strokeWidth={RING_STROKE} />
      {progress > 0 && (
        <circle
          className="transfer-ring-value"
          cx={center}
          cy={center}
          r={RING_RADIUS}
          strokeWidth={RING_STROKE}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress / 100)}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
    </svg>
  )
}

/**
 * Next to the file name: a progress donut while the transfer is queued / running / paused,
 * followed by a completion check and the usual direction arrow.
 */
export function TransferMarkBadge({ mark }: { mark: TransferMark }) {
  const title = transferMarkTitle(mark)
  if (mark.progress !== undefined) {
    const value = Math.round(mark.progress)
    return (
      <span
        className="transfer-mark-badge"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-label={title}
        title={title}
      >
        <ProgressRing progress={mark.progress} />
      </span>
    )
  }
  const Icon = mark.direction === 'upload' ? RiArrowUpLine : RiArrowDownLine
  return (
    <span className="transfer-mark-badge" title={title} aria-label={title}>
      {mark.state === 'done' && mark.completedAt !== undefined ? (
        <TransferCompletion key={mark.completedAt} completedAt={mark.completedAt} Icon={Icon} />
      ) : <Icon size={13} />}
    </span>
  )
}

function TransferCompletion({ completedAt, Icon }: { completedAt: number; Icon: typeof RiArrowUpLine }) {
  // Resume at the transfer's current age if a newly listed or virtualized row mounts late.
  const [elapsed] = useState(() => Math.max(0, Date.now() - completedAt))
  const [finished, setFinished] = useState(false)
  if (finished || elapsed >= COMPLETION_MS) return <Icon size={13} />

  const timing = {
    '--transfer-completion-duration': `${COMPLETION_MS}ms`,
    '--transfer-completion-delay': `${-elapsed}ms`
  } as CSSProperties

  return (
    <span className="transfer-completion" style={timing} aria-hidden="true">
      <span className="transfer-completion-ring"><ProgressRing progress={100} /></span>
      <RiCheckLine className="transfer-completion-check" size={14} />
      <Icon className="transfer-completion-direction" size={13} />
      <span className="transfer-completion-row" onAnimationEnd={() => setFinished(true)} />
    </span>
  )
}
