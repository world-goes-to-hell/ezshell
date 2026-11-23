import { useMemo, type ToggleEvent } from 'react'
import { parseCodexMcpOutput } from '../../lib/codexMcpOutput'

const labels = { connected: '연결됨', failed: '실패', auth: '인증 필요' }

export function CommandOutput({ text, command, isError, canLogin = false, onCommand, expanded, onToggle }: {
  text: string
  command?: string
  isError?: boolean
  canLogin?: boolean
  onCommand?: (command: string, loginServer?: string) => void
  expanded: boolean
  onToggle: (event: ToggleEvent<HTMLDetailsElement>) => void
}) {
  const servers = useMemo(() => command?.trim() === '/mcp' ? parseCodexMcpOutput(text) : null, [command, text])
  const raw = <pre className={`agent-chat-output${isError ? ' is-error' : ''}`} aria-label="명령 출력">{text}</pre>
  if (!servers) return raw

  return (
    <section className="agent-chat-mcp" aria-label="MCP 서버">
      <h3>MCP 서버</h3>
      <ul className="agent-chat-mcp-servers">
        {servers.map((server, index) => {
          const { name, status, label, tools, loginCommand } = server
          return (
            <li key={`${name}:${index}`}>
              <span className="agent-chat-mcp-name">{name}</span>
              <span className="agent-chat-mcp-status" data-status={status}>{status === 'other' ? label : labels[status]}</span>
              <span className="agent-chat-mcp-count">도구 {tools}개</span>
              {loginCommand && <button type="button" aria-label={`${name} 로그인`} disabled={!canLogin || !onCommand}
                onClick={() => onCommand?.(loginCommand, name)}>로그인</button>}
              {loginCommand && !canLogin && <small>터미널에서 확인해 주세요.</small>}
              {status === 'failed' && <small>Codex를 다시 시작하면 다시 연결합니다.</small>}
            </li>
          )
        })}
      </ul>
      <div className="agent-chat-mcp-actions">
        <button type="button" disabled={!onCommand} onClick={() => onCommand?.('/mcp verbose')}>자세히 보기</button>
      </div>
      <details open={expanded} onToggle={onToggle}>
        <summary>원문 보기</summary>
        {raw}
      </details>
    </section>
  )
}
