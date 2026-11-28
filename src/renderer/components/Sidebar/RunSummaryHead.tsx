import { RiArrowRightSLine, RiCircleFill, RiContrast2Line, RiErrorWarningFill } from 'react-icons/ri'
import type { RunPanelStatus } from '../../stores/workspacePanelStore'

const statuses = [
  { filter: 'running', label: '실행 중', Icon: RiCircleFill },
  { filter: 'crashed', label: '비정상 종료', Icon: RiErrorWarningFill },
  { filter: 'unresponsive', label: '응답 없음', Icon: RiContrast2Line },
] as const

export function RunSummaryHead({ count, counts, onOpen }: {
  count: number
  counts: Record<RunPanelStatus, number>
  onOpen: (filter?: RunPanelStatus) => void
}) {
  return (
    <div className="run-presets-head run-presets-summary">
      <span>실행 {count}</span>
      {statuses.map(({ filter, label, Icon }) => (
        <button key={filter} type="button" className={`run-summary-${filter}`} data-run-filter={filter}
          onClick={() => onOpen(filter)} title={`${label} · 실행 패널에서 보기`}
          aria-label={`${label} ${counts[filter]}개`}>
          <Icon size={11} aria-hidden="true" />{counts[filter]}
        </button>
      ))}
      <button type="button" className="run-summary-panel" onClick={() => onOpen()} aria-label="실행 패널 열기">
        패널 <RiArrowRightSLine size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
