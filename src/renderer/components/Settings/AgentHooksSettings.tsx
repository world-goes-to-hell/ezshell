// Settings > MCP > 에이전트 메시지: whether agents report their state through the CLIs' hooks
// (docs/plan/2026-11-24-agent-state-via-official-signals.md, user decision 4)
import { useEffect, useState } from 'react'
import { readAgentHooksPrefs, writeAgentHooksPrefs, type AgentHooksPrefs } from '../../lib/agentHooksPrefs'
import { useAgentHooksStore } from '../../stores/agentHooksStore'
import './AgentIdleSettings.css'

export function AgentHooksSettings() {
  const [prefs, setPrefs] = useState<AgentHooksPrefs>(readAgentHooksPrefs)
  const codexMode = useAgentHooksStore(state => state.codexMode)
  const reverted = useAgentHooksStore(state => state.reverted)
  useEffect(() => { if (reverted) setPrefs(readAgentHooksPrefs()) }, [reverted])
  const change = (enabled: boolean) => {
    const next = { enabled }
    // Off → on by the user is the one change that lets Codex ask again
    const resetCodexDecline = enabled && !prefs.enabled
    setPrefs(next)
    writeAgentHooksPrefs(next, { resetCodexDecline })
  }

  return (
    <section className="settings-section mcp-settings-group">
      <h3 className="settings-section-title">에이전트 상태 알림</h3>
      <label className="agent-hooks-toggle">
        <input type="checkbox" checked={prefs.enabled} onChange={event => change(event.target.checked)} />
        <span>Claude·Codex 가 직접 알려 주는 신호로 작업 상태 정하기</span>
      </label>
      {/* The second half of the next sentence (messages held until the work ends) is true only with T5 of the
          design: drop it if the official-signal changes are committed without T5 (review 23) */}
      <p className="settings-section-desc">
        켜면 에이전트가 보내는 작업 시작·끝 신호로 작업 중·대기 상태를 정하고, 작업 중에 온 메시지는 그 일을 마친 뒤에 전합니다.
        끄면 바로 예전처럼 터미널 화면을 보고 판단하고, 작업 중에도 메시지를 바로 알립니다. 켜면 다음에 띄우는 에이전트부터 적용됩니다.
      </p>
      <p className="settings-section-desc">
        Codex 는 처음 한 번 Codex 화면에서 ezShell 의 훅을 승인해야 합니다.
      </p>
      {prefs.enabled && codexMode === 'disabled' && (
        <p className="settings-section-desc agent-hooks-note" role="status">
          Codex 는 지금 이 신호를 쓰지 않습니다 (승인하지 않았거나 <code>묻지 않기</code> 를 골랐습니다). 이 설정을 껐다 켜면 다음 실행 때 다시 묻습니다.
        </p>
      )}
    </section>
  )
}
