import type { UpdateInfo, UpdateStatus } from '../stores/updateStore'

/** What the main process returns from 'check-for-updates' */
export interface UpdateCheckResult {
  success: boolean
  /** 'unsupported': the app is not packaged (dev mode), so electron-updater skips the check */
  status?: 'available' | 'not-available' | 'unsupported'
  version?: string
  error?: string
}

export interface UpdateNotice {
  type: 'success' | 'info' | 'error'
  title: string
  message?: string
}

interface ManualCheckOutcome {
  /** State to apply, or null when an updater event already moved past 'checking' */
  info: Partial<UpdateInfo> | null
  notice: UpdateNotice | null
}

function outcomeOf(result: UpdateCheckResult | undefined): ManualCheckOutcome {
  if (!result) return { info: { status: 'idle' }, notice: null }
  if (!result.success) {
    const message = result.error || '잠시 후 다시 시도해 주세요'
    return { info: { status: 'error', errorMessage: message }, notice: { type: 'error', title: '업데이트 확인 실패', message } }
  }
  switch (result.status) {
    case 'available':
      // The update card appears for this state, so no toast
      return { info: { status: 'available', version: result.version }, notice: null }
    case 'not-available':
      return { info: { status: 'not-available' }, notice: { type: 'success', title: '최신 버전입니다', message: result.version ? `v${result.version}` : undefined } }
    default:
      return {
        info: { status: 'idle' },
        notice: { type: 'info', title: '업데이트를 확인할 수 없습니다', message: '설치된 앱에서만 업데이트를 확인할 수 있습니다 (개발 모드)' }
      }
  }
}

/**
 * Settles a manual update check from the IPC result. The status events from electron-updater
 * are not enough on their own: when the check is skipped (dev mode) no event is sent at all,
 * which left the footer spinner turning forever.
 */
export function resolveManualCheck(currentStatus: UpdateStatus, result: UpdateCheckResult | undefined): ManualCheckOutcome {
  const outcome = outcomeOf(result)
  if (currentStatus === 'checking') return outcome
  // An event already set the state; only confirm "latest version" to the user who asked
  const confirmsLatest = currentStatus === 'not-available' && outcome.info?.status === 'not-available'
  return { info: null, notice: confirmsLatest ? outcome.notice : null }
}
