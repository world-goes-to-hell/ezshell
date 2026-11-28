import { useId, useState } from 'react'
import { RiPlayList2Line } from 'react-icons/ri'
import { MAX_RUN_SUMMARY_THRESHOLD, setRunSummaryThreshold, useRunSummary } from '../../stores/runSummaryStore'

export function RunSummarySettings() {
  const threshold = useRunSummary(state => state.threshold)
  const [draft, setDraft] = useState<string | null>(null)
  const inputId = useId()

  return (
    <section className="settings-section">
      <h3 className="settings-section-title"><RiPlayList2Line size={18} aria-hidden="true" /><label htmlFor={inputId}>실행 구성 접기 기준</label></h3>
      <p id={`${inputId}-description`} className="settings-section-desc">이 개수를 넘으면 사이드바에 실행 요약을 표시합니다.</p>
      <div className="form-group settings-run-threshold">
        <input id={inputId} type="number" min={0} max={MAX_RUN_SUMMARY_THRESHOLD} step={1}
          aria-describedby={`${inputId}-description`} value={draft ?? threshold}
          onChange={event => setDraft(event.target.value)}
          onBlur={event => {
            if (event.target.validity.valid) setRunSummaryThreshold(event.target.valueAsNumber)
            setDraft(null)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }} />
        <span aria-hidden="true">개</span>
      </div>
    </section>
  )
}
