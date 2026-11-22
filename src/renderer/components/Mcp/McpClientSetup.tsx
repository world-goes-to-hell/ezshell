import { useRef, useState } from 'react'
import { RiFolderOpenLine, RiGlobalLine } from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import type { McpSetupClient, McpSetupResult, McpSetupScope } from '../../types'
import { conflictQuestion, describeSetupOutcome, MCP_SETUP_CLIENTS, type SetupView } from '../../lib/mcpSetupLabels'
import { SelectMenu } from '../ui/SelectMenu'

const TITLE = 'MCP 자동 설정'
const CLIENT_OPTIONS = Object.entries(MCP_SETUP_CLIENTS).map(([value, { label }]) => ({ value, label }))

interface McpClientSetupProps {
  /** True while the app is locked: the main process refuses to write the token then */
  disabled: boolean
}

export function McpClientSetup({ disabled }: McpClientSetupProps) {
  const api = window.electronAPI
  const isWindows = navigator.userAgent.includes('Windows')
  const [setTokenEnv, setSetTokenEnv] = useState(isWindows)
  const [client, setClient] = useState<McpSetupClient>('claude')
  const [isBusy, setIsBusy] = useState(false)
  const [view, setView] = useState<SetupView | null>(null)
  const busyRef = useRef(false)

  if (typeof api?.mcpSetupClient !== 'function') return null
  const setupClient = api.mcpSetupClient

  const askAndSetup = async (scope: McpSetupScope): Promise<McpSetupResult | null> => {
    const request = { client, scope, setTokenEnv: scope === 'project' && setTokenEnv }
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
  const locations = MCP_SETUP_CLIENTS[client]

  return (
    <section className="mcp-field settings-section mcp-settings-group">
      <h3 className="settings-section-title mcp-field-label">{TITLE}</h3>
      <p className="settings-section-desc">에이전트를 선택하고 SSH MCP를 등록할 범위를 고르세요.</p>
      <div className="mcp-row">
        <label className="mcp-field-label" htmlFor="mcp-setup-client">에이전트</label>
        <SelectMenu
          id="mcp-setup-client" ariaLabel="에이전트" value={client} options={CLIENT_OPTIONS}
          onChange={value => {
            if (busyRef.current) return
            setClient(value as McpSetupClient)
            setView(null)
          }}
        />
      </div>
      <div className="mcp-setup-actions">
        <button type="button" className="mcp-setup-btn" onClick={() => void runSetup('project')} disabled={isDisabled}>
          <RiFolderOpenLine size={16} />
          <span>프로젝트에 설정 ({locations.project})</span>
        </button>
        <button type="button" className="mcp-setup-btn" onClick={() => void runSetup('global')} disabled={isDisabled}>
          <RiGlobalLine size={16} />
          <span>모든 프로젝트에 설정 ({locations.global})</span>
        </button>
      </div>
      {isWindows && (
        <label className="mcp-toggle">
          <input type="checkbox" checked={setTokenEnv} disabled={isDisabled} onChange={(e) => setSetTokenEnv(e.target.checked)} />
          <span>프로젝트에 설정할 때 사용자 환경 변수 EZSHELL_MCP_TOKEN 도 설정</span>
        </label>
      )}
      <p className="form-hint">
        프로젝트 파일은 환경 변수 EZSHELL_MCP_TOKEN을 참조합니다. 전체 설정은 사용자 설정 파일에 토큰을 저장합니다.
        설정 파일을 바꾸기 전에 원본을 백업합니다. 토큰을 재발급하면 자동 설정을 다시 실행하세요.
      </p>
      {view && (
        <div className={`mcp-setup-result ${view.tone}`} role="status">
          <strong>{view.title}</strong>
          <ul>
            {view.lines.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        </div>
      )}
    </section>
  )
}
