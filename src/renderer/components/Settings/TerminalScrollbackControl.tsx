import { useState } from 'react'
import { RiHistoryLine } from 'react-icons/ri'
import { DEFAULT_TERMINAL_SCROLLBACK, readTerminalScrollback, saveTerminalScrollback, TERMINAL_SCROLLBACK_OPTIONS } from '../../lib/terminalScrollback'
import { toast } from '../../stores/toastStore'
import { SelectMenu } from '../ui/SelectMenu'

const options = TERMINAL_SCROLLBACK_OPTIONS.map(rows => ({
  value: String(rows),
  label: `${rows.toLocaleString('ko-KR')}줄${rows === DEFAULT_TERMINAL_SCROLLBACK ? ' (기본)' : ''}`
}))

export function TerminalScrollbackControl() {
  const [rows, setRows] = useState(readTerminalScrollback)

  return (
    <section className="settings-section">
      <h3 className="settings-section-title"><RiHistoryLine size={18} /> 터미널 출력 보관</h3>
      <p className="settings-section-desc">터미널에서 스크롤로 다시 볼 수 있는 이전 출력의 최대 줄 수입니다. 새로 여는 터미널에 적용됩니다.</p>
      <SelectMenu value={String(rows)} options={options} ariaLabel="터미널 출력 보관 줄 수" onChange={value => {
        try { setRows(saveTerminalScrollback(value)) } catch { toast.error('터미널 출력 보관 설정을 저장할 수 없습니다.') }
      }} />
    </section>
  )
}
