import { useCallback, useEffect, useState } from 'react'
import { RiRefreshLine } from 'react-icons/ri'
import type { McpAuditEntry } from '../../types'
import { OUTCOME_LABELS, RISK_LABELS, formatAuditTime } from '../../lib/mcpLabels'

const AUDIT_LIMIT = 200

export function McpAuditList() {
  const [entries, setEntries] = useState<McpAuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const read = window.electronAPI?.mcpReadAudit
    if (typeof read !== 'function') return
    try {
      const result = await read(AUDIT_LIMIT)
      setEntries(result.entries)
      setError(result.success ? null : result.error ?? '실행 기록을 읽지 못했습니다')
    } catch {
      setError('실행 기록을 읽지 못했습니다')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <section className="mcp-audit">
      <div className="mcp-audit-header">
        <span className="mcp-field-label">최근 실행 기록 (최대 {AUDIT_LIMIT}건)</span>
        <button type="button" className="mcp-icon-btn" onClick={refresh} title="새로고침" aria-label="실행 기록 새로고침">
          <RiRefreshLine size={16} />
        </button>
      </div>
      {error && <p className="mcp-error" role="alert">{error}</p>}
      {entries.length === 0 ? (
        <p className="form-hint">아직 기록이 없습니다.</p>
      ) : (
        <div className="mcp-audit-scroll">
          <table className="mcp-audit-table">
            <thead>
              <tr><th>시각</th><th>세션</th><th>명령</th><th>위험도</th><th>결과</th></tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={`${entry.requestId}-${entry.time}`}>
                  <td>{formatAuditTime(entry.time)}</td>
                  <td>{entry.sessionName}</td>
                  <td><code title={entry.command}>{entry.command}</code></td>
                  <td><span className={`mcp-risk mcp-risk-${entry.level}`}>{RISK_LABELS[entry.level]}</span></td>
                  <td title={entry.error || (entry.reasons ?? []).join(', ')}>
                    {OUTCOME_LABELS[entry.outcome]}
                    {entry.exitCode != null && ` (${entry.exitCode})`}
                    {entry.timedOut && ' · 시간 초과'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
