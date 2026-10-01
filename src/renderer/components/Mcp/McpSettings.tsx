import { useCallback, useEffect, useRef, useState } from 'react'
import { RiEyeLine, RiEyeOffLine, RiFileCopyLine, RiRefreshLine } from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import type { McpStatus, McpStatusResult } from '../../types'
import { ALERT_LEVEL_OPTIONS, maskRegisterCommand, maskToken, parsePort } from '../../lib/mcpLabels'
import { McpAuditList } from './McpAuditList'
import { McpClientSetup } from './McpClientSetup'
import './Mcp.css'

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('복사됨', `${label}을(를) 복사했습니다`)
  } catch {
    toast.error('복사 실패', '클립보드에 접근할 수 없습니다')
  }
}

export function McpSettings() {
  const api = window.electronAPI
  const isSupported = typeof api?.mcpGetStatus === 'function'
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [portDraft, setPortDraft] = useState('')
  const [isTokenVisible, setIsTokenVisible] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const busyRef = useRef(false)
  const statusRef = useRef<McpStatus | null>(null)

  const resetPortDraft = useCallback(() => {
    if (statusRef.current) setPortDraft(String(statusRef.current.config.port))
  }, [])

  const applyResult = useCallback((result: McpStatusResult): boolean => {
    if (!result.success) {
      toast.error('MCP 설정', result.error)
      resetPortDraft()
      return false
    }
    statusRef.current = result.status
    setStatus(result.status)
    setPortDraft(String(result.status.config.port))
    return true
  }, [resetPortDraft])

  useEffect(() => {
    if (!isSupported) return
    api.mcpGetStatus!().then(applyResult).catch(() => toast.error('MCP 설정', '상태를 불러오지 못했습니다'))
  }, [api, isSupported, applyResult])

  const run = async (task: () => Promise<McpStatusResult>): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true
    setIsBusy(true)
    try {
      return applyResult(await task())
    } catch {
      toast.error('MCP 설정', '요청을 처리하지 못했습니다')
      resetPortDraft()
      return false
    } finally {
      busyRef.current = false
      setIsBusy(false)
    }
  }

  if (!isSupported) return <p className="settings-section-desc">앱을 다시 시작하면 MCP 설정을 사용할 수 있습니다.</p>
  if (!status) return <p className="settings-section-desc">불러오는 중…</p>

  const { config } = status
  // The main process sends an empty token and register command while the app is locked
  const hasToken = config.token !== ''
  const shownToken = isTokenVisible && hasToken ? config.token : maskToken(config.token)

  const commitPort = () => {
    if (busyRef.current) return
    const port = parsePort(portDraft)
    if (port === null) {
      toast.error('포트', '1024~65535 사이의 정수를 입력하세요')
      setPortDraft(String(config.port))
      return
    }
    if (port !== config.port) run(() => api.mcpUpdateConfig!({ port }))
  }

  const regenerate = async () => {
    if (!window.confirm('토큰을 재발급하면 Claude Code 에 다시 등록해야 합니다. 계속할까요?')) return
    if (await run(() => api.mcpRegenerateToken!())) setIsTokenVisible(false)
  }

  return (
    <div className="mcp-settings">
      <div className="mcp-row">
        <label className="mcp-toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={isBusy}
            onChange={(e) => run(() => api.mcpUpdateConfig!({ enabled: e.target.checked }))}
          />
          <span>MCP 서버 켜기</span>
        </label>
        <span aria-live="polite" className={`mcp-state ${status.running ? 'running' : ''}`}>
          {status.running ? `실행 중 · 127.0.0.1:${config.port}` : '꺼짐'}
        </span>
      </div>
      {status.error && <p className="mcp-error" role="alert">{status.error}</p>}

      <div className="mcp-field">
        <label className="mcp-field-label" htmlFor="mcp-port">포트</label>
        <input
          id="mcp-port"
          className="mcp-port-input"
          inputMode="numeric"
          value={portDraft}
          disabled={isBusy}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      </div>

      <fieldset className="mcp-field">
        <legend className="mcp-field-label">확인 창을 띄울 명령</legend>
        {ALERT_LEVEL_OPTIONS.map(option => (
          <label key={option.value} className="mcp-radio">
            <input
              type="radio"
              name="mcp-alert-level"
              checked={config.alertLevel === option.value}
              disabled={isBusy}
              onChange={() => run(() => api.mcpUpdateConfig!({ alertLevel: option.value }))}
            />
            <span className="mcp-radio-label">{option.label}</span>
            <span className="mcp-radio-desc">{option.description}</span>
          </label>
        ))}
        <p className="form-hint">위험한 명령은 어떤 설정에서도 확인 창을 띄우고, 시스템 종료·루트 삭제 같은 명령은 항상 차단합니다.</p>
      </fieldset>

      <div className="mcp-field">
        <span className="mcp-field-label">접속 토큰</span>
        <div className="mcp-token">
          <code>{shownToken}</code>
          <button type="button" className="mcp-icon-btn" onClick={() => setIsTokenVisible(visible => !visible)} disabled={!hasToken} aria-label={isTokenVisible ? '토큰 숨기기' : '토큰 보기'} title={isTokenVisible ? '숨기기' : '보기'}>
            {isTokenVisible ? <RiEyeOffLine size={16} /> : <RiEyeLine size={16} />}
          </button>
          <button type="button" className="mcp-icon-btn" onClick={() => copyText(config.token, '토큰')} disabled={!hasToken} aria-label="토큰 복사" title="복사">
            <RiFileCopyLine size={16} />
          </button>
          <button type="button" className="mcp-icon-btn" onClick={regenerate} disabled={isBusy} aria-label="토큰 재발급" title="재발급">
            <RiRefreshLine size={16} />
          </button>
        </div>
      </div>

      <div className="mcp-field">
        <span className="mcp-field-label">Claude Code 등록 명령</span>
        <div className="mcp-command">
          <pre>{maskRegisterCommand(status.registerCommand, config.token, shownToken)}</pre>
          <button type="button" className="mcp-icon-btn" onClick={() => copyText(status.registerCommand, '등록 명령')} disabled={!hasToken || !status.registerCommand} aria-label="등록 명령 복사" title="복사">
            <RiFileCopyLine size={16} />
          </button>
        </div>
        <p className="form-hint">터미널에서 실행하면 Claude Code 에 등록됩니다. 세션 편집 &gt; 고급 설정에서 "MCP 접근 허용"을 켠 세션만 Claude 에게 보입니다.</p>
      </div>

      <McpClientSetup disabled={!hasToken} />

      <McpAuditList />
    </div>
  )
}
