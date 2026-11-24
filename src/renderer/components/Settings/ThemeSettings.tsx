import * as Tabs from '@radix-ui/react-tabs'
import { RiCursorLine, RiLayoutTopLine, RiMagicLine, RiMailLine, RiPaletteFill, RiSparklingLine } from 'react-icons/ri'
import { AgentChatThemePicker } from '../AgentChat/AgentChatThemePicker'
import { BrowserTabWidthControl } from './BrowserTabWidthControl'
import { PointerShapeSettings, PointerEffectSettings } from './PointerSettings'
import { ThemeSelector } from './ThemeSelector'
import { WindowAppearanceSettings } from './WindowAppearanceSettings'

const themeTabs = [
  { value: 'app', label: '앱 테마', icon: RiPaletteFill },
  { value: 'chat', label: '채팅 테마', icon: RiMailLine },
  { value: 'window', label: '창 효과', icon: RiMagicLine },
  { value: 'pointer-shape', label: '포인터 모양', icon: RiCursorLine },
  { value: 'pointer-effects', label: '포인터 효과', icon: RiSparklingLine },
  { value: 'browser', label: '브라우저 탭', icon: RiLayoutTopLine }
]

export function ThemeSettings({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
  return (
    <Tabs.Root value={value} onValueChange={onValueChange} className="settings-theme-tabs">
      <Tabs.List className="settings-theme-tabs-list" aria-label="테마 설정">
        {themeTabs.map(({ value, label, icon: Icon }) => (
          <Tabs.Trigger key={value} value={value} className="settings-tab-trigger">
            <Icon size={16} aria-hidden />
            {label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      <Tabs.Content value="app" className="settings-tab-content settings-theme-panel">
        <div className="settings-section">
          <p className="settings-section-desc">앱의 색상 테마를 선택하세요. 터미널 색상도 함께 변경됩니다.</p>
          <ThemeSelector />
        </div>
      </Tabs.Content>

      <Tabs.Content value="chat" className="settings-tab-content settings-theme-panel">
        <div className="settings-section">
          <p className="settings-section-desc">채팅의 색상을 따로 고르거나 앱 테마에 맞춰 바꿀 수 있습니다.</p>
          <AgentChatThemePicker />
        </div>
      </Tabs.Content>

      <Tabs.Content value="window" className="settings-tab-content settings-theme-panel">
        <WindowAppearanceSettings />
      </Tabs.Content>

      <Tabs.Content value="pointer-shape" className="settings-tab-content settings-theme-panel">
        <PointerShapeSettings />
      </Tabs.Content>

      <Tabs.Content value="pointer-effects" className="settings-tab-content settings-theme-panel">
        <PointerEffectSettings />
      </Tabs.Content>

      <Tabs.Content value="browser" className="settings-tab-content settings-theme-panel">
        <BrowserTabWidthControl />
      </Tabs.Content>
    </Tabs.Root>
  )
}
