import { describe, expect, it } from 'vitest'
import { sftpErrorDetail } from './sftpErrors'

describe('SFTP error details', () => {
  it.each([
    [new Error('10.0.0.5: Permission denied'), '접근 권한이 없습니다.'],
    ['ENOENT: no such file or directory', '파일 또는 폴더가 없습니다.'],
    ['connect ECONNREFUSED 10.0.0.5:22', '연결 상태를 확인해 주세요.'],
    [new Error('Unhandled 10.0.0.5 response'), undefined]
  ])('uses only the known reason, without the raw message (%s)', (error, detail) => {
    expect(sftpErrorDetail(error)).toBe(detail)
  })
})
