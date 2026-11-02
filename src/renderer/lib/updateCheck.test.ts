import { describe, it, expect } from 'vitest'
import { isUpdateNoticeVisible, resolveManualCheck, updateNoticeKey } from './updateCheck'

describe('resolveManualCheck', () => {
  it('ends the check when the updater sent no event (dev mode)', () => {
    const { info, notice } = resolveManualCheck('checking', { success: true, status: 'unsupported' })
    expect(info).toEqual({ status: 'idle' })
    expect(notice).toEqual({ type: 'info', title: '업데이트를 확인할 수 없습니다', message: '설치된 앱에서만 업데이트를 확인할 수 있습니다 (개발 모드)' })
  })

  it('reports the latest version when no update is available', () => {
    const { info, notice } = resolveManualCheck('checking', { success: true, status: 'not-available', version: '1.2.0' })
    expect(info).toEqual({ status: 'not-available' })
    expect(notice).toEqual({ type: 'success', title: '최신 버전입니다', message: 'v1.2.0' })
  })

  it('shows the update card, not a toast, when an update is available', () => {
    const { info, notice } = resolveManualCheck('checking', { success: true, status: 'available', version: '1.3.0' })
    expect(info).toEqual({ status: 'available', version: '1.3.0' })
    expect(notice).toBeNull()
  })

  it('ends the check with an error', () => {
    const { info, notice } = resolveManualCheck('checking', { success: false, error: 'net::ERR_INTERNET_DISCONNECTED' })
    expect(info).toEqual({ status: 'error', errorMessage: 'net::ERR_INTERNET_DISCONNECTED' })
    expect(notice).toEqual({ type: 'error', title: '업데이트 확인 실패', message: 'net::ERR_INTERNET_DISCONNECTED' })
  })

  it('ends the check when an older app returns nothing', () => {
    expect(resolveManualCheck('checking', undefined).info).toEqual({ status: 'idle' })
  })

  it('keeps the state an updater event already set, but still tells the user', () => {
    const { info, notice } = resolveManualCheck('not-available', { success: true, status: 'not-available', version: '1.2.0' })
    expect(info).toBeNull()
    expect(notice).toEqual({ type: 'success', title: '최신 버전입니다', message: 'v1.2.0' })
  })

  it('does not override a download that already started', () => {
    expect(resolveManualCheck('downloading', { success: true, status: 'available', version: '1.3.0' })).toEqual({ info: null, notice: null })
  })
})

describe('update notice per version', () => {
  it('shows a new version until the user closes it', () => {
    const info = { status: 'available' as const, version: '2.9.0' }
    expect(isUpdateNoticeVisible(info, null)).toBe(true)
    expect(isUpdateNoticeVisible(info, updateNoticeKey(info))).toBe(false)
  })

  it('shows a newer version again after an older one was closed', () => {
    const closed = updateNoticeKey({ status: 'available', version: '2.9.0' })
    expect(isUpdateNoticeVisible({ status: 'available', version: '2.9.1' }, closed)).toBe(true)
  })

  it('shows the downloaded notice even if the available one was closed', () => {
    const closed = updateNoticeKey({ status: 'available', version: '2.9.0' })
    expect(isUpdateNoticeVisible({ status: 'downloaded', version: '2.9.0' }, closed)).toBe(true)
  })

  it('shows a download in progress, and nothing for other states', () => {
    expect(isUpdateNoticeVisible({ status: 'downloading', percent: 10 }, null)).toBe(true)
    for (const status of ['idle', 'checking', 'not-available', 'error'] as const) {
      expect(isUpdateNoticeVisible({ status }, null)).toBe(false)
    }
  })
})
