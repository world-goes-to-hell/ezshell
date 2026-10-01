import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { motion, AnimatePresence } from 'framer-motion'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { RiCloseFill, RiSettings3Fill, RiPaletteFill, RiKeyboardLine, RiDatabaseLine, RiTerminalBoxLine, RiPlugLine } from 'react-icons/ri'
import { ThemeSelector } from './ThemeSelector'
import { ShortcutsPanel } from './ShortcutsPanel'
import { SessionBackup } from './SessionBackup'
import { FontSizeControl } from './FontSizeControl'
import { McpSettings } from '../Mcp/McpSettings'
import '../../styles/settings.css'

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState('theme')

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
                  <Tabs.List className="settings-tabs-list">
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
                  </Tabs.List>

                  <Tabs.Content value="theme" className="settings-tab-content">
                    <div className="settings-content">
                      <section className="settings-section">
                        <h3 className="settings-section-title">
                          <RiPaletteFill size={18} />
                          테마
                        </h3>
                        <p className="settings-section-desc">
                          앱의 색상 테마를 선택하세요. 터미널 색상도 함께 변경됩니다.
                        </p>
                        <ThemeSelector />
                      </section>
                    </div>
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
                          앱 전체에서 사용할 수 있는 키보드 단축키를 확인하세요.
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

                  <Tabs.Content value="mcp" className="settings-tab-content">
                    <div className="settings-content">
                      <section className="settings-section">
                        <h3 className="settings-section-title">
                          <RiPlugLine size={18} />
                          MCP 서버 (Claude Code)
                        </h3>
                        <p className="settings-section-desc">
                          Claude Code 가 허용한 세션으로 서버를 조회할 수 있게 합니다. 비밀번호는 Claude 에게 전달되지 않습니다.
                        </p>
                        <McpSettings />
                      </section>
                    </div>
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
