import { useState, useEffect } from 'react'
import { RiArrowLeftRightLine, RiArrowRightLine, RiArrowLeftLine, RiGlobalLine, RiAddLine, RiCloseLine, RiStopCircleLine, RiLinkM } from 'react-icons/ri'
import { motion, AnimatePresence } from 'framer-motion'
import { usePortForwardStore, PortForward } from '../../stores/portForwardStore'

interface PortForwardPanelProps {
  sessionId: string
  onClose: () => void
}

type ForwardType = 'local' | 'remote' | 'dynamic'

interface NewForwardForm {
  type: ForwardType
  localHost: string
  localPort: string
  remoteHost: string
  remotePort: string
}

const defaultForm: NewForwardForm = {
  type: 'local',
  localHost: '127.0.0.1',
  localPort: '',
  remoteHost: '127.0.0.1',
  remotePort: '',
}

const typeLabels: Record<ForwardType, string> = {
  local: '로컬 → 원격 (-L)',
  remote: '원격 → 로컬 (-R)',
  dynamic: 'SOCKS5 프록시 (-D)',
}

const typeIcons: Record<ForwardType, typeof RiArrowRightLine> = {
  local: RiArrowRightLine,
  remote: RiArrowLeftLine,
  dynamic: RiGlobalLine,
}

export function PortForwardPanel({ sessionId, onClose }: PortForwardPanelProps) {
  const { forwards, setForwards } = usePortForwardStore()
  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState<NewForwardForm>({ ...defaultForm })
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const sessionForwards = forwards.get(sessionId) || []

  // Listen for port forward updates from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onPortForwardUpdate?.((data: any) => {
      if (data.sessionId === sessionId) {
        setForwards(sessionId, data.forwards)
      }
    })

    // Load initial list
    window.electronAPI.portForwardList?.(sessionId).then((list: PortForward[]) => {
      if (list) setForwards(sessionId, list)
    })

    return () => { cleanup?.() }
  }, [sessionId])

  const handleAdd = async () => {
    setError('')
    setIsLoading(true)

    try {
      const localPort = parseInt(form.localPort)
      const remotePort = parseInt(form.remotePort)

      if (form.type !== 'dynamic' && (!localPort || !remotePort)) {
        setError('포트 번호를 입력하세요.')
        setIsLoading(false)
        return
      }
      if (form.type === 'dynamic' && !localPort) {
        setError('로컬 포트를 입력하세요.')
        setIsLoading(false)
        return
      }

      let result: any
      if (form.type === 'local') {
        result = await window.electronAPI.portForwardLocal(
          sessionId, localPort, form.remoteHost, remotePort, form.localHost
        )
      } else if (form.type === 'remote') {
        result = await window.electronAPI.portForwardRemote(
          sessionId, remotePort, form.localHost, localPort, form.remoteHost
        )
      } else {
        result = await window.electronAPI.portForwardDynamic(
          sessionId, localPort, form.localHost
        )
      }

      if (result.success) {
        setForm({ ...defaultForm })
        setShowAddForm(false)
      } else {
        setError(result.error || '포트 포워딩 실패')
      }
    } catch (err: any) {
      setError(err?.message || '오류가 발생했습니다.')
    }
    setIsLoading(false)
  }

  const handleStop = async (forwardId: string) => {
    try {
      await window.electronAPI.portForwardStop(forwardId)
    } catch {}
  }

  return (
    <motion.div
      className="port-forward-panel"
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="pf-header">
        <div className="pf-header-left">
          <RiArrowLeftRightLine size={18} />
          <span className="pf-title">포트 포워딩</span>
          {sessionForwards.length > 0 && (
            <span className="pf-badge">{sessionForwards.length}</span>
          )}
        </div>
        <div className="pf-header-right">
          <button
            className="pf-icon-btn"
            onClick={() => { setShowAddForm(!showAddForm); setError('') }}
            title="포워딩 추가"
          >
            <RiAddLine size={18} />
          </button>
          <button className="pf-icon-btn" onClick={onClose} title="닫기">
            <RiCloseLine size={18} />
          </button>
        </div>
      </div>

      <div className="pf-body">
        {/* Add form */}
        <AnimatePresence>
          {showAddForm && (
            <motion.div
              className="pf-add-form"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              {/* Type selector */}
              <div className="pf-type-selector">
                {(['local', 'remote', 'dynamic'] as ForwardType[]).map((t) => {
                  const Icon = typeIcons[t]
                  return (
                    <button
                      key={t}
                      className={`pf-type-btn ${form.type === t ? 'active' : ''}`}
                      onClick={() => setForm({ ...form, type: t })}
                    >
                      <Icon size={16} />
                      <span>{t === 'local' ? '로컬' : t === 'remote' ? '원격' : 'SOCKS5'}</span>
                    </button>
                  )
                })}
              </div>

              <div className="pf-type-desc">{typeLabels[form.type]}</div>

              {/* Port fields */}
              <div className="pf-fields">
                <div className="pf-field-row">
                  <div className="pf-field">
                    <label>로컬 호스트</label>
                    <input
                      value={form.localHost}
                      onChange={(e) => setForm({ ...form, localHost: e.target.value })}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div className="pf-field">
                    <label>로컬 포트</label>
                    <input
                      type="number"
                      value={form.localPort}
                      onChange={(e) => setForm({ ...form, localPort: e.target.value })}
                      placeholder="8080"
                    />
                  </div>
                </div>

                {form.type !== 'dynamic' && (
                  <>
                    <div className="pf-arrow-divider">
                      {form.type === 'local' ? <RiArrowRightLine size={18} /> : <RiArrowLeftLine size={18} />}
                    </div>
                    <div className="pf-field-row">
                      <div className="pf-field">
                        <label>원격 호스트</label>
                        <input
                          value={form.remoteHost}
                          onChange={(e) => setForm({ ...form, remoteHost: e.target.value })}
                          placeholder="127.0.0.1"
                        />
                      </div>
                      <div className="pf-field">
                        <label>원격 포트</label>
                        <input
                          type="number"
                          value={form.remotePort}
                          onChange={(e) => setForm({ ...form, remotePort: e.target.value })}
                          placeholder="3306"
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Error */}
              {error && <div className="pf-error">{error}</div>}

              {/* Submit */}
              <button
                className="pf-submit-btn"
                onClick={handleAdd}
                disabled={isLoading}
              >
                {isLoading ? '추가 중...' : '포워딩 추가'}
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Active forwards list */}
        <div className="pf-list">
          {sessionForwards.length === 0 && !showAddForm && (
            <div className="pf-empty">
              <RiArrowLeftRightLine size={24} />
              <span>활성 포워딩 없음</span>
              <span className="pf-empty-hint">+ 버튼으로 포워딩을 추가하세요</span>
            </div>
          )}

          {sessionForwards.map((fwd) => {
            const Icon = typeIcons[fwd.type]
            return (
              <motion.div
                key={fwd.id}
                className="pf-item"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                layout
              >
                <div className="pf-item-icon">
                  <Icon size={16} />
                </div>
                <div className="pf-item-info">
                  <div className="pf-item-ports">
                    {fwd.type === 'dynamic' ? (
                      <span>SOCKS5 :{fwd.localPort}</span>
                    ) : fwd.type === 'local' ? (
                      <span>:{fwd.localPort} → {fwd.remoteHost}:{fwd.remotePort}</span>
                    ) : (
                      <span>{fwd.remoteHost}:{fwd.remotePort} → :{fwd.localPort}</span>
                    )}
                  </div>
                  <div className="pf-item-meta">
                    <span className="pf-item-type">{fwd.type.toUpperCase()}</span>
                    {fwd.connectionCount > 0 && (
                      <span className="pf-item-conns">
                        <RiLinkM size={16} /> {fwd.connectionCount}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  className="pf-stop-btn"
                  onClick={() => handleStop(fwd.id)}
                  title="중지"
                >
                  <RiStopCircleLine size={18} />
                </button>
              </motion.div>
            )
          })}
        </div>
      </div>
    </motion.div>
  )
}
