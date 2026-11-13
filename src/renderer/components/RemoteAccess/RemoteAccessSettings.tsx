import { useCallback, useEffect, useRef, useState } from 'react'
import { RiDeleteBinLine, RiFileCopyLine, RiQrCodeLine, RiShieldKeyholeLine, RiSmartphoneLine } from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import type { QrMatrix, RemoteAccessStatus } from '../../types'
import { QR_QUIET_ZONE, qrPath, remainingLabel } from '../../lib/qrSvg'
import '../Mcp/Mcp.css'
import './RemoteAccess.css'

interface Pairing {
  url: string
  expiresAt: number
  qr: QrMatrix
}

interface Authenticator {
  secret: string
  qr: QrMatrix
}

const TITLE = '원격 접속'

/** Always dark on white, whatever the theme: scanners need the contrast */
function QrCode({ matrix, label }: { matrix: QrMatrix; label: string }) {
  const side = matrix.size + QR_QUIET_ZONE * 2
  return (
    <svg className="remote-access-qr" viewBox={`0 0 ${side} ${side}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#ffffff" />
      <path d={qrPath(matrix)} fill="#000000" />
    </svg>
  )
}

const dateLabel = (time?: number | null): string =>
  time ? new Date(time).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '없음'

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('복사됨', `${label}을(를) 복사했습니다`)
  } catch {
    toast.error('복사 실패', '클립보드에 접근할 수 없습니다')
  }
}

export function RemoteAccessSettings() {
  const api = window.electronAPI
  const isSupported = typeof api?.remoteAccessStatus === 'function'
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [authenticator, setAuthenticator] = useState<Authenticator | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const deviceCountRef = useRef<number | null>(null)

  const apply = useCallback((result: RemoteAccessStatus | { success: false; error: string }): boolean => {
    if (!result.success) {
      toast.error(TITLE, result.error)
      return false
    }
    // A device appeared while the registration code was on screen: it has been used
    if (deviceCountRef.current !== null && result.devices.length > deviceCountRef.current) {
      setPairing(null)
      toast.success(TITLE, '기기를 등록했습니다')
    }
    deviceCountRef.current = result.devices.length
    setStatus(result)
    if (!result.isRunning) setPairing(null)
    if (!result.enabled) setAuthenticator(null)
    return true
  }, [])

  const reload = useCallback(() => {
    if (!isSupported) return
    api.remoteAccessStatus!().then(apply).catch(() => toast.error(TITLE, '상태를 불러오지 못했습니다'))
  }, [api, isSupported, apply])

  useEffect(() => {
    reload()
    return api?.onRemoteAccessChanged?.(reload)
  }, [api, reload])

  // The registration code runs out: count it down and take it off the screen
  useEffect(() => {
    if (!pairing) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing])
  useEffect(() => {
    if (pairing && now >= pairing.expiresAt) setPairing(null)
  }, [pairing, now])

  const run = async (task: () => Promise<unknown>) => {
    if (isBusy) return
    setIsBusy(true)
    try {
      await task()
    } catch {
      toast.error(TITLE, '요청을 처리하지 못했습니다')
    } finally {
      setIsBusy(false)
    }
  }

  const setEnabled = (isEnabled: boolean) => run(async () => apply(await api.remoteAccessSetEnabled!(isEnabled)))
  const setAnswerMcp = (isOn: boolean) => run(async () => apply(await api.remoteAccessSetAnswerMcp!(isOn)))

  const showPairing = () => run(async () => {
    const result = await api.remoteAccessPairing!()
    if (!result.success) return void toast.error(TITLE, result.error)
    setNow(Date.now())
    setPairing({ url: result.url, expiresAt: result.expiresAt, qr: result.qr })
  })

  const toggleAuthenticator = () => {
    if (authenticator) return setAuthenticator(null)
    return run(async () => {
      const result = await api.remoteAccessAuthenticator!()
      if (!result.success) return void toast.error(TITLE, result.error)
      setAuthenticator({ secret: result.secret, qr: result.qr })
    })
  }

  const revoke = (deviceId: string) => run(async () => {
    setConfirmingId(null)
    apply(await api.remoteAccessRevoke!(deviceId))
  })

  if (!isSupported) return <p className="mcp-transfer-empty">앱을 다시 시작하면 사용할 수 있습니다.</p>
  if (!status) return <p className="mcp-state">불러오는 중…</p>

  const connectedIds = new Set(status.connected.map((device) => device.id))
  const stateText = !status.enabled ? '꺼짐' : status.isRunning ? '켜짐' : '대기 중'

  return (
    <div className="mcp-settings remote-access">
      <div className="mcp-row">
        <label className="mcp-toggle">
          <input type="checkbox" checked={status.enabled} disabled={isBusy} onChange={(event) => setEnabled(event.target.checked)} />
          <span>휴대폰에서 접속 허용</span>
        </label>
        <span className={`mcp-state${status.isRunning ? ' running' : ''}`}>{stateText}</span>
        {status.url && (
          <span className="remote-access-address">
            <code>{status.url}</code>
            <button type="button" className="mcp-icon-btn" onClick={() => copyText(status.url!, '주소')} aria-label="주소 복사" title="주소 복사">
              <RiFileCopyLine size={16} />
            </button>
          </span>
        )}
      </div>

      {!status.hasTailscale && (
        <div className="mcp-setup-result warning">
          이 PC 에서 Tailscale 주소를 찾지 못했습니다. Tailscale 을 켜고 로그인한 뒤 다시 켜세요. 원격 접속은 Tailscale 주소로만 열립니다.
        </div>
      )}
      {status.error && <p className="mcp-error">{status.error}</p>}

      {status.enabled && (
        <>
          <section className="mcp-field">
            <span className="mcp-field-label">1. 인증 앱 등록 (처음 한 번)</span>
            <p className="remote-access-desc">
              휴대폰의 인증 앱(Google Authenticator, Microsoft Authenticator 등)으로 QR 을 찍어 두세요. 접속할 때마다 이 앱의 6자리 코드를 입력합니다.
            </p>
            <div className="mcp-setup-actions">
              <button type="button" className="mcp-setup-btn" disabled={isBusy} onClick={toggleAuthenticator}>
                <RiShieldKeyholeLine size={16} />
                {authenticator ? '인증 앱 QR 숨기기' : '인증 앱 QR 보기'}
              </button>
            </div>
            {authenticator && (
              <div className="remote-access-card">
                <QrCode matrix={authenticator.qr} label="인증 앱 등록 QR" />
                <div className="remote-access-card-text">
                  <strong>인증 앱에서 QR 을 찍으세요</strong>
                  <span>QR 을 찍을 수 없으면 아래 키를 직접 입력합니다.</span>
                  <span className="remote-access-address">
                    <code>{authenticator.secret}</code>
                    <button type="button" className="mcp-icon-btn" onClick={() => copyText(authenticator.secret, '키')} aria-label="키 복사" title="키 복사">
                      <RiFileCopyLine size={16} />
                    </button>
                  </span>
                  <span className="remote-access-note">이 QR 과 키는 다른 사람에게 보여 주지 마세요.</span>
                </div>
              </div>
            )}
          </section>

          <section className="mcp-field">
            <span className="mcp-field-label">2. 휴대폰 등록</span>
            <p className="remote-access-desc">
              Tailscale 이 켜진 휴대폰의 카메라로 QR 을 찍으면 브라우저가 열리고 그 휴대폰이 등록됩니다. QR 은 2분 동안, 한 번만 쓸 수 있습니다.
            </p>
            <div className="mcp-setup-actions">
              <button type="button" className="mcp-setup-btn" disabled={isBusy || !status.isRunning} onClick={showPairing}>
                <RiQrCodeLine size={16} />
                {pairing ? '등록 QR 새로 만들기' : '등록 QR 만들기'}
              </button>
            </div>
            {pairing && (
              <div className="remote-access-card">
                <QrCode matrix={pairing.qr} label="휴대폰 등록 QR" />
                <div className="remote-access-card-text">
                  <strong>휴대폰 카메라로 찍으세요</strong>
                  <span className="remote-access-countdown" aria-live="off">{remainingLabel(pairing.expiresAt, now)} 남음</span>
                  <span className="remote-access-note">등록이 끝나면 이 QR 은 사라집니다.</span>
                </div>
              </div>
            )}
          </section>

          <section className="mcp-field">
            <span className="mcp-field-label">MCP 확인 요청</span>
            <label className="mcp-toggle">
              <input type="checkbox" checked={status.answerMcp} disabled={isBusy} onChange={(event) => setAnswerMcp(event.target.checked)} />
              <span>휴대폰에서도 확인 요청에 답하기</span>
            </label>
            <p className="remote-access-desc">
              켜면 Claude 의 확인 요청이 접속한 휴대폰에도 뜹니다. 휴대폰이 접속해 있거나 알림을 받을 수 있는 동안에는, 휴대폰으로 답할 시간을 두기 위해 답을 기다리는 시간이 60초에서 4분으로 늘어납니다.
            </p>
            {status.isRunning && (status.push?.available ? (
              <p className="remote-access-desc">
                알림: 휴대폰 페이지의 <strong>알림 켜기</strong>를 누르면, PC 에서 15초 안에 답하지 않은 요청을 휴대폰 알림으로 알려 줍니다. 알림에는 요청 종류와 위험도만 들어갑니다.
              </p>
            ) : (
              <div className="mcp-setup-result warning">
                휴대폰 알림을 쓸 수 없습니다. {status.push?.note ?? ''} 알림 없이도 휴대폰 페이지를 열어 두면 요청이 뜹니다.
              </div>
            ))}
          </section>

          <section className="mcp-field">
            <span className="mcp-field-label">등록된 기기 ({status.devices.length})</span>
            {status.devices.length === 0 ? (
              <p className="mcp-transfer-empty">등록된 기기가 없습니다.</p>
            ) : (
              <ul className="remote-access-devices">
                {status.devices.map((device) => (
                  <li key={device.id} className="remote-access-device">
                    <RiSmartphoneLine size={18} aria-hidden />
                    <div className="remote-access-device-text">
                      <span className="remote-access-device-name">
                        {device.name}
                        {connectedIds.has(device.id) && <span className="remote-access-live">접속 중</span>}
                        {device.hasPush && <span className="remote-access-tag">알림</span>}
                      </span>
                      <span className="remote-access-device-times">
                        등록 {dateLabel(device.createdAt)} · 마지막 접속 {dateLabel(device.lastSeenAt)}
                      </span>
                    </div>
                    {confirmingId === device.id ? (
                      <span className="remote-access-confirm">
                        <button type="button" className="mcp-setup-btn danger" disabled={isBusy} onClick={() => revoke(device.id)}>해제</button>
                        <button type="button" className="mcp-setup-btn" onClick={() => setConfirmingId(null)}>취소</button>
                      </span>
                    ) : (
                      <button type="button" className="mcp-icon-btn" disabled={isBusy} onClick={() => setConfirmingId(device.id)} aria-label={`${device.name} 등록 해제`} title="등록 해제">
                        <RiDeleteBinLine size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <ul className="remote-access-facts">
        <li>이 PC 의 ezShell 이 켜져 있고 잠금이 풀려 있을 때만 접속할 수 있습니다. 잠그면 접속 중인 기기를 모두 끊습니다.</li>
        <li>같은 Tailscale 네트워크의 기기에서만 열립니다. 인터넷이나 사내망에는 열리지 않습니다.</li>
        <li>휴대폰에는 세션 이름과 폴더만 보이고, 서버 주소·계정·비밀번호는 PC 밖으로 나가지 않습니다.</li>
        <li>15분 동안 입력이 없으면 연결을 끊고, 코드를 5번 틀리면 그 기기를 5분 동안 막습니다.</li>
        <li>휴대폰을 잃어버리면 위 목록에서 그 기기를 해제하고, Tailscale 에서도 그 기기를 빼세요.</li>
      </ul>
    </div>
  )
}
