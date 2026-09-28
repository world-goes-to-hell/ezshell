import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { RiCpuLine, RiHardDriveLine, RiDatabase2Line, RiTimeLine, RiRefreshLine, RiCloseFill } from 'react-icons/ri'
import { useMonitorStore, fetchMetrics } from '../../stores/monitorStore'

interface ServerMonitorProps {
  sessionId: string
  onClose: () => void
}

function MetricBar({ label, value, color, detail }: { label: string; value: number; color: string; detail?: string }) {
  return (
    <div className="monitor-metric">
      <div className="monitor-metric-header">
        <span className="monitor-metric-label">{label}</span>
        <span className="monitor-metric-value" style={{ color }}>{value.toFixed(1)}%</span>
      </div>
      <div className="monitor-bar-bg">
        <motion.div
          className="monitor-bar-fill"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(value, 100)}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>
      {detail && <span className="monitor-metric-detail">{detail}</span>}
    </div>
  )
}

function MiniChart({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const h = 40
  const w = 180
  const step = w / (data.length - 1)

  const points = data.map((v, i) => `${i * step},${h - (v / max) * h}`).join(' ')

  return (
    <svg className="monitor-mini-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ServerMonitor({ sessionId, onClose }: ServerMonitorProps) {
  const { metrics, history, setMetrics, startMonitoring, stopMonitoring } = useMonitorStore()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const currentMetrics = metrics.get(sessionId)
  const metricsHistory = history.get(sessionId) || []

  const cpuHistory = metricsHistory.map(m => m.cpu.usage)
  const memHistory = metricsHistory.map(m => m.memory.usage)

  useEffect(() => {
    startMonitoring(sessionId)

    const doFetch = async () => {
      const result = await fetchMetrics(sessionId)
      if (result) {
        setMetrics(sessionId, result)
      }
    }

    doFetch()
    intervalRef.current = setInterval(doFetch, 5000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      stopMonitoring(sessionId)
    }
  }, [sessionId])

  const handleRefresh = async () => {
    const result = await fetchMetrics(sessionId)
    if (result) {
      setMetrics(sessionId, result)
    }
  }

  const getColor = (value: number) => {
    if (value >= 90) return 'var(--error)'
    if (value >= 70) return 'var(--warning)'
    return 'var(--success)'
  }

  return (
    <motion.div
      className="server-monitor"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
    >
      <div className="monitor-header">
        <span className="monitor-title">서버 모니터링</span>
        <div className="monitor-actions">
          <button className="monitor-action-btn" onClick={handleRefresh} title="새로고침">
            <RiRefreshLine size={14} />
          </button>
          <button className="monitor-action-btn" onClick={onClose} title="닫기">
            <RiCloseFill size={14} />
          </button>
        </div>
      </div>

      {!currentMetrics ? (
        <div className="monitor-loading">
          <span className="monitor-spinner" />
          <span>모니터링 데이터 수집 중...</span>
        </div>
      ) : (
        <div className="monitor-body">
          {/* Uptime */}
          {currentMetrics.uptime && (
            <div className="monitor-uptime">
              <RiTimeLine size={13} />
              <span>Uptime: {currentMetrics.uptime}</span>
            </div>
          )}

          {/* CPU */}
          <div className="monitor-section">
            <div className="monitor-section-title">
              <RiCpuLine size={14} />
              <span>CPU</span>
              {currentMetrics.cpu.cores > 0 && (
                <span className="monitor-badge">{currentMetrics.cpu.cores} cores</span>
              )}
            </div>
            <MetricBar
              label="사용률"
              value={currentMetrics.cpu.usage}
              color={getColor(currentMetrics.cpu.usage)}
              detail={currentMetrics.cpu.loadAvg ? `Load: ${currentMetrics.cpu.loadAvg}` : undefined}
            />
            <MiniChart data={cpuHistory} color={getColor(currentMetrics.cpu.usage)} />
          </div>

          {/* Memory */}
          <div className="monitor-section">
            <div className="monitor-section-title">
              <RiDatabase2Line size={14} />
              <span>메모리</span>
            </div>
            <MetricBar
              label="사용률"
              value={currentMetrics.memory.usage}
              color={getColor(currentMetrics.memory.usage)}
              detail={`${currentMetrics.memory.used}MB / ${currentMetrics.memory.total}MB`}
            />
            <MiniChart data={memHistory} color={getColor(currentMetrics.memory.usage)} />
          </div>

          {/* Disk */}
          <div className="monitor-section">
            <div className="monitor-section-title">
              <RiHardDriveLine size={14} />
              <span>디스크</span>
            </div>
            {currentMetrics.disk.filesystems.map((fs, i) => (
              <MetricBar
                key={i}
                label={fs.mount}
                value={fs.usage}
                color={getColor(fs.usage)}
                detail={`${fs.used} / ${fs.size}`}
              />
            ))}
          </div>
        </div>
      )}
    </motion.div>
  )
}
