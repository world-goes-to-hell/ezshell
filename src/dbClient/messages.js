// Korean text for database and tunnel errors. The database's own message is kept (it says what is
// wrong with the query); the password is never part of it.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.

class DbError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DbError'
    this.userMessage = message
  }
}

function tunnelMessage(err, endpoint) {
  const text = String(err?.message || '')
  const where = endpoint ? `${endpoint.host}:${endpoint.port}` : 'DB'
  if (err?.code === 'NO_CONNECTION') return '이 탭의 SSH 연결이 끊겨 있습니다. 다시 연결한 뒤 시도해 주세요.'
  // ssh2 puts the SSH reason code on the error: 1 prohibited, 2 connect failed, 4 resource shortage
  if (err?.reason === 1 || /administratively prohibited/i.test(text)) return '이 SSH 서버는 포트 포워딩을 허용하지 않습니다 (sshd 의 AllowTcpForwarding).'
  if (err?.reason === 4) return 'SSH 서버가 채널을 더 열 수 없습니다 (연결당 채널 수 제한). 다른 창을 닫고 다시 시도해 주세요.'
  if (/channel open failure|connect failed|connection refused/i.test(text)) return `SSH 서버에서 ${where} 에 접속하지 못했습니다. 주소와 포트를 확인해 주세요.`
  return null
}

const MYSQL_CODES = {
  ER_ACCESS_DENIED_ERROR: '사용자 이름이나 비밀번호가 맞지 않거나, 이 계정이 이 위치에서 접속할 권한이 없습니다.',
  ER_DBACCESS_DENIED_ERROR: '이 계정은 그 데이터베이스에 접근할 권한이 없습니다.',
  ER_BAD_DB_ERROR: '그 이름의 데이터베이스가 없습니다.',
  ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: '읽기 전용 접속이라 실행할 수 없습니다.',
  ER_QUERY_INTERRUPTED: '쿼리가 취소되었습니다.',
  ER_QUERY_TIMEOUT: '제한 시간이 지나 서버가 쿼리를 멈췄습니다.',
  ER_STATEMENT_TIMEOUT: '제한 시간이 지나 서버가 쿼리를 멈췄습니다.',
  ER_HOST_IS_BLOCKED: '접속 실패가 많아 DB 서버가 이 호스트를 막았습니다 (DB 관리자가 FLUSH HOSTS 로 풀 수 있습니다).'
}

const POSTGRES_CODES = {
  '28P01': '사용자 이름이나 비밀번호가 맞지 않습니다.',
  28000: '이 계정은 이 위치에서 접속할 수 없습니다 (pg_hba.conf).',
  '3D000': '그 이름의 데이터베이스가 없습니다.',
  25006: '읽기 전용 접속이라 실행할 수 없습니다.',
  57014: '쿼리가 취소되었거나 제한 시간이 지나 서버가 멈췄습니다.'
}

// Oracle's errors carry their number in the message
const ORACLE_PATTERNS = [
  [/NJS-138/, '이 서버의 Oracle 은 12.1 보다 오래된 버전입니다. 아래의 "오래된 Oracle 접속용 구성 요소"를 설치하면 접속할 수 있습니다.'],
  [/ORA-01017/, '사용자 이름이나 비밀번호가 맞지 않습니다.'],
  [/ORA-12514|ORA-12505|NJS-515|NJS-518|NJS-519/, '그 서비스 이름(또는 SID)을 DB 서버가 모릅니다.'],
  [/ORA-28000/, '이 계정은 잠겨 있습니다.'],
  [/ORA-28001/, '이 계정의 비밀번호가 만료되었습니다.'],
  [/ORA-01456/, '읽기 전용 접속이라 실행할 수 없습니다.'],
  [/ORA-01013/, '쿼리가 취소되었습니다.'],
  [/NJS-123|DPI-1067/, '제한 시간이 지나 쿼리를 멈췄습니다.'],
  [/ORA-01466/, '방금 구조가 바뀐 테이블이라 읽기 전용 조회로는 아직 읽을 수 없습니다. 몇 초 뒤에 다시 실행하세요.'],
  [/DPI-1047/, 'Oracle 구성 요소를 불러오지 못했습니다. Microsoft Visual C++ 재배포 패키지(x64)가 필요할 수 있습니다.']
]

/** One line for the screen: what happened in Korean, then the database's own message. */
function dbMessage(err, endpoint) {
  if (err instanceof DbError) return err.userMessage
  const tunnel = tunnelMessage(err, endpoint)
  if (tunnel) return tunnel
  if (err?.code === 'EZ_TIMEOUT') return '제한 시간 안에 답이 없어 쿼리를 포기했습니다. 서버에는 취소를 요청했습니다.'
  if (err?.code === 'EZ_NOT_READ_ONLY') return 'DB 서버가 읽기 전용 설정을 받아들이지 않아 접속을 끊었습니다.'
  if (err?.code === 'EZ_ORACLE_CLIENT') return `Oracle 구성 요소를 불러오지 못했습니다. Microsoft Visual C++ 재배포 패키지(x64)가 필요할 수 있습니다. (${String(err.message).slice(0, 160)})`
  if (/connection timeout|timeout expired|ETIMEDOUT/i.test(String(err?.message))) return 'DB 서버가 제한 시간 안에 답하지 않았습니다.'
  const original = String(err?.sqlMessage || err?.message || '알 수 없는 오류').split('\n')[0]
  // MariaDB's max_statement_time has no code name in mysql2
  if (/max_statement_time exceeded/i.test(original)) return `제한 시간이 지나 서버가 쿼리를 멈췄습니다. (${original})`
  const oracle = ORACLE_PATTERNS.find(([pattern]) => pattern.test(original))
  const known = MYSQL_CODES[err?.code] || POSTGRES_CODES[err?.code] || (oracle && oracle[1])
  return known ? `${known} (${original})` : original
}

module.exports = { DbError, dbMessage }
