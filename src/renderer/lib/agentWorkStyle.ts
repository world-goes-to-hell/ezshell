// How a working agent is shown on its pane and sidebar rows (styles/app/agent-work-trace.css), chosen in
// 설정 > 테마 > 창 효과. The light running around the border repaints every frame wherever an agent works
// (its pane, its sidebar rows, the pane map): with a few agents that was a tenth of the CPU (2026-11-26
// measure, 6 panes: +176ms of renderer work a second). The others only fade a light drawn once.

export type AgentWorkStyle = 'glow' | 'pulse' | 'trace' | 'static'

export const AGENT_WORK_STYLE_KEY = 'agent-work-style'
export const DEFAULT_AGENT_WORK_STYLE: AgentWorkStyle = 'glow'
export const AGENT_WORK_STYLE_CHANGED = 'ezshell:agent-work-style-changed'

export const AGENT_WORK_STYLES: readonly { id: AgentWorkStyle; label: string; description: string; cpu: string }[] = [
  { id: 'glow', label: '안쪽 번짐', description: '칸 안쪽으로 빛이 은은하게 번졌다 사라집니다.', cpu: 'CPU 적게 씀 (기본)' },
  { id: 'pulse', label: '테두리 깜빡임', description: '테두리가 밝아졌다 어두워집니다.', cpu: 'CPU 적게 씀' },
  { id: 'trace', label: '도는 빛', description: '빛이 테두리를 따라 돕니다.', cpu: 'CPU 많이 씀 · 작업 중인 칸마다 매 프레임 다시 그려, 에이전트가 많으면 CPU 를 눈에 띄게 씁니다' },
  { id: 'static', label: '움직이지 않음', description: '테두리만 켜 둡니다.', cpu: 'CPU 거의 쓰지 않음' }
]

export function parseAgentWorkStyle(raw: string | null | undefined): AgentWorkStyle {
  return AGENT_WORK_STYLES.some(style => style.id === raw) ? (raw as AgentWorkStyle) : DEFAULT_AGENT_WORK_STYLE
}

export function getAgentWorkStyle(): AgentWorkStyle {
  try {
    return parseAgentWorkStyle(localStorage.getItem(AGENT_WORK_STYLE_KEY))
  } catch {
    return DEFAULT_AGENT_WORK_STYLE
  }
}

/** On the root element, where the stylesheet picks the style (no attribute: the default) */
export function applyAgentWorkStyle(style: AgentWorkStyle = getAgentWorkStyle()): void {
  document.documentElement.dataset.agentWorkStyle = style
}

export function setAgentWorkStyle(style: AgentWorkStyle): void {
  const value = parseAgentWorkStyle(style)
  try { localStorage.setItem(AGENT_WORK_STYLE_KEY, value) } catch { /* shown for this run only */ }
  applyAgentWorkStyle(value)
  window.dispatchEvent(new CustomEvent(AGENT_WORK_STYLE_CHANGED, { detail: value }))
}

/** Every window applies the choice; one changed in another window of the app follows (storage event) */
export function installAgentWorkStyle(): void {
  applyAgentWorkStyle()
  window.addEventListener('storage', event => {
    if (event.key === AGENT_WORK_STYLE_KEY) applyAgentWorkStyle(parseAgentWorkStyle(event.newValue))
  })
}
