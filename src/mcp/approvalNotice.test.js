import { describe, it, expect } from 'vitest'
import notice from './approvalNotice.js'

const { approvalNoticeTitle } = notice

describe('approvalNoticeTitle', () => {
  it('names a plain command', () => {
    expect(approvalNoticeTitle({ command: 'rm -rf build' })).toBe('MCP 명령 확인 요청')
  })

  it('names a background job', () => {
    expect(approvalNoticeTitle({ command: 'npm test', background: { limitMinutes: 10 } })).toBe('MCP 백그라운드 실행 확인 요청')
  })

  it('names a file write', () => {
    expect(approvalNoticeTitle({ kind: 'file' })).toBe('MCP 파일 쓰기 확인 요청')
  })

  it('names a transfer by its direction', () => {
    expect(approvalNoticeTitle({ kind: 'transfer', direction: 'upload' })).toBe('MCP 파일 올리기 확인 요청')
    expect(approvalNoticeTitle({ kind: 'transfer', direction: 'download' })).toBe('MCP 파일 내려받기 확인 요청')
    expect(approvalNoticeTitle({ kind: 'transfer' })).toBe('MCP 파일 전송 확인 요청')
  })

  it('falls back to the command title for an unknown or missing request', () => {
    expect(approvalNoticeTitle({ kind: 'other' })).toBe('MCP 명령 확인 요청')
    expect(approvalNoticeTitle(undefined)).toBe('MCP 명령 확인 요청')
  })

  it('never puts the command or a path in the title', () => {
    const title = approvalNoticeTitle({ kind: 'transfer', direction: 'upload', command: 'SECRET-COMMAND', localPath: 'C:\\SECRET-PATH' })
    expect(title).not.toContain('SECRET')
  })
})
