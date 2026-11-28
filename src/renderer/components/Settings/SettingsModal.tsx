import { useEffect, useState } from 'react'
import { OPEN_SETTINGS_EVENT, type OpenSettings } from '../../lib/settingsNavigation'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { motion, AnimatePresence } from 'framer-motion'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { RiCloseFill, RiSettings3Fill, RiPaletteFill, RiKeyboardLine, RiDatabaseLine, RiTerminalBoxLine, RiPlugLine, RiSmartphoneLine, RiMailLine, RiCodeSSlashLine, RiUserSettingsLine, RiStethoscopeLine } from 'react-icons/ri'
import type { IconType } from 'react-icons'
import { ThemeSettings } from './ThemeSettings'
import { ShortcutsPanel } from './ShortcutsPanel'
import { SessionBackup } from './SessionBackup'
import { FontSizeControl } from './FontSizeControl'
import { TerminalScrollbackControl } from './TerminalScrollbackControl'
import { McpSettings } from '../Mcp/McpSettings'
import { AgentMessageMcpSetup } from '../Mcp/AgentMessageMcpSetup'
import { AgentIdleSettings } from './AgentIdleSettings'
import { AgentHooksSettings } from './AgentHooksSettings'
import { JdkSettings } from './JdkSettings'
import { RunSummarySettings } from './RunSummarySettings'
import { NestedRepositorySettings } from '../Sidebar/NestedRepositories'
import { ClaudeProfilesSettings } from './ClaudeProfilesSettings'
import { RemoteAccessSettings } from '../RemoteAccess/RemoteAccessSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import { hasDiagnostics } from '../../lib/diagnostics'
import '../../styles/settings.css'

// The categories, in the left column and in the narrow dialog's list (2026-11-27 user request: eight in a
// row wrapped and long names were hard to read)
const SETTINGS_CATEGORIES: ReadonlyArray<{ value: string; label: string; Icon: IconType }> = [
  { value: 'theme', label: '테마', Icon: RiPaletteFill },
  { value: 'terminal', label: '터미널', Icon: RiTerminalBoxLine },
  { value: 'shortcuts', label: '키보드 단축키', Icon: RiKeyboardLine },
  { value: 'backup', label: '백업', Icon: RiDatabaseLine },
  { value: 'mcp', label: 'MCP', Icon: RiPlugLine },
  { value: 'remote', label: '원격 접속', Icon: RiSmartphoneLine },
  { value: 'development', label: '개발 도구', Icon: RiCodeSSlashLine },
  { value: 'claude-accounts', label: 'Claude 계정', Icon: RiUserSettingsLine },
  // Bug reports (docs/plan/2026-11-28-diagnostics.md); shown once main offers it
  { value: 'diagnostics', label: '진단 정보', Icon: RiStethoscopeLine }
]

const shownCategories = () => SETTINGS_CATEGORIES.filter(category => category.value !== 'diagnostics' || hasDiagnostics())

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState('theme')
  const [activeThemeTab, setActiveThemeTab] = useState('app')
  const [activeMcpTab, setActiveMcpTab] = useState('ssh')
  // openSettingsTab (lib/settingsNavigation.ts): App opens the window, the tab is picked here
  useEffect(() => {
    const onOpen = (event: Event) => setActiveTab((event as CustomEvent<OpenSettings>).detail.tab)
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen)
  }, [])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="modal-overlay"
                variants={modalOverlayVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              />
            </Dialog.Overlay>
            <Dialog.Content asChild>
              <motion.div
                className="modal-content settings-modal"
                variants={modalContentVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <div className="settings-modal-header">
                  <Dialog.Title className="modal-title">
                    <RiSettings3Fill size={20} />
                    설정
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button className="modal-close-btn" aria-label="Close">
                      <RiCloseFill size={20} />
                    </button>
                  </Dialog.Close>
                </div>

                <Tabs.Root value={activeTab} onValueChange={setActiveTab} orientation="vertical" className="settings-tabs">
                  {/* Wide: the categories in a column on the left, only the content scrolls. Narrow (the
                      dialog under 720px): the column hides and this list picks the category instead */}
                  <label className="settings-category-picker">
                    <span>설정 항목</span>
                    <select value={activeTab} onChange={event => setActiveTab(event.target.value)}>
                      {shownCategories().map(category => <option key={category.value} value={category.value}>{category.label}</option>)}
                    </select>
                  </label>
                  <Tabs.List className="settings-tabs-list" aria-label="설정">
                    {shownCategories().map(({ value, label, Icon }) => (
                      <Tabs.Trigger key={value} value={value} className="settings-tab-trigger">
                        <Icon size={18} aria-hidden="true" />
                        {label}
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>

                  <Tabs.Content value="theme" className="settings-tab-content settings-theme-content">
                    <ThemeSettings value={activeThemeTab} onValueChange={setActiveThemeTab} />
                  </Tabs.Content>

                  <Tabs.Content value="terminal" className="settings-tab-content">
                    <div className="settings-content">
                      <section className="settings-section">
                        <h3 className="settings-section-title">
                          <RiTerminalBoxLine size={18} />
                          글꼴 크기
                        </h3>
                        <p className="settings-section-desc">
                          터미널의 글꼴 크기를 조정하세요. 모든 터미널에 즉시 적용됩니다.
                        </p>
                        <FontSizeControl />
                      </section>
                      <TerminalScrollbackControl />
                    </div>
                  </Tabs.Content>

                  <Tabs.Content value="shortcuts" className="settings-tab-content">
                    <div className="settings-content">
                      <section className="settings-section">
                        <h3 className="settings-section-title">
                          <RiKeyboardLine size={18} />
                          키보드 단축키
                        </h3>
                        <p className="settings-section-desc">
                          앱 전체에서 쓰는 키보드 단축키를 확인하고 원하는 키로 바꿀 수 있습니다.
                        </p>
                        <ShortcutsPanel />
                      </section>
                    </div>
                  </Tabs.Content>

                  <Tabs.Content value="backup" className="settings-tab-content">
                    <div className="settings-content">
                      <section className="settings-section">
                        <h3 className="settings-section-title">
                          <RiDatabaseLine size={18} />
                          세션 백업
                        </h3>
                        <p className="settings-section-desc">
                          세션을 파일로 내보내거나 가져와서 백업하세요.
                        </p>
                        <SessionBackup />
                      </section>
                    </div>
                  </Tabs.Content>

                  <Tabs.Content value="mcp" className="settings-tab-content settings-mcp-content">
                    <Tabs.Root value={activeMcpTab} onValueChange={setActiveMcpTab} className="settings-mcp-tabs">
                      <Tabs.List className="settings-mcp-tabs-list" aria-label="MCP 설정">
                        <Tabs.Trigger value="ssh" className="settings-tab-trigger">
                          <RiPlugLine size={16} />
                          SSH MCP
                        </Tabs.Trigger>
                        <Tabs.Trigger value="agent-messages" className="settings-tab-trigger">
                          <RiMailLine size={16} />
                          에이전트 메시지
                        </Tabs.Trigger>
                      </Tabs.List>

                      <Tabs.Content value="ssh" className="settings-tab-content">
                        <div className="settings-content">
                          <McpSettings />
                        </div>
                      </Tabs.Content>

                      <Tabs.Content value="agent-messages" className="settings-tab-content">
                        <div className="settings-content">
                          <section className="settings-section mcp-settings-group">
                            <h3 className="settings-section-title">에이전트 메시지 MCP · ezshell-cli-mcp</h3>
                            <p className="settings-section-desc">
                              사용자 설정에 등록하면 일반 터미널에서 연 Codex와 Claude Code도 실행 중인 ezShell과 메시지를 주고받을 수 있습니다.
                            </p>
                            <p className="settings-section-desc">
                              새 로컬 PowerShell에서 Codex를 실행하면 <code>--no-daemon</code>을 자동으로 붙여 메시지를 해당 터미널 칸에 연결합니다.
                            </p>
                            <AgentMessageMcpSetup />
                          </section>
                          <AgentHooksSettings />
                          <AgentIdleSettings />
                        </div>
                      </Tabs.Content>
                    </Tabs.Root>
                  </Tabs.Content>

                  <Tabs.Content value="remote" className="settings-tab-content">
                    <div className="settings-content">
                      <RemoteAccessSettings />
                    </div>
                  </Tabs.Content>
                  <Tabs.Content value="development" className="settings-tab-content">
                    <div className="settings-content"><RunSummarySettings /><NestedRepositorySettings /><JdkSettings /></div>
                  </Tabs.Content>
                  <Tabs.Content value="claude-accounts" className="settings-tab-content">
                    <div className="settings-content"><ClaudeProfilesSettings onOpen={() => onOpenChange(false)} /></div>
                  </Tabs.Content>
                  {hasDiagnostics() && (
                    <Tabs.Content value="diagnostics" className="settings-tab-content">
                      <div className="settings-content"><DiagnosticsSettings /></div>
                    </Tabs.Content>
                  )}
                </Tabs.Root>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
