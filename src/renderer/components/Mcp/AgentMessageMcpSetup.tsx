import { useRef, useState } from 'react'
import type { LocalAgent } from '../../types'

const names = { codex: 'Codex', claude: 'Claude Code' }

export function AgentMessageMcpSetup() {
  const running = useRef(false)
  const [busy, setBusy] = useState<LocalAgent | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)

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

  return (
    <div className="mcp-field">
      <div className="mcp-setup-actions">
        {(['codex', 'claude'] as const).map(kind => (
          <button key={kind} type="button" className="mcp-setup-btn" onClick={() => void register(kind)} disabled={!!busy}>
            {busy === kind ? `${names[kind]} 등록 중…` : `${names[kind]}에 등록`}
          </button>
        ))}
      </div>
      {notice && <div className={`mcp-setup-result ${notice.error ? 'warning' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
    </div>
  )
}
