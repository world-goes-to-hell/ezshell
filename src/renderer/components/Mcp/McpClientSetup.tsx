import { useRef, useState } from 'react'
import { RiFolderOpenLine, RiGlobalLine } from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import type { McpSetupResult, McpSetupScope } from '../../types'
import { conflictQuestion, describeSetupOutcome, type SetupView } from '../../lib/mcpSetupLabels'

const TITLE = 'MCP 자동 설정'

interface McpClientSetupProps {
  /** True while the app is locked: the main process refuses to write the token then */
  disabled: boolean
}

/** Writes the Claude Code registration into .mcp.json (one project) or ~/.claude.json (every project) */
export function McpClientSetup({ disabled }: McpClientSetupProps) {
  const api = window.electronAPI
  const isWindows = navigator.userAgent.includes('Windows')
  const [setTokenEnv, setSetTokenEnv] = useState(isWindows)
  const [isBusy, setIsBusy] = useState(false)
  const [view, setView] = useState<SetupView | null>(null)
  const busyRef = useRef(false)

  if (typeof api?.mcpSetupClient !== 'function') return null
  const setupClient = api.mcpSetupClient

  const askAndSetup = async (scope: McpSetupScope): Promise<McpSetupResult | null> => {
    const request = { scope, setTokenEnv: scope === 'project' && setTokenEnv }
    const first = await setupClient(request)
    if (!first.success || first.outcome.result !== 'conflict') return first
    if (!window.confirm(conflictQuestion(first.outcome))) return null
    return setupClient({ ...request, overwrite: true, reuseDir: true })
  }

  const runSetup = async (scope: McpSetupScope) => {
    if (busyRef.current) return
    busyRef.current = true
    setIsBusy(true)
    try {
      const reply = await askAndSetup(scope)
      if (!reply) return
      if (!reply.success) {
        if (!reply.cancelled) toast.error(TITLE, reply.error ?? '설정하지 못했습니다')
        return
      }
      const next = describeSetupOutcome(reply.outcome)
      setView(next)
      if (next.tone === 'warning') toast.warning(TITLE, next.title)
      else toast.success(TITLE, next.title)
    } catch {
      toast.error(TITLE, '요청을 처리하지 못했습니다')
    } finally {
      busyRef.current = false
      setIsBusy(false)
    }
  }

  const isDisabled = disabled || isBusy

  return (
    <div className="mcp-field">
      <span className="mcp-field-label">Claude Code 자동 설정</span>
      <div className="mcp-setup-actions">
        <button type="button" className="mcp-setup-btn" onClick={() => void runSetup('project')} disabled={isDisabled}>
          <RiFolderOpenLine size={16} />
          <span>프로젝트에 설정 (.mcp.json)</span>
        </button>
        <button type="button" className="mcp-setup-btn" onClick={() => void runSetup('global')} disabled={isDisabled}>
          <RiGlobalLine size={16} />
          <span>모든 프로젝트에 설정 (~/.claude.json)</span>
        </button>
      </div>
      {isWindows && (
        <label className="mcp-toggle">
          <input type="checkbox" checked={setTokenEnv} disabled={isDisabled} onChange={(e) => setSetTokenEnv(e.target.checked)} />
          <span>프로젝트에 설정할 때 사용자 환경 변수 EZSHELL_MCP_TOKEN 도 설정</span>
        </label>
      )}
      <p className="form-hint">
        프로젝트 설정은 토큰 대신 환경 변수 이름만 파일에 써서, 파일을 커밋해도 토큰이 드러나지 않습니다.
        전체 설정은 ~/.claude.json 에 토큰을 직접 씁니다. 기존 항목은 그대로 두고, 바꾸기 전에 원래 파일을 백업합니다.
        토큰을 재발급하면 자동 설정을 다시 실행하세요.
      </p>
      {view && (
        <div className={`mcp-setup-result ${view.tone}`} role="status">
          <strong>{view.title}</strong>
          <ul>
            {view.lines.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
