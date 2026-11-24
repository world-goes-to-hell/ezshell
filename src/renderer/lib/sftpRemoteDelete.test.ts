import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConfirmStore } from '../stores/confirmStore'
import { deleteRemoteSelection } from './sftpRemoteDelete'

describe('remote file deletion confirmation', () => {
  afterEach(() => {
    useConfirmStore.getState().answer(false)
    vi.unstubAllGlobals()
  })

  it('shows the affected connection’s name and effective color before deleting', async () => {
    const sftpDelete = vi.fn()
    const sshGetSessionInfo = vi.fn().mockResolvedValue({
      sessionName: '운영 서버', color: '#ef4444', username: 'deploy', host: '10.0.0.5'
    })
    vi.stubGlobal('window', { electronAPI: { sftpDelete, sshGetSessionInfo } })

    const pending = deleteRemoteSelection('tab-1', '/etc', new Set(['app.conf']), [
      { name: 'app.conf', type: 'file', size: 1, modifyTime: 0 }
    ])
    await vi.waitFor(() => expect(useConfirmStore.getState().request).toMatchObject({
      danger: true, server: { name: '운영 서버', color: '#ef4444' }
    }))
    expect(sshGetSessionInfo).toHaveBeenCalledWith('tab-1')
    expect(sftpDelete).not.toHaveBeenCalled()

    useConfirmStore.getState().answer(false)
    await expect(pending).resolves.toBe(false)
    expect(sftpDelete).not.toHaveBeenCalled()
  })
})
