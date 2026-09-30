import { useState } from 'react'
import { motion } from 'framer-motion'
import { RiCloseFill, RiDeleteBinLine, RiFileCopyLine, RiSearchLine, RiDeleteBin2Line } from 'react-icons/ri'
import { useCommandHistory, useFilteredHistory, formatHistoryTime } from '../../hooks/useCommandHistory'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { toast } from '../../stores/toastStore'
import { CommandHistoryEmpty } from './CommandHistoryEmpty'

interface CommandHistoryPanelProps {
  sessionId: string
  /** Types the command into the pane that had focus last; running it is left to the user */
  onInsert: (command: string) => void
  onClose: () => void
}

export function CommandHistoryPanel({ sessionId, onInsert, onClose }: CommandHistoryPanelProps) {
  const { isAvailable, entries, remove, clear } = useCommandHistory(sessionId)
  const [query, setQuery] = useState('')
  const results = useFilteredHistory(entries, query)
  const reducedMotion = useReducedMotion()

  const handleCopy = async (command: string) => {
    if (await copyToClipboard(command)) {
      toast.success('명령어 복사됨', command)
    } else {
      toast.error('복사 실패', '클립보드에 접근할 수 없습니다')
    }
  }

  const handleClear = () => {
    if (confirm(`이 연결의 명령어 기록 ${entries.length}개를 모두 삭제할까요?\n삭제한 기록은 되돌릴 수 없습니다.`)) clear()
  }

  return (
    <motion.aside
      className="command-history-panel"
      aria-label="명령어 기록"
      onClick={(e) => e.stopPropagation()}
      initial={reducedMotion ? false : { opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reducedMotion ? undefined : { opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
    >
      <div className="monitor-header">
        <span className="monitor-title">
          명령어 기록 <span className="history-count">{entries.length}</span>
        </span>
        <div className="monitor-actions">
          <button
            className="monitor-action-btn"
            onClick={handleClear}
            disabled={entries.length === 0}
            title="이 연결의 기록 모두 삭제"
            aria-label="이 연결의 기록 모두 삭제"
          >
            <RiDeleteBin2Line size={14} />
          </button>
          <button className="monitor-action-btn" onClick={onClose} title="닫기" aria-label="명령어 기록 닫기">
            <RiCloseFill size={14} />
          </button>
        </div>
      </div>

      <label className="history-panel-search">
        <RiSearchLine size={14} aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="검색" aria-label="명령어 기록 검색" />
      </label>

      {results.length > 0 ? (
        <ul className="history-panel-list">
          {results.map((entry) => (
            <li key={entry.command} className="history-panel-item">
              <button
                className="history-panel-insert"
                onClick={() => onInsert(entry.command)}
                title={`터미널에 입력: ${entry.command}`}
              >
                <span className="history-command">{entry.command}</span>
                <span className="history-time">{formatHistoryTime(entry.lastUsedAt)}</span>
              </button>
              <div className="history-panel-item-actions">
                <button className="monitor-action-btn" onClick={() => handleCopy(entry.command)} title="복사" aria-label={`복사: ${entry.command}`}>
                  <RiFileCopyLine size={14} />
                </button>
                <button className="monitor-action-btn" onClick={() => remove(entry.command)} title="기록에서 삭제" aria-label={`삭제: ${entry.command}`}>
                  <RiDeleteBinLine size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <CommandHistoryEmpty isAvailable={isAvailable} totalCount={entries.length} />
      )}

      <p className="history-panel-footer">클릭하면 입력만 됩니다 · 터미널에서 Ctrl+Shift+H 로 빠르게 검색</p>
    </motion.aside>
  )
}
