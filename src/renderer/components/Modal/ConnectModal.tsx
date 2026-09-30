import { useState, useEffect, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { RiCloseFill, RiServerFill, RiKeyFill, RiEyeFill, RiEyeOffFill, RiDatabase2Fill, RiCloudFill, RiGlobalFill, RiHomeFill, RiComputerFill, RiHardDriveFill, RiCpuFill, RiBaseStationFill, RiArrowDownSFill, RiArrowRightSFill, RiSettings3Fill } from 'react-icons/ri'
import { useSessionStore } from '../../stores/sessionStore'
import { useRipple } from '../Animation'
import { SESSION_COLORS } from '../../lib/sessionColors'
import { useConnectionTest, ConnectionTestStatus } from './ConnectionTest'

interface ConnectModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnect: (config: ConnectionConfig) => void
  /** Edit mode "저장": persist changes without connecting */
  onSave?: (config: ConnectionConfig) => void
  editSession?: ConnectionConfig | null
  /** Prefill a new connection from an existing session (duplicate). Saved as a new session. */
  duplicateFrom?: ConnectionConfig | null
  defaultFolderId?: string
}

export type SessionIcon = 'server' | 'database' | 'cloud' | 'globe' | 'home' | 'monitor' | 'hard-drive' | 'cpu' | 'radio'

export const SESSION_ICONS: { id: SessionIcon; icon: typeof RiServerFill }[] = [
  { id: 'server', icon: RiServerFill },
  { id: 'database', icon: RiDatabase2Fill },
  { id: 'cloud', icon: RiCloudFill },
  { id: 'globe', icon: RiGlobalFill },
  { id: 'home', icon: RiHomeFill },
  { id: 'monitor', icon: RiComputerFill },
  { id: 'hard-drive', icon: RiHardDriveFill },
  { id: 'cpu', icon: RiCpuFill },
  { id: 'radio', icon: RiBaseStationFill },
]

export interface ConnectionConfig {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  saveSession: boolean
  folderId?: string
  icon?: SessionIcon
  backgroundColor?: string
  // Connection settings
  connectTimeout?: number      // in seconds
  keepaliveInterval?: number   // in seconds
  autoReconnect?: boolean
  postConnectScript?: string
  // Jump Host
  useJumpHost?: boolean
  jumpHost?: string
  jumpPort?: number
  jumpUsername?: string
  jumpAuthType?: 'password' | 'privateKey'
  jumpPassword?: string
  jumpPrivateKeyPath?: string
  jumpPassphrase?: string
}

// Default config for new connections (outside component to maintain stable reference)
const DEFAULT_CONFIG: ConnectionConfig = {
  name: '',
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  saveSession: true,
  folderId: '',
  icon: 'server',
  connectTimeout: 20,
  keepaliveInterval: 30,
  autoReconnect: true,
  postConnectScript: '',
  useJumpHost: false,
  jumpHost: '',
  jumpPort: 22,
  jumpUsername: '',
  jumpAuthType: 'password',
  jumpPassword: '',
  jumpPrivateKeyPath: '',
  jumpPassphrase: ''
}

export function ConnectModal({ open, onOpenChange, onConnect, onSave, editSession, duplicateFrom, defaultFolderId }: ConnectModalProps) {
  const isEditMode = Boolean(editSession)
  const isDuplicateMode = !isEditMode && Boolean(duplicateFrom)
  const { folders } = useSessionStore()
  const [showPassword, setShowPassword] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const { createRipple, RippleContainer } = useRipple('rgba(255, 255, 255, 0.2)')

  const [config, setConfig] = useState<ConnectionConfig>(editSession || DEFAULT_CONFIG)
  const formRef = useRef<HTMLFormElement>(null)
  const connectionTest = useConnectionTest()
  const { reset: resetConnectionTest } = connectionTest

  // Any edit (or reopening the modal) invalidates the previous test result
  useEffect(() => {
    resetConnectionTest()
  }, [config, resetConnectionTest])

  // Reset form when modal opens/closes or editSession changes
  useEffect(() => {
    if (open) {
      // When opening, use editSession or reset to defaults with optional folder
      if (editSession) {
        setConfig({ ...editSession })
      } else if (duplicateFrom) {
        setConfig({ ...duplicateFrom })
      } else {
        setConfig({ ...DEFAULT_CONFIG, folderId: defaultFolderId || '' })
      }
      setShowPassword(false)
      setShowAdvanced(false)
    }
  }, [open, editSession, duplicateFrom, defaultFolderId])

  // Also handle the onOpenChange to wrap with reset logic
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset when closing
      setConfig({ ...DEFAULT_CONFIG })
    }
    onOpenChange(newOpen)
  }

  // Editing an existing session always saves it; the checkbox only applies to new connections
  const effectiveConfig = (): ConnectionConfig => (isEditMode ? { ...config, saveSession: true } : config)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Close modal immediately and start connection in background
    onOpenChange(false)
    // Start connection (don't await - it runs in background with toast notifications)
    onConnect(effectiveConfig())
  }

  // "저장" always registers/updates the session, regardless of the checkbox
  const handleSaveOnly = () => {
    onOpenChange(false)
    onSave?.({ ...config, saveSession: true })
  }

  const handleTestConnection = () => {
    // Show the browser's own "required" hints (host, username, jump host) before testing
    if (!formRef.current?.reportValidity()) return
    connectionTest.run(config)
  }

  const handleSelectPrivateKey = async () => {
    const result = await window.electronAPI.selectPrivateKey()
    if (result && result.success && result.path) {
      setConfig({ ...config, privateKeyPath: result.path })
    }
  }

  const updateConfig = (field: keyof ConnectionConfig, value: any) => {
    setConfig({ ...config, [field]: value })
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
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
                className="modal-content"
                variants={modalContentVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <Dialog.Title className="modal-title">
                  <RiServerFill size={20} />
                  {isEditMode ? '연결 편집' : isDuplicateMode ? '세션 복제' : '새 연결'}
                </Dialog.Title>

          <form ref={formRef} onSubmit={handleSubmit}>
            <div className="form-group">
              <label>연결 이름</label>
              <input
                type="text"
                value={config.name}
                onChange={(e) => updateConfig('name', e.target.value)}
                placeholder="My Server"
              />
            </div>

            <div className="form-group">
              <label>아이콘</label>
              <div className="icon-selector">
                {SESSION_ICONS.map(({ id, icon: IconComponent }) => (
                  <button
                    key={id}
                    type="button"
                    className={`icon-option ${config.icon === id ? 'selected' : ''}`}
                    onClick={() => updateConfig('icon', id)}
                    title={id}
                  >
                    <IconComponent size={20} />
                  </button>
                ))}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group flex-1">
                <label>호스트</label>
                <input
                  type="text"
                  value={config.host}
                  onChange={(e) => updateConfig('host', e.target.value)}
                  placeholder="192.168.1.1"
                  required
                />
              </div>
              <div className="form-group" style={{ width: '100px' }}>
                <label>포트</label>
                <input
                  type="number"
                  value={config.port}
                  onChange={(e) => updateConfig('port', parseInt(e.target.value))}
                  min={1}
                  max={65535}
                />
              </div>
            </div>

            <div className="form-group">
              <label>사용자명</label>
              <input
                type="text"
                value={config.username}
                onChange={(e) => updateConfig('username', e.target.value)}
                placeholder="root"
                required
              />
            </div>

            <div className="form-group">
              <label>인증 방식</label>
              <div className="auth-type-buttons">
                <button
                  type="button"
                  className={`auth-type-btn ${config.authType === 'password' ? 'active' : ''}`}
                  onClick={() => updateConfig('authType', 'password')}
                >
                  비밀번호
                </button>
                <button
                  type="button"
                  className={`auth-type-btn ${config.authType === 'privateKey' ? 'active' : ''}`}
                  onClick={() => updateConfig('authType', 'privateKey')}
                >
                  <RiKeyFill size={16} />
                  Private Key
                </button>
              </div>
            </div>

            {config.authType === 'password' ? (
              <div className="form-group">
                <label>비밀번호</label>
                <div className="password-input-wrapper">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={config.password}
                    onChange={(e) => updateConfig('password', e.target.value)}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <RiEyeOffFill size={18} /> : <RiEyeFill size={18} />}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label>Private Key 경로</label>
                  <div className="file-input-wrapper">
                    <input
                      type="text"
                      value={config.privateKeyPath}
                      onChange={(e) => updateConfig('privateKeyPath', e.target.value)}
                      placeholder="~/.ssh/id_rsa"
                      readOnly
                    />
                    <button type="button" className="btn-browse" onClick={handleSelectPrivateKey}>
                      찾아보기
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label>Passphrase (선택)</label>
                  <input
                    type="password"
                    value={config.passphrase}
                    onChange={(e) => updateConfig('passphrase', e.target.value)}
                    placeholder="키 암호"
                  />
                </div>
              </>
            )}

            <div className="form-group">
              <label>폴더</label>
              <select
                value={config.folderId || ''}
                onChange={(e) => updateConfig('folderId', e.target.value || undefined)}
              >
                <option value="">폴더 없음</option>
                {folders.map(folder => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>배경색 (선택)</label>
              <div className="color-selector">
                <button
                  type="button"
                  className={`color-option none ${!config.backgroundColor ? 'selected' : ''}`}
                  onClick={() => updateConfig('backgroundColor', undefined)}
                  title="없음"
                >
                  ✕
                </button>
                {SESSION_COLORS.map((colorItem) => (
                  <button
                    key={colorItem.id}
                    type="button"
                    className={`color-option ${config.backgroundColor === colorItem.color ? 'selected' : ''}`}
                    style={{ backgroundColor: colorItem.color }}
                    onClick={() => updateConfig('backgroundColor', colorItem.color)}
                    title={colorItem.name}
                  />
                ))}
              </div>
            </div>

            <div className="advanced-settings-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? <RiArrowDownSFill size={16} /> : <RiArrowRightSFill size={16} />}
              <RiSettings3Fill size={16} />
              <span>고급 설정</span>
            </div>

            {showAdvanced && (
              <div className="advanced-settings">
                <div className="form-row">
                  <div className="form-group flex-1">
                    <label>연결 타임아웃 (초)</label>
                    <input
                      type="number"
                      value={config.connectTimeout}
                      onChange={(e) => updateConfig('connectTimeout', parseInt(e.target.value) || 20)}
                      min={5}
                      max={120}
                    />
                  </div>
                  <div className="form-group flex-1">
                    <label>Keep-Alive 간격 (초)</label>
                    <input
                      type="number"
                      value={config.keepaliveInterval}
                      onChange={(e) => updateConfig('keepaliveInterval', parseInt(e.target.value) || 30)}
                      min={10}
                      max={300}
                    />
                  </div>
                </div>
                <div className="form-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.autoReconnect}
                      onChange={(e) => updateConfig('autoReconnect', e.target.checked)}
                    />
                    <span>연결 끊김 시 자동 재연결</span>
                  </label>
                </div>
                <div className="form-group">
                  <label>연결 후 자동 실행 스크립트</label>
                  <textarea
                    value={config.postConnectScript || ''}
                    onChange={(e) => updateConfig('postConnectScript', e.target.value)}
                    placeholder={'# 연결 후 자동으로 실행할 명령어\ncd /var/www\nls -la'}
                    className="post-connect-script"
                    rows={4}
                  />
                  <span className="form-hint">줄바꿈으로 구분된 명령어가 순차 실행됩니다</span>
                </div>

                {/* Jump Host (ProxyJump) 설정 */}
                <div className="form-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.useJumpHost || false}
                      onChange={(e) => updateConfig('useJumpHost', e.target.checked)}
                    />
                    <span>Jump Host (ProxyJump) 사용</span>
                  </label>
                </div>

                {config.useJumpHost && (
                  <div className="jump-host-settings">
                    <div className="form-row">
                      <div className="form-group flex-1">
                        <label>Jump 호스트</label>
                        <input
                          type="text"
                          value={config.jumpHost || ''}
                          onChange={(e) => updateConfig('jumpHost', e.target.value)}
                          placeholder="bastion.example.com"
                          required
                        />
                      </div>
                      <div className="form-group" style={{ width: '100px' }}>
                        <label>포트</label>
                        <input
                          type="number"
                          value={config.jumpPort || 22}
                          onChange={(e) => updateConfig('jumpPort', parseInt(e.target.value))}
                          min={1}
                          max={65535}
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Jump 사용자명</label>
                      <input
                        type="text"
                        value={config.jumpUsername || ''}
                        onChange={(e) => updateConfig('jumpUsername', e.target.value)}
                        placeholder="admin"
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Jump 인증 방식</label>
                      <div className="auth-type-buttons">
                        <button
                          type="button"
                          className={`auth-type-btn ${(config.jumpAuthType || 'password') === 'password' ? 'active' : ''}`}
                          onClick={() => updateConfig('jumpAuthType', 'password')}
                        >
                          비밀번호
                        </button>
                        <button
                          type="button"
                          className={`auth-type-btn ${config.jumpAuthType === 'privateKey' ? 'active' : ''}`}
                          onClick={() => updateConfig('jumpAuthType', 'privateKey')}
                        >
                          Private Key
                        </button>
                      </div>
                    </div>
                    {(config.jumpAuthType || 'password') === 'password' ? (
                      <div className="form-group">
                        <label>Jump 비밀번호</label>
                        <input
                          type="password"
                          value={config.jumpPassword || ''}
                          onChange={(e) => updateConfig('jumpPassword', e.target.value)}
                          placeholder="••••••••"
                        />
                      </div>
                    ) : (
                      <>
                        <div className="form-group">
                          <label>Jump Private Key 경로</label>
                          <div className="file-input-wrapper">
                            <input
                              type="text"
                              value={config.jumpPrivateKeyPath || ''}
                              onChange={(e) => updateConfig('jumpPrivateKeyPath', e.target.value)}
                              placeholder="~/.ssh/id_rsa"
                              readOnly
                            />
                            <button type="button" className="btn-browse" onClick={async () => {
                              const result = await window.electronAPI.selectPrivateKey()
                              if (result?.success && result?.path) {
                                updateConfig('jumpPrivateKeyPath', result.path)
                              }
                            }}>
                              찾아보기
                            </button>
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Jump Passphrase (선택)</label>
                          <input
                            type="password"
                            value={config.jumpPassphrase || ''}
                            onChange={(e) => updateConfig('jumpPassphrase', e.target.value)}
                            placeholder="키 암호"
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {!isEditMode && (
              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={config.saveSession}
                    onChange={(e) => updateConfig('saveSession', e.target.checked)}
                  />
                  <span>이 연결 정보 저장</span>
                </label>
              </div>
            )}

            <ConnectionTestStatus state={connectionTest.state} />

            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary modal-btn connection-test-btn"
                onClick={handleTestConnection}
                disabled={connectionTest.state.status === 'testing'}
                title="입력한 정보로 로그인만 시도하고 바로 연결을 끊습니다"
              >
                {connectionTest.state.status === 'testing' ? '테스트 중...' : '연결 테스트'}
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="btn-secondary modal-btn"
                  style={{ position: 'relative', overflow: 'hidden' }}
                  onClick={createRipple}
                >
                  취소
                  <RippleContainer />
                </button>
              </Dialog.Close>
              {(isEditMode || isDuplicateMode) && onSave && (
                <button
                  type="button"
                  className="btn-secondary modal-btn"
                  style={{ position: 'relative', overflow: 'hidden' }}
                  onClick={(e) => {
                    createRipple(e)
                    handleSaveOnly()
                  }}
                >
                  저장
                  <RippleContainer />
                </button>
              )}
              <button
                type="submit"
                className="btn-primary modal-btn"
                style={{ position: 'relative', overflow: 'hidden' }}
                onClick={createRipple}
              >
                {isEditMode ? '저장 후 연결' : '연결'}
                <RippleContainer />
              </button>
            </div>
          </form>

                <Dialog.Close asChild>
                  <button className="modal-close-btn" aria-label="Close">
                    <RiCloseFill size={20} />
                  </button>
                </Dialog.Close>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
