import { useEffect, useState, type CSSProperties } from 'react'
import { MIN_WINDOW_OPACITY, type SurfaceStyle } from '../../lib/appearance'
import { AGENT_WORK_STYLES, AGENT_WORK_STYLE_CHANGED, getAgentWorkStyle, setAgentWorkStyle, type AgentWorkStyle } from '../../lib/agentWorkStyle'
import { useThemeStore } from '../../stores/themeStore'

/** 에이전트 작업 중 표시: each card shows its look on a small working pane (styles/app/agent-work-trace.css) */
function AgentWorkStyleSetting() {
  const [style, setStyle] = useState<AgentWorkStyle>(getAgentWorkStyle)
  useEffect(() => {
    const changed = (event: Event) => setStyle((event as CustomEvent<AgentWorkStyle>).detail)
    window.addEventListener(AGENT_WORK_STYLE_CHANGED, changed)
    return () => window.removeEventListener(AGENT_WORK_STYLE_CHANGED, changed)
  }, [])
  return (
    <div className="appearance-row appearance-row-stack">
      <div className="appearance-label">
        <span>에이전트 작업 중 표시</span>
        <span className="appearance-hint">에이전트가 일하는 칸과 사이드바 항목에 보이는 표시입니다. 움직이는 표시는 작업 중인 곳마다 CPU 를 씁니다.</span>
      </div>
      <div className="agent-work-styles" role="radiogroup" aria-label="에이전트 작업 중 표시">
        {AGENT_WORK_STYLES.map(item => (
          <button key={item.id} type="button" role="radio" aria-checked={style === item.id} className="agent-work-style" data-style={item.id}
            style={{ '--agent-work-style': item.id } as CSSProperties} onClick={() => { setAgentWorkStyle(item.id); setStyle(item.id) }}>
            <span className="agent-work-preview" data-agent-work="working" aria-hidden="true" />
            <span className="agent-work-style-name">{item.label}</span>
            <span className="agent-work-style-desc">{item.description}</span>
            <span className="agent-work-style-cpu" data-cost={item.id === 'trace' ? 'high' : 'low'}>{item.cpu}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

const SURFACES: { id: SurfaceStyle; label: string }[] = [
  { id: 'flat', label: '플랫' },
  { id: 'glass', label: 'Glass' }
]

export function WindowAppearanceSettings() {
  const surface = useThemeStore(state => state.surface)
  const windowOpacity = useThemeStore(state => state.windowOpacity)
  const setSurface = useThemeStore(state => state.setSurface)
  const setWindowOpacity = useThemeStore(state => state.setWindowOpacity)
  const [backdrop, setBackdrop] = useState<{ active: boolean; supported: boolean } | null>(null)

  useEffect(() => {
    let isCurrent = true
    const getBackdrop = window.electronAPI?.getBackdrop
    if (typeof getBackdrop !== 'function') return
    getBackdrop().then(state => { if (isCurrent) setBackdrop(state) }).catch(() => undefined)
    return () => { isCurrent = false }
  }, [surface])

  const backdropNote = surface !== 'glass' || !backdrop
    ? null
    : backdrop.active
      ? '창 뒤의 바탕 화면이 흐리게 비칩니다.'
      : backdrop.supported
        ? '앱을 다시 시작하면 창 뒤의 바탕 화면이 비칩니다. 그 전까지는 색 번짐 배경으로 보입니다.'
        : '이 시스템에서는 창 뒤를 비출 수 없어 색 번짐 배경을 씁니다 (Windows 11 22H2 이상에서 지원).'
  const opacityPercent = Math.round(windowOpacity * 100)

  return (
    <div className="appearance-options">
      <div className="appearance-row">
        <div className="appearance-label">
          <span>표면 스타일</span>
          <span className="appearance-hint">Glass 는 패널과 떠 있는 창을 반투명한 유리처럼 그립니다. 모든 테마에 켤 수 있습니다.</span>
          {backdropNote && <span className="appearance-hint appearance-note">{backdropNote}</span>}
        </div>
        <div className="theme-filter-tabs appearance-segment" role="radiogroup" aria-label="표면 스타일">
          {SURFACES.map(item => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={surface === item.id}
              className={`theme-filter-tab ${surface === item.id ? 'active' : ''}`}
              onClick={() => setSurface(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="appearance-row">
        <div className="appearance-label">
          <span>창 투명도</span>
          <span className="appearance-hint">창 전체가 비쳐서 뒤의 바탕 화면이 보입니다. 글자도 함께 옅어집니다.</span>
        </div>
        <div className="appearance-slider">
          <input
            type="range"
            min={MIN_WINDOW_OPACITY * 100}
            max={100}
            step={5}
            value={opacityPercent}
            onChange={event => setWindowOpacity(event.currentTarget.valueAsNumber / 100)}
            aria-label="창 투명도"
          />
          <span className="appearance-value">{opacityPercent}%</span>
        </div>
      </div>
      <AgentWorkStyleSetting />
    </div>
  )
}
