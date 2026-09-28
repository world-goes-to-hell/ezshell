import { useMemo } from 'react'
import { RiBarChartFill, RiTimeLine, RiServerLine, RiTerminalLine, RiCloseLine, RiDeleteBinLine, RiPulseLine } from 'react-icons/ri'
import { motion } from 'framer-motion'
import { useStatsStore, DashboardStats } from '../../stores/statsStore'

interface StatsDashboardProps {
  open: boolean
  onClose: () => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '0초'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}일 ${hours % 24}시간`
  if (hours > 0) return `${hours}시간 ${minutes % 60}분`
  if (minutes > 0) return `${minutes}분 ${seconds % 60}초`
  return `${seconds}초`
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hours = d.getHours().toString().padStart(2, '0')
  const mins = d.getMinutes().toString().padStart(2, '0')
  return `${month}/${day} ${hours}:${mins}`
}

function StatCard({ icon: Icon, label, value, sub }: {
  icon: typeof RiBarChartFill
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="stats-card">
      <div className="stats-card-icon"><Icon size={20} /></div>
      <div className="stats-card-info">
        <div className="stats-card-value">{value}</div>
        <div className="stats-card-label">{label}</div>
        {sub && <div className="stats-card-sub">{sub}</div>}
      </div>
    </div>
  )
}

function BarChart({ data, maxVal }: { data: { label: string; value: number }[]; maxVal: number }) {
  return (
    <div className="stats-bar-chart">
      {data.map((d, i) => (
        <div key={i} className="stats-bar-row">
          <span className="stats-bar-label">{d.label}</span>
          <div className="stats-bar-track">
            <motion.div
              className="stats-bar-fill"
              initial={{ width: 0 }}
              animate={{ width: maxVal > 0 ? `${(d.value / maxVal) * 100}%` : '0%' }}
              transition={{ duration: 0.5, delay: i * 0.05 }}
            />
          </div>
          <span className="stats-bar-value">{d.value}</span>
        </div>
      ))}
    </div>
  )
}

export function StatsDashboard({ open, onClose }: StatsDashboardProps) {
  const { getStats, clearRecords, records } = useStatsStore()

  const stats: DashboardStats = useMemo(() => getStats(), [records])

  if (!open) return null

  const totalCommands = records.reduce((sum, r) => sum + r.commandCount, 0)
  const maxDayCount = Math.max(...stats.connectionsByDay.map(d => d.count), 1)
  const maxHostCount = Math.max(...stats.topHosts.map(h => h.count), 1)
  const maxHourCount = Math.max(...stats.connectionsByHour, 1)

  return (
    <div className="stats-overlay" onClick={onClose}>
      <motion.div
        className="stats-dashboard"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Header */}
        <div className="stats-header">
          <div className="stats-header-left">
            <RiBarChartFill size={20} />
            <h2>세션 통계</h2>
          </div>
          <div className="stats-header-right">
            <button className="stats-clear-btn" onClick={clearRecords} title="기록 초기화">
              <RiDeleteBinLine size={16} />
              <span>초기화</span>
            </button>
            <button className="stats-close-btn" onClick={onClose}>
              <RiCloseLine size={20} />
            </button>
          </div>
        </div>

        <div className="stats-body">
          {/* Overview Cards */}
          <div className="stats-cards">
            <StatCard
              icon={RiServerLine}
              label="총 연결"
              value={stats.totalConnections.toString()}
            />
            <StatCard
              icon={RiTimeLine}
              label="총 사용 시간"
              value={formatDuration(stats.totalDuration)}
            />
            <StatCard
              icon={RiPulseLine}
              label="평균 세션"
              value={formatDuration(stats.avgDuration)}
            />
            <StatCard
              icon={RiTerminalLine}
              label="총 명령어"
              value={totalCommands.toLocaleString()}
            />
          </div>

          {/* Charts Row */}
          <div className="stats-charts-row">
            {/* Connections by Day */}
            <div className="stats-section">
              <h3 className="stats-section-title">주간 연결 추이</h3>
              <BarChart
                data={stats.connectionsByDay.map(d => ({ label: d.day, value: d.count }))}
                maxVal={maxDayCount}
              />
            </div>

            {/* Top Hosts */}
            <div className="stats-section">
              <h3 className="stats-section-title">자주 연결하는 호스트</h3>
              {stats.topHosts.length === 0 ? (
                <div className="stats-empty">연결 기록이 없습니다</div>
              ) : (
                <BarChart
                  data={stats.topHosts.map(h => ({ label: h.host, value: h.count }))}
                  maxVal={maxHostCount}
                />
              )}
            </div>
          </div>

          {/* Hourly Heatmap */}
          <div className="stats-section">
            <h3 className="stats-section-title">시간대별 활동</h3>
            <div className="stats-heatmap">
              {stats.connectionsByHour.map((count, hour) => (
                <div
                  key={hour}
                  className="stats-heatmap-cell"
                  style={{
                    opacity: maxHourCount > 0 ? 0.15 + (count / maxHourCount) * 0.85 : 0.15,
                    backgroundColor: count > 0 ? 'var(--accent)' : 'var(--bg-tertiary)',
                  }}
                  title={`${hour}시: ${count}회`}
                >
                  <span className="stats-heatmap-hour">{hour}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Sessions */}
          <div className="stats-section">
            <h3 className="stats-section-title">최근 연결</h3>
            {stats.recentSessions.length === 0 ? (
              <div className="stats-empty">연결 기록이 없습니다</div>
            ) : (
              <div className="stats-timeline">
                {stats.recentSessions.map((r) => (
                  <div key={r.id} className="stats-timeline-item">
                    <div className="stats-timeline-dot" />
                    <div className="stats-timeline-info">
                      <div className="stats-timeline-name">
                        {r.sessionName || `${r.username}@${r.host}`}
                      </div>
                      <div className="stats-timeline-meta">
                        <span>{formatTime(r.connectedAt)}</span>
                        {r.disconnectedAt && (
                          <span> · {formatDuration(r.disconnectedAt - r.connectedAt)}</span>
                        )}
                        {r.commandCount > 0 && (
                          <span> · {r.commandCount}개 명령어</span>
                        )}
                        {!r.disconnectedAt && (
                          <span className="stats-timeline-active">연결 중</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
