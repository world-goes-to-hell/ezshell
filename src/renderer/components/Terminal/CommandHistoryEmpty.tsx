import { getHistoryEmptyMessage } from '../../lib/commandHistoryEmpty'

interface CommandHistoryEmptyProps {
  isAvailable: boolean
  totalCount: number
}

/** Empty state shared by the history popup (Ctrl+Shift+H) and the history panel */
export function CommandHistoryEmpty({ isAvailable, totalCount }: CommandHistoryEmptyProps) {
  const { title, hint } = getHistoryEmptyMessage(isAvailable, totalCount)
  return (
    <div className="history-empty">
      <p className="history-empty-title">{title}</p>
      {hint && <p className="history-empty-hint">{hint}</p>}
    </div>
  )
}
