import { describe, it, expect } from 'vitest'
import sftpUploadCheck from './sftpUploadCheck.js'

const { verifyUploadedSize } = sftpUploadCheck

const statReturning = (size) => async () => ({ size })

describe('verifyUploadedSize', () => {
  it('passes when the remote file has the local size', async () => {
    await expect(verifyUploadedSize(statReturning(1024), '/up/a.txt', 1024)).resolves.toBeUndefined()
  })

  it('fails when the server stopped writing part way (write rejected, stream only closed)', async () => {
    await expect(verifyUploadedSize(statReturning(0), '/up/a.txt', 1024))
      .rejects.toThrow('업로드가 끝나지 않았습니다: 원격 0 / 로컬 1024 바이트')
  })

  it('fails with the stat error when the remote file cannot be read back', async () => {
    const stat = async () => { throw new Error('No such file') }

    await expect(verifyUploadedSize(stat, '/up/a.txt', 10)).rejects.toThrow('업로드 확인 실패: No such file')
  })
})
