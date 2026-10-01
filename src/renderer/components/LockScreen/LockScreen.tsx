import { useState, useEffect, useRef } from 'react'
import { RiShieldKeyholeFill, RiEyeFill, RiEyeOffFill, RiErrorWarningFill, RiCheckboxCircleFill, RiLock2Fill, RiShutDownLine } from 'react-icons/ri'
import { motion, AnimatePresence } from 'framer-motion'

interface LockScreenProps {
  hasMasterPassword: boolean
  onUnlock: () => void
}

// Animated terminal text lines for background ambiance
const TERMINAL_LINES = [
  '$ ssh-keygen -t ed25519 -C "user@host"',
  'Generating public/private ed25519 key pair.',
  'Enter passphrase (empty for no passphrase):',
  '$ ssh admin@192.168.1.100 -p 22',
  'The authenticity of host cannot be established.',
  'ECDSA key fingerprint is SHA256:xK3a...',
  '$ scp ./config.yaml prod:/etc/app/',
  'config.yaml                 100%  2.4KB',
  '$ rsync -avz --progress ./dist/ server:~/app/',
  'sending incremental file list',
  '$ chmod 600 ~/.ssh/id_ed25519',
  '$ cat ~/.ssh/authorized_keys',
  '$ systemctl status sshd',
  'Active: active (running) since Mon',
]

function TerminalBackground() {
  const [visibleLines, setVisibleLines] = useState<number>(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setVisibleLines(prev => {
        if (prev >= TERMINAL_LINES.length) {
          return prev
        }
        return prev + 1
      })
    }, 400)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  return (
    <div className="lock-terminal-bg" aria-hidden="true">
      <div className="lock-terminal-lines">
        {TERMINAL_LINES.slice(0, visibleLines).map((line, i) => (
          <motion.div
            key={i}
            className={`lock-terminal-line ${line.startsWith('$') ? 'command' : 'output'}`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
          >
            {line}
          </motion.div>
        ))}
        {visibleLines < TERMINAL_LINES.length && (
          <span className="lock-terminal-cursor" />
        )}
      </div>
    </div>
  )
}

export function LockScreen({ hasMasterPassword, onUnlock }: LockScreenProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [rememberPassword, setRememberPassword] = useState(false)
  const [hasAutoUnlock, setHasAutoUnlock] = useState(false)
  const [autoUnlocking, setAutoUnlocking] = useState(false)
  const [success, setSuccess] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Safe API helpers (graceful degradation if APIs not yet loaded)
  const apiHasAutoUnlock = async () => {
    try {
      if (typeof window.electronAPI?.hasAutoUnlock === 'function') {
        return await window.electronAPI.hasAutoUnlock()
      }
    } catch { /* ignore */ }
    return false
  }
  const apiLoadAutoUnlock = async () => {
    try {
      if (typeof window.electronAPI?.loadAutoUnlock === 'function') {
        return await window.electronAPI.loadAutoUnlock()
      }
    } catch { /* ignore */ }
    return { success: false }
  }
  const apiSaveAutoUnlock = async (pwd: string) => {
    try {
      if (typeof window.electronAPI?.saveAutoUnlock === 'function') {
        await window.electronAPI.saveAutoUnlock(pwd)
      }
    } catch { /* ignore */ }
  }
  const apiClearAutoUnlock = async () => {
    try {
      if (typeof window.electronAPI?.clearAutoUnlock === 'function') {
        await window.electronAPI.clearAutoUnlock()
      }
    } catch { /* ignore */ }
  }

  // Check for saved auto-unlock token on mount
  useEffect(() => {
    const tryAutoUnlock = async () => {
      if (!hasMasterPassword) return

      try {
        const hasSaved = await apiHasAutoUnlock()
        setHasAutoUnlock(hasSaved)

        if (hasSaved) {
          setAutoUnlocking(true)
          const tokenResult = await apiLoadAutoUnlock()
          if (tokenResult.success && (tokenResult as any).password) {
            const result = await window.electronAPI.unlockApp((tokenResult as any).password)
            if (result.success) {
              setSuccess(true)
              setTimeout(() => onUnlock(), 600)
              return
            } else {
              await apiClearAutoUnlock()
              setHasAutoUnlock(false)
            }
          }
          setAutoUnlocking(false)
        }
      } catch (err) {
        setAutoUnlocking(false)
      }
    }

    tryAutoUnlock()
  }, [hasMasterPassword])

  // Focus input after auto-unlock check
  useEffect(() => {
    if (!autoUnlocking && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoUnlocking])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      if (hasMasterPassword) {
        const result = await window.electronAPI.unlockApp(password)
        if (result.success) {
          // Save or clear auto-unlock token
          if (rememberPassword) {
            await apiSaveAutoUnlock(password)
          } else if (hasAutoUnlock) {
            await apiClearAutoUnlock()
          }
          setSuccess(true)
          setTimeout(() => onUnlock(), 600)
        } else {
          setError(result.error || '비밀번호가 올바르지 않습니다.')
          setIsLoading(false)
        }
      } else {
        if (password.length < 8) {
          setError('비밀번호는 8자 이상이어야 합니다.')
          setIsLoading(false)
          return
        }
        if (password !== confirmPassword) {
          setError('비밀번호가 일치하지 않습니다.')
          setIsLoading(false)
          return
        }
        const result = await window.electronAPI.setupMasterPassword(password)
        if (result.success) {
          if (rememberPassword) {
            await apiSaveAutoUnlock(password)
          }
          setSuccess(true)
          setTimeout(() => onUnlock(), 600)
        } else {
          setError(result.error || '비밀번호 설정에 실패했습니다.')
          setIsLoading(false)
        }
      }
    } catch (err: any) {
      console.error('LockScreen error:', err)
      setError(err?.message || '오류가 발생했습니다.')
      setIsLoading(false)
    }
  }

  // Password strength indicator (only for setup)
  const getPasswordStrength = () => {
    if (password.length === 0) return { level: 0, label: '', color: '' }
    if (password.length < 8) return { level: 1, label: '짧음', color: 'var(--error)' }
    const hasUpper = /[A-Z]/.test(password)
    const hasLower = /[a-z]/.test(password)
    const hasNumber = /[0-9]/.test(password)
    const hasSpecial = /[^A-Za-z0-9]/.test(password)
    const score = [hasUpper, hasLower, hasNumber, hasSpecial].filter(Boolean).length
    if (password.length >= 12 && score >= 3) return { level: 4, label: '매우 강함', color: 'var(--success)' }
    if (password.length >= 10 && score >= 2) return { level: 3, label: '강함', color: 'var(--success)' }
    if (score >= 2) return { level: 2, label: '보통', color: 'var(--warning)' }
    return { level: 1, label: '약함', color: 'var(--error)' }
  }

  const strength = getPasswordStrength()

  // Auto-unlocking state
  if (autoUnlocking) {
    return (
      <div className="lock-screen">
        <TerminalBackground />
        <motion.div
          className="lock-screen-card"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="lock-auto-unlock">
            <motion.div
              className="lock-shield-icon"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              <RiShieldKeyholeFill size={40} />
            </motion.div>
            <span className="lock-auto-text">자동 잠금 해제 중...</span>
          </div>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="lock-screen">
      <TerminalBackground />

      <motion.div
        className={`lock-screen-card ${success ? 'success' : ''}`}
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={success
          ? { opacity: 0, y: -20, scale: 0.95 }
          : { opacity: 1, y: 0, scale: 1 }
        }
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Shield icon */}
        <motion.div
          className="lock-shield"
          initial={{ scale: 0, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ delay: 0.15, duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
        >
          <div className="lock-shield-glow" />
          <div className="lock-shield-icon">
            {hasMasterPassword ? <RiLock2Fill size={32} /> : <RiShieldKeyholeFill size={32} />}
          </div>
        </motion.div>

        {/* Title & description */}
        <motion.div
          className="lock-header"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.4 }}
        >
          <h1 className="lock-title">
            {hasMasterPassword ? '잠금 해제' : '마스터 비밀번호 설정'}
          </h1>
          <p className="lock-subtitle">
            {hasMasterPassword
              ? '세션 정보에 접근하려면 비밀번호를 입력하세요'
              : '세션 데이터를 암호화할 비밀번호를 설정하세요'}
          </p>
        </motion.div>

        {/* Form */}
        <motion.form
          onSubmit={handleSubmit}
          className="lock-form"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.4 }}
        >
          {/* Password input */}
          <div className="lock-input-group">
            <label className="lock-label">
              {hasMasterPassword ? '비밀번호' : '새 비밀번호 (8자 이상)'}
            </label>
            <div className="lock-input-wrapper">
              <input
                ref={inputRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasMasterPassword ? '••••••••' : '비밀번호 입력'}
                className="lock-input"
                autoFocus
                required
              />
              <button
                type="button"
                className="lock-eye-btn"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? <RiEyeOffFill size={18} /> : <RiEyeFill size={18} />}
              </button>
            </div>

            {/* Password strength (setup only) */}
            {!hasMasterPassword && password.length > 0 && (
              <motion.div
                className="lock-strength"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                transition={{ duration: 0.2 }}
              >
                <div className="lock-strength-bar">
                  {[1, 2, 3, 4].map(i => (
                    <div
                      key={i}
                      className={`lock-strength-segment ${i <= strength.level ? 'active' : ''}`}
                      style={i <= strength.level ? { backgroundColor: strength.color } : undefined}
                    />
                  ))}
                </div>
                <span className="lock-strength-label" style={{ color: strength.color }}>
                  {strength.label}
                </span>
              </motion.div>
            )}
          </div>

          {/* Confirm password (setup only) */}
          <AnimatePresence>
            {!hasMasterPassword && (
              <motion.div
                className="lock-input-group"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3 }}
              >
                <label className="lock-label">비밀번호 확인</label>
                <div className="lock-input-wrapper">
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="비밀번호 다시 입력"
                    className="lock-input"
                    required
                  />
                  {confirmPassword.length > 0 && password === confirmPassword && (
                    <span className="lock-match-icon">
                      <RiCheckboxCircleFill size={18} />
                    </span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Error message */}
          <AnimatePresence>
            {error && (
              <motion.div
                className="lock-error"
                initial={{ opacity: 0, y: -4, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: -4, height: 0 }}
                transition={{ duration: 0.2 }}
              >
                <RiErrorWarningFill size={16} />
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Remember password checkbox */}
          <label className="lock-remember">
            <input
              type="checkbox"
              checked={rememberPassword}
              onChange={(e) => setRememberPassword(e.target.checked)}
            />
            <span className="lock-remember-check" />
            <span className="lock-remember-text">비밀번호 저장</span>
          </label>

          {/* Submit button */}
          <motion.button
            type="submit"
            className="lock-submit-btn"
            disabled={isLoading}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
          >
            {isLoading ? (
              <span className="lock-spinner" />
            ) : (
              hasMasterPassword ? '잠금 해제' : '설정 완료'
            )}
          </motion.button>
        </motion.form>

        {/* Exit button */}
        <motion.button
          type="button"
          className="lock-exit-btn"
          onClick={() => window.electronAPI.closeWindow()}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.4 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
        >
          <RiShutDownLine size={16} />
          <span>프로그램 종료</span>
        </motion.button>

        {/* App branding */}
        <motion.div
          className="lock-branding"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.5 }}
        >
          ezShell
        </motion.div>
      </motion.div>
    </div>
  )
}
