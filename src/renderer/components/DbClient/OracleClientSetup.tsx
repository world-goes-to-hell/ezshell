import { useCallback, useEffect, useRef, useState } from 'react'
import { RiCheckboxCircleLine, RiDownload2Line, RiExternalLinkLine, RiLoader4Line } from 'react-icons/ri'
import type { OracleClientProgress, OracleClientStatus } from '../../types'

interface OracleClientSetupProps {
  /** The connection just failed because the server is older than the built-in driver reaches */
  isNeeded: boolean
  /** The dialog is busy connecting */
  isDisabled: boolean
  /** Installed (or removed): the caller may try again */
  onChanged?: (status: OracleClientStatus) => void
}

const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`

/** What the progress line says while installing */
export function installProgressText(progress: OracleClientProgress | null): string {
  if (!progress) return '준비하는 중…'
  if (progress.step === 'unpack') return '압축을 푸는 중…'
  const percent = progress.total > 0 ? Math.min(100, Math.floor((progress.received / progress.total) * 100)) : 0
  return `내려받는 중… ${megabytes(progress.received)} / ${megabytes(progress.total)} (${percent}%)`
}

/**
 * Oracle servers older than 12.1 need Oracle's own client libraries. They are not part of the app
 * (Oracle's licence): this downloads them from Oracle after the user agreed, with one button.
 */
export function OracleClientSetup({ isNeeded, isDisabled, onChanged }: OracleClientSetupProps) {
  const api = window.electronAPI
  const [status, setStatus] = useState<OracleClientStatus | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [hasAgreed, setHasAgreed] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [progress, setProgress] = useState<OracleClientProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const apply = useCallback((result: OracleClientStatus | { success: false; error: string } | undefined) => {
    if (!result) return
    if (!result.success) {
      setError(result.error)
      return
    }
    setError(null)
    setStatus(result)
    // An installation started before the dialog was reopened is still running
    if (result.progress) {
      setIsInstalling(true)
      setProgress(result.progress)
    }
  }, [])

  useEffect(() => {
    void api.oracleClientStatus?.().then(apply)
    return api.onOracleClientProgress?.(setProgress)
  }, [api, apply])

  // The failure that needs it opens the panel
  useEffect(() => {
    if (isNeeded) setIsOpen(true)
  }, [isNeeded])

  // The dialog scrolls and its buttons stay at the bottom: the opened panel is brought to where it can be seen whole
  useEffect(() => {
    if (isOpen) panelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [isOpen])

  if (!status || !status.isSupported) return null

  const install = async () => {
    if (isInstalling || !hasAgreed) return
    setIsInstalling(true)
    setProgress(null)
    setError(null)
    try {
      const result = await api.oracleClientInstall!()
      apply(result)
      if (result.success) onChanged?.(result)
    } catch {
      setError('설치하지 못했습니다.')
    } finally {
      setIsInstalling(false)
      setProgress(null)
    }
  }

  const remove = async () => {
    const result = await api.oracleClientRemove!()
    apply(result)
    if (result.success) onChanged?.(result)
  }

  if (status.isInstalled) {
    return (
      <div className="db-oracle-client is-installed" role="status">
        <RiCheckboxCircleLine size={14} aria-hidden="true" />
        <span className="db-oracle-client-text">
          오래된 Oracle 접속용 구성 요소가 설치되어 있습니다 (Instant Client {status.version}).
          {status.needsRestart && <strong> ezShell 을 다시 시작하면 적용됩니다.</strong>}
        </span>
        {!status.isInUse && (
          <button type="button" className="db-oracle-client-link" disabled={isDisabled} onClick={() => void remove()}>제거</button>
        )}
        {error && <span className="db-oracle-client-error">{error}</span>}
      </div>
    )
  }

  if (!isOpen) {
    return (
      <div className="db-oracle-client">
        <span className="db-oracle-client-text">Oracle 11g 처럼 오래된 서버(12.1 미만)에 접속하려면 구성 요소가 더 필요합니다.</span>
        <button type="button" className="db-oracle-client-link" disabled={isDisabled} onClick={() => setIsOpen(true)}>설치…</button>
      </div>
    )
  }

  return (
    <div className="db-oracle-client is-open" ref={panelRef}>
      <strong className="db-oracle-client-title">오래된 Oracle 접속용 구성 요소 설치</strong>
      <p className="db-oracle-client-text">
        Oracle 이 배포하는 클라이언트 라이브러리(Instant Client {status.version}, {megabytes(status.bytes)})를 Oracle 서버에서 내려받아 이 PC 에 설치합니다.
        Oracle 11.2 이상에 접속할 수 있게 됩니다. 한 번만 하면 됩니다.
      </p>
      <p className="db-oracle-client-text">
        이 라이브러리는 Oracle 의 무료 사용 조건(Oracle Free Use Terms and Conditions)에 따라 제공됩니다.{' '}
        <button type="button" className="db-oracle-client-link" onClick={() => void api.oracleClientLicense?.()}>
          조건 보기 <RiExternalLinkLine size={12} aria-hidden="true" />
        </button>
      </p>
      <label className="db-oracle-client-agree">
        <input type="checkbox" checked={hasAgreed} disabled={isInstalling} onChange={(event) => setHasAgreed(event.target.checked)} />
        <span>Oracle 의 사용 조건을 확인했고 동의합니다</span>
      </label>
      {isInstalling ? (
        <div className="db-oracle-client-progress" role="status">
          <RiLoader4Line className="spinning" size={14} aria-hidden="true" />
          <span>{installProgressText(progress)}</span>
          <progress max={progress?.total || 1} value={progress?.step === 'unpack' ? progress.total : progress?.received ?? 0} />
        </div>
      ) : (
        <div className="db-oracle-client-actions">
          <button type="button" className="btn-secondary" disabled={!hasAgreed || isDisabled} onClick={() => void install()}>
            <RiDownload2Line size={14} aria-hidden="true" /> 내려받아 설치
          </button>
          <button type="button" className="db-oracle-client-link" onClick={() => setIsOpen(false)}>닫기</button>
        </div>
      )}
      {error && <p className="db-oracle-client-error" role="alert">{error}</p>}
    </div>
  )
}
