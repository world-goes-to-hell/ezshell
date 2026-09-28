import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { RiCloseFill, RiFlashlightFill, RiKeyFill, RiEyeFill, RiEyeOffFill } from 'react-icons/ri'
import { LoadingButton, useRipple } from '../Animation'
import './QuickConnectModal.css'

interface QuickConnectModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnect: (config: QuickConnectionConfig, saveSession: boolean) => void
}

export interface QuickConnectionConfig {
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export function QuickConnectModal({ open, onOpenChange, onConnect }: QuickConnectModalProps) {
  const [showPassword, setShowPassword] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const { createRipple, RippleContainer } = useRipple('rgba(255, 255, 255, 0.2)')
  const [config, setConfig] = useState<QuickConnectionConfig>({
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: ''
  })

  const handleConnect = async (saveSession: boolean) => {
    setIsConnecting(true)
    try {
      await onConnect(config, saveSession)
      onOpenChange(false)
      // Reset form
      setConfig({
        host: '',
        port: 22,
        username: '',
        authType: 'password',
        password: '',
        privateKeyPath: '',
        passphrase: ''
      })
    } finally {
      setIsConnecting(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleConnect(false)
  }

  const handleConnectAndSave = () => {
    handleConnect(true)
  }

  const handleSelectPrivateKey = async () => {
    const result = await window.electronAPI.selectPrivateKey()
    if (result && result.success && result.path) {
      setConfig({ ...config, privateKeyPath: result.path })
    }
  }

  const updateConfig = (field: keyof QuickConnectionConfig, value: any) => {
    setConfig({ ...config, [field]: value })
  }

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
                className="modal-content quick-connect-modal"
                variants={modalContentVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <Dialog.Title className="modal-title">
                  <RiFlashlightFill size={20} />
                  빠른 연결
                </Dialog.Title>

                <form onSubmit={handleSubmit}>
                  <div className="form-row">
                    <div className="form-group flex-1">
                      <label>호스트</label>
                      <input
                        type="text"
                        value={config.host}
                        onChange={(e) => updateConfig('host', e.target.value)}
                        placeholder="192.168.1.1"
                        required
                        autoFocus
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

                  <div className="quick-connect-info">
                    연결 정보는 저장되지 않습니다. 저장하려면 "연결 및 저장"을 클릭하세요.
                  </div>

                  <div className="modal-actions">
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ position: 'relative', overflow: 'hidden' }}
                        onClick={createRipple}
                        disabled={isConnecting}
                      >
                        취소
                        <RippleContainer />
                      </button>
                    </Dialog.Close>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleConnectAndSave}
                      disabled={isConnecting}
                    >
                      연결 및 저장
                    </button>
                    <LoadingButton
                      type="submit"
                      className="btn-primary"
                      isLoading={isConnecting}
                      loadingText="연결 중..."
                      rippleColor="rgba(255, 255, 255, 0.3)"
                    >
                      연결
                    </LoadingButton>
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
