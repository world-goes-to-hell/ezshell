// Settings > MCP > 에이전트: what happens to an agent left idle in a local shell (src/agentIdle.js)
import { useState } from 'react'
import './AgentIdleSettings.css'
import { minutesLabel, readAgentIdlePrefs, SLEEP_CHOICES, TRIM_CHOICES, writeAgentIdlePrefs, type AgentIdlePrefs } from '../../lib/agentIdlePrefs'

export function AgentIdleSettings() {
  const [prefs, setPrefs] = useState<AgentIdlePrefs>(readAgentIdlePrefs)
  const change = (next: AgentIdlePrefs) => {
    setPrefs(next)
    writeAgentIdlePrefs(next)
  }

  return (
    <section className="settings-section mcp-settings-group">
      <h3 className="settings-section-title">쉬는 에이전트의 메모리</h3>
      <p className="settings-section-desc">
        로컬 터미널의 Claude Code·Codex 가 작업도 입력도 없이 쉬고 있으면 메모리를 돌려받습니다. Claude Code 하나가 500MB~1GB 를 씁니다.
      </p>
      <label className="agent-idle-field">
        <span className="agent-idle-label">메모리 비우기</span>
        <select
          className="agent-idle-select"
          value={prefs.trimMinutes}
          onChange={event => change({ ...prefs, trimMinutes: Number(event.target.value) })}
        >
          {TRIM_CHOICES.map(value => <option key={value} value={value}>{value ? `${minutesLabel(value)} 쉬면` : '끔'}</option>)}
        </select>
      </label>
      <p className="settings-section-desc">
        에이전트는 그대로 두고 쓰지 않는 메모리만 Windows 에 돌려줍니다. 다시 일하면 저절로 돌아옵니다 (Windows 만).
      </p>
      <label className="agent-idle-field">
        <span className="agent-idle-label">잠재우기</span>
        <select
          className="agent-idle-select"
          value={prefs.sleepMinutes}
          onChange={event => change({ ...prefs, sleepMinutes: Number(event.target.value) })}
        >
          {SLEEP_CHOICES.map(value => <option key={value} value={value}>{value ? `${minutesLabel(value)} 쉬면` : '끔'}</option>)}
        </select>
      </label>
      <p className="settings-section-desc">
        에이전트를 끄고 셸은 남깁니다. 칸의 <code>깨우기</code> 를 누르거나 메시지가 오면 같은 대화를 이어서 다시 띄웁니다
        (<code>claude --resume</code>, <code>codex resume</code>). 셸에 직접 입력해 띄운 에이전트만 잠재웁니다. 백그라운드 명령이 돌고 있으면 잠재우지 않습니다.
        다시 띄우면 처음 실행할 때 준 권한·모델 옵션은 이어지지만, 실행 중에 <code>/model</code> 로 바꾼 모델은 기본값으로 돌아갑니다.
      </p>
    </section>
  )
}
