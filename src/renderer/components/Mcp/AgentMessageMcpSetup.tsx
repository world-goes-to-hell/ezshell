import { useEffect, useRef, useState } from 'react'
import { RiFileCopyLine } from 'react-icons/ri'
import type { LocalAgent } from '../../types'

const names = { codex: 'Codex', claude: 'Claude Code' }

export function AgentMessageMcpSetup() {
  const running = useRef(false)
  const [busy, setBusy] = useState<LocalAgent | 'external' | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [environment, setEnvironment] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const result = await window.electronAPI.agentMessageMcpExternal('read')
        if (mounted && result.success) setEnvironment(result.environment)
        else if (mounted && !result.success) setNotice({ text: result.error, error: true })
      } catch {
        if (mounted) setNotice({ text: '외부 메시지 MCP 설정을 불러오지 못했습니다.', error: true })
      }
    }
    void load()
    return () => { mounted = false }
  }, [])

  const register = async (kind: LocalAgent) => {
    if (running.current) return
    running.current = true
    setBusy(kind)
    setNotice(null)
    const name = names[kind]
    try {
      const result = await window.electronAPI.agentMessageMcpSetup(kind)
      if (!result.success) setNotice({ text: result.error, error: true })
      else if (result.result === 'conflict') {
        setNotice({ text: `${name}에 같은 이름(ezshell-cli-mcp)의 다른 설정이 있습니다. 기존 설정을 확인해 주세요.`, error: true })
      } else {
        setNotice({ text: `${name}에 메시지 MCP가 등록되어 있습니다. 새 세션부터 사용할 수 있습니다.`, error: false })
      }
    } catch {
      setNotice({ text: `${name} 메시지 MCP를 등록하지 못했습니다.`, error: true })
    } finally {
      running.current = false
      setBusy(null)
    }
  }

  const copy = async (action: 'copy-command' | 'copy-env') => {
    if (running.current) return
    running.current = true
    setBusy('external')
    setNotice(null)
    try {
      const result = await window.electronAPI.agentMessageMcpExternal(action)
      setNotice(result.success
        ? { text: action === 'copy-command' ? 'Command를 복사했습니다.' : '환경 변수를 복사했습니다.', error: false }
        : { text: result.error, error: true })
    } catch {
      setNotice({ text: '외부 메시지 MCP 설정을 복사하지 못했습니다.', error: true })
    } finally {
      running.current = false
      setBusy(null)
    }
  }

  return (
    <div className="mcp-field">
      <div className="mcp-setup-actions">
        {(['codex', 'claude'] as const).map(kind => (
          <button key={kind} type="button" className="mcp-setup-btn" onClick={() => void register(kind)} disabled={!!busy}>
            {busy === kind ? `${names[kind]} 등록 중…` : `${names[kind]}에 등록`}
          </button>
        ))}
      </div>
      <div className="mcp-external-setup mcp-field">
        <h4 className="mcp-field-label">Aside 등 외부 MCP 클라이언트</h4>
        <p className="settings-section-desc">Local stdio 서버를 추가하고 Command와 Env를 붙여 넣으세요.</p>
        <div className="mcp-setup-actions">
          <button type="button" className="mcp-setup-btn" onClick={() => void copy('copy-command')} disabled={!!busy || !environment}>
            <RiFileCopyLine aria-hidden="true" /> Command 복사
          </button>
          <button type="button" className="mcp-setup-btn" onClick={() => void copy('copy-env')} disabled={!!busy || !environment}>
            <RiFileCopyLine aria-hidden="true" /> Env 복사
          </button>
        </div>
        {environment && <div className="mcp-command"><pre aria-label="Env">{environment}</pre></div>}
      </div>
      {notice && <div className={`mcp-setup-result ${notice.error ? 'warning' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
    </div>
  )
}
