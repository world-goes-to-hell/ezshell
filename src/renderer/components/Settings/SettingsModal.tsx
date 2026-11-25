import { useEffect, useState } from 'react'
import { OPEN_SETTINGS_EVENT, type OpenSettings } from '../../lib/settingsNavigation'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { motion, AnimatePresence } from 'framer-motion'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { RiCloseFill, RiSettings3Fill, RiPaletteFill, RiKeyboardLine, RiDatabaseLine, RiTerminalBoxLine, RiPlugLine, RiSmartphoneLine, RiMailLine } from 'react-icons/ri'
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
import { RemoteAccessSettings } from '../RemoteAccess/RemoteAccessSettings'
import '../../styles/settings.css'

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

                <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="settings-tabs">
                  <Tabs.List className="settings-tabs-list" aria-label="설정">
                    <Tabs.Trigger value="theme" className="settings-tab-trigger">
                      <RiPaletteFill size={18} />
                      테마
                    </Tabs.Trigger>
                    <Tabs.Trigger value="terminal" className="settings-tab-trigger">
                      <RiTerminalBoxLine size={18} />
                      터미널
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts" className="settings-tab-trigger">
                      <RiKeyboardLine size={18} />
                      키보드 단축키
                    </Tabs.Trigger>
                    <Tabs.Trigger value="backup" className="settings-tab-trigger">
                      <RiDatabaseLine size={18} />
                      백업
                    </Tabs.Trigger>
                    <Tabs.Trigger value="mcp" className="settings-tab-trigger">
                      <RiPlugLine size={18} />
                      MCP
                    </Tabs.Trigger>
                    <Tabs.Trigger value="remote" className="settings-tab-trigger">
                      <RiSmartphoneLine size={18} />
                      원격 접속
                    </Tabs.Trigger>
                    <Tabs.Trigger value="development" className="settings-tab-trigger">개발 도구</Tabs.Trigger>
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
                    <div className="settings-content"><JdkSettings /></div>
                  </Tabs.Content>
                </Tabs.Root>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
