/** Only known reasons reach the UI. Connection errors can include a server address. */
export function sftpErrorDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/permission denied|access denied|\bEACCES\b|\bEPERM\b|권한/i.test(message)) return '접근 권한이 없습니다.'
  if (/no such file|not found|\bENOENT\b|존재하지 않/i.test(message)) return '파일 또는 폴더가 없습니다.'
  if (/not a directory|\bENOTDIR\b/i.test(message)) return '폴더가 아닌 경로입니다.'
  if (/timed? ?out|\bETIMEDOUT\b|시간 초과/i.test(message)) return '응답 시간이 초과되었습니다.'
  if (/connection|channel (?:is )?closed|not connected|\bE(?:CONNRESET|CONNREFUSED|PIPE)\b|SFTP 세션이 없습니다|연결/i.test(message)) return '연결 상태를 확인해 주세요.'
}
