import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { RiTerminalBoxFill, RiCloseFill, RiPlayFill, RiCheckboxCircleFill, RiCloseCircleFill, RiLoader4Fill, RiTimeLine, RiDeleteBinLine } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { useBatchStore, BatchResult } from '../../stores/batchStore'

interface BatchCommandModalProps {
  open: boolean
  onClose: () => void
}

export function BatchCommandModal({ open, onClose }: BatchCommandModalProps) {
  const { terminals } = useTerminalStore()
  const { jobs, isRunning, addJob, updateResult, setRunning, clearJobs, removeJob } = useBatchStore()
  const [command, setCommand] = useState('')
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [selectAll, setSelectAll] = useState(false)

  // Get list of connected terminals
  const connectedTerminals = Array.from(terminals.entries())
    .filter(([_, info]) => info.connected)
    .map(([id, info]) => ({ id, name: info.title || `${info.username}@${info.host}`, host: info.host, username: info.username }))

  useEffect(() => {
    if (open) {
      // Pre-select all connected
      setSelectedSessions(new Set(connectedTerminals.map(t => t.id)))
      setSelectAll(true)
    }
  }, [open])

  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedSessions(new Set())
    } else {
      setSelectedSessions(new Set(connectedTerminals.map(t => t.id)))
    }
    setSelectAll(!selectAll)
  }

  const toggleSession = (sessionId: string) => {
    const newSet = new Set(selectedSessions)
    if (newSet.has(sessionId)) {
      newSet.delete(sessionId)
    } else {
      newSet.add(sessionId)
    }
    setSelectedSessions(newSet)
    setSelectAll(newSet.size === connectedTerminals.length)
  }

  const handleExecute = async () => {
    if (!command.trim() || selectedSessions.size === 0 || isRunning) return

    const jobId = Date.now().toString()
    const results: BatchResult[] = Array.from(selectedSessions).map(sessionId => {
      const term = connectedTerminals.find(t => t.id === sessionId)
      return {
        sessionId,
        sessionName: term?.name || sessionId,
        host: term?.host || '',
        status: 'pending' as const,
        stdout: '',
        stderr: ''
      }
    })

    addJob({ id: jobId, command: command.trim(), createdAt: Date.now(), results })
    setRunning(true)

    // Execute on all selected sessions in parallel
    const promises = results.map(async (result) => {
      updateResult(jobId, result.sessionId, { status: 'running' })
      const startTime = Date.now()

      try {
        const res = await window.electronAPI.sshExecCommand(result.sessionId, command.trim())
        const duration = Date.now() - startTime

        if (res.success) {
          updateResult(jobId, result.sessionId, {
            status: 'success',
            stdout: res.stdout || '',
            stderr: res.stderr || '',
            exitCode: res.exitCode,
            duration
          })
        } else {
          updateResult(jobId, result.sessionId, {
            status: 'error',
            stderr: res.error || 'Unknown error',
            duration
          })
        }
      } catch (err: any) {
        updateResult(jobId, result.sessionId, {
          status: 'error',
          stderr: err.message || 'Execution failed',
          duration: Date.now() - startTime
        })
      }
    })

    await Promise.all(promises)
    setRunning(false)
    setCommand('')
  }

  if (!open) return null

  return (
    <div className="batch-overlay" onClick={onClose}>
      <motion.div
        className="batch-modal"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.97 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="batch-header">
          <div className="batch-title">
            <RiTerminalBoxFill size={20} />
            <span>배치 명령 실행</span>
          </div>
          <button className="batch-close-btn" onClick={onClose}>
            <RiCloseFill size={20} />
          </button>
        </div>

        <div className="batch-body">
          {/* Server selection */}
          <div className="batch-section">
            <div className="batch-section-header">
              <span>대상 서버 ({selectedSessions.size}/{connectedTerminals.length})</span>
              <label className="batch-select-all">
                <input
                  type="checkbox"
                  checked={selectAll}
                  onChange={handleSelectAll}
                />
                <span>전체 선택</span>
              </label>
            </div>
            <div className="batch-server-list">
              {connectedTerminals.length === 0 ? (
                <div className="batch-empty">연결된 서버가 없습니다</div>
              ) : (
                connectedTerminals.map(term => (
                  <label key={term.id} className="batch-server-item">
                    <input
                      type="checkbox"
                      checked={selectedSessions.has(term.id)}
                      onChange={() => toggleSession(term.id)}
                    />
                    <span className="batch-server-name">{term.name}</span>
                    <span className="batch-server-host">{term.host}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          {/* Command input */}
          <div className="batch-section">
            <div className="batch-command-input">
              <span className="batch-prompt">$</span>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleExecute() }}
                placeholder="실행할 명령어 입력..."
                className="batch-input"
                disabled={isRunning}
                autoFocus
              />
              <button
                className="batch-run-btn"
                onClick={handleExecute}
                disabled={isRunning || !command.trim() || selectedSessions.size === 0}
              >
                {isRunning ? <RiLoader4Fill size={18} className="spinning" /> : <RiPlayFill size={18} />}
                실행
              </button>
            </div>
          </div>

          {/* Results */}
          <div className="batch-section batch-results">
            <div className="batch-section-header">
              <span>실행 결과</span>
              {jobs.length > 0 && (
                <button className="batch-clear-btn" onClick={clearJobs}>기록 삭제</button>
              )}
            </div>
            <div className="batch-jobs-list">
              {jobs.length === 0 ? (
                <div className="batch-empty">실행 기록이 없습니다</div>
              ) : (
                jobs.map(job => (
                  <div key={job.id} className="batch-job">
                    <div className="batch-job-header">
                      <code className="batch-job-command">$ {job.command}</code>
                      <div className="batch-job-meta">
                        <span className="batch-job-time">
                          {new Date(job.createdAt).toLocaleTimeString('ko-KR')}
                        </span>
                        <button
                          className="batch-job-delete"
                          onClick={() => removeJob(job.id)}
                          title="삭제"
                        >
                          <RiDeleteBinLine size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="batch-job-results">
                      {job.results.map(result => (
                        <div key={result.sessionId} className={`batch-result batch-result-${result.status}`}>
                          <div className="batch-result-header">
                            <span className="batch-result-status">
                              {result.status === 'success' && <RiCheckboxCircleFill size={16} />}
                              {result.status === 'error' && <RiCloseCircleFill size={16} />}
                              {result.status === 'running' && <RiLoader4Fill size={16} className="spinning" />}
                              {result.status === 'pending' && <RiTimeLine size={16} />}
                            </span>
                            <span className="batch-result-name">{result.sessionName}</span>
                            {result.duration !== undefined && (
                              <span className="batch-result-duration">{result.duration}ms</span>
                            )}
                          </div>
                          {(result.stdout || result.stderr) && (
                            <pre className="batch-result-output">
                              {result.stdout}
                              {result.stderr && <span className="batch-result-stderr">{result.stderr}</span>}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
