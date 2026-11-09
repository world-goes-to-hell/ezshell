// Read-only check of a query before it is sent. The database itself keeps the session read-only
// (drivers/*.js); this check is the second layer and gives a clear message instead of a server error:
// one statement only, only statements that read, and none of the functions that act outside the
// query (other sessions, server files, settings, locks that outlive the query).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.

const READ_KEYWORDS = {
  // USE only changes the default database of this connection
  mysql: new Set(['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'TABLE', 'VALUES', 'USE']),
  postgres: new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'TABLE', 'VALUES'])
}

// Function names (upper case) refused anywhere in the query, quoted or schema-qualified.
// A read-only transaction does not stop these: they reach other sessions, files or server settings.
const BLOCKED_FUNCTIONS = {
  mysql: {
    exact: new Set(['GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'LOAD_FILE']),
    prefixes: []
  },
  postgres: {
    exact: new Set([
      'SET_CONFIG', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF', 'PG_ROTATE_LOGFILE',
      'LO_IMPORT', 'LO_EXPORT', 'LO_UNLINK', 'LO_CREATE', 'LO_FROM_BYTEA', 'LO_PUT',
      'PG_PROMOTE', 'PG_SWITCH_WAL', 'PG_CREATE_RESTORE_POINT', 'PG_LOGICAL_EMIT_MESSAGE',
      'PG_DROP_REPLICATION_SLOT', 'PG_CREATE_PHYSICAL_REPLICATION_SLOT', 'PG_CREATE_LOGICAL_REPLICATION_SLOT',
      'PG_REPLICATION_ORIGIN_CREATE', 'PG_REPLICATION_ORIGIN_DROP', 'PG_WAL_REPLAY_PAUSE', 'PG_WAL_REPLAY_RESUME'
    ]),
    // dblink opens its own connection (no read-only there); advisory locks can outlive the query;
    // pg_stat_reset* clears statistics; pg_file_* (adminpack) writes server files
    prefixes: ['DBLINK', 'PG_ADVISORY_', 'PG_TRY_ADVISORY_', 'PG_STAT_RESET', 'PG_FILE_']
  }
}

const MESSAGES = {
  empty: '실행할 쿼리가 없습니다.',
  multiple: '한 번에 문장 하나만 실행할 수 있습니다.',
  notRead: (keyword) => `조회 문장만 실행할 수 있습니다 (${keyword}). 지금은 읽기 전용 접속입니다.`,
  outfile: 'INTO OUTFILE / DUMPFILE 은 서버에 파일을 만들므로 실행할 수 없습니다.',
  executableComment: '실행되는 주석(/*! ... */)은 쓸 수 없습니다.',
  blockedFunction: (name) => `${name.toLowerCase()} 함수는 다른 세션·서버 파일·설정에 영향을 줄 수 있어 실행할 수 없습니다.`,
  unclosed: '닫히지 않은 따옴표나 주석이 있습니다.'
}

/** MySQL treats `--` as a comment only when a space or control character follows */
function startsLineComment(sql, i, engine) {
  if (sql[i] === '#' && engine === 'mysql') return true
  if (sql[i] !== '-' || sql[i + 1] !== '-') return false
  if (engine !== 'mysql') return true
  const after = sql[i + 2]
  return after === undefined || after <= ' '
}

/**
 * Splits the text into words outside strings and comments, and finds statement ends.
 * Returns `{ words, names, statements, isClosed, hasExecutableComment }`: `words` are upper-cased bare
 * words in order, `names` also holds quoted identifiers (a quoted function name is still that function),
 * `statements` counts statements that hold anything besides whitespace and comments.
 */
function scan(sql, engine) {
  const words = []
  const names = []
  let statements = 0
  let hasContent = false
  let hasExecutableComment = false
  let i = 0
  const n = sql.length
  const result = (isClosed) => ({ words, names, statements, isClosed, hasExecutableComment })
  const endStatement = () => {
    if (hasContent) statements++
    hasContent = false
  }
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (startsLineComment(sql, i, engine)) {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? n : end + 1
    } else if (c === '/' && next === '*') {
      // MySQL runs /*! ... */ and MariaDB /*M! ... */ as code
      if (engine === 'mysql' && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) hasExecutableComment = true
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return result(false)
      i = end + 2
    } else if (c === "'" || c === '"' || c === '`') {
      // PostgreSQL E'...' strings take backslash escapes
      const isEscapeString = engine === 'postgres' && c === "'" && /[Ee]/.test(sql[i - 1] || '') && !/[\w$]/.test(sql[i - 2] || '')
      const end = closingQuote(sql, i, c, engine, isEscapeString)
      if (end < 0) return result(false)
      const isIdentifier = c === '`' || (c === '"' && engine === 'postgres')
      if (isIdentifier) names.push(sql.slice(i + 1, end).split(c + c).join(c).toUpperCase())
      hasContent = true
      i = end + 1
    } else if (c === '$' && engine === 'postgres' && /^\$[A-Za-z_]?\w*\$/.test(sql.slice(i, i + 64))) {
      const tag = sql.slice(i, i + 64).match(/^\$[A-Za-z_]?\w*\$/)[0]
      const end = sql.indexOf(tag, i + tag.length)
      if (end < 0) return result(false)
      hasContent = true
      i = end + tag.length
    } else if (c === ';') {
      endStatement()
      i++
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(sql[j])) j++
      const word = sql.slice(i, j).toUpperCase()
      words.push(word)
      names.push(word)
      hasContent = true
      i = j
    } else {
      if (!/\s/.test(c)) hasContent = true
      i++
    }
  }
  endStatement()
  return result(true)
}

/** Index of the quote that closes the one at `start`; doubled quotes (and backslashes in MySQL strings) are escapes. */
function closingQuote(sql, start, quote, engine, isEscapeString) {
  let i = start + 1
  const takesBackslash = isEscapeString || (engine === 'mysql' && quote !== '`')
  while (i < sql.length) {
    const c = sql[i]
    if (c === '\\' && takesBackslash) {
      i += 2
    } else if (c === quote) {
      if (sql[i + 1] === quote) i += 2
      else return i
    } else {
      i++
    }
  }
  return -1
}

function blockedFunction(names, engine) {
  const { exact, prefixes } = BLOCKED_FUNCTIONS[engine] || BLOCKED_FUNCTIONS.postgres
  return names.find((name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) || null
}

/** `{ ok: true }` when the query may be sent, otherwise `{ ok: false, reason }` (Korean, for the screen). */
function checkReadOnly(sql, engine) {
  const text = typeof sql === 'string' ? sql : ''
  const { words, names, statements, isClosed, hasExecutableComment } = scan(text, engine)
  if (!isClosed) return { ok: false, reason: MESSAGES.unclosed }
  if (hasExecutableComment) return { ok: false, reason: MESSAGES.executableComment }
  if (statements === 0 || words.length === 0) return { ok: false, reason: MESSAGES.empty }
  if (statements > 1) return { ok: false, reason: MESSAGES.multiple }
  const allowed = READ_KEYWORDS[engine] || READ_KEYWORDS.postgres
  if (!allowed.has(words[0])) return { ok: false, reason: MESSAGES.notRead(words[0]) }
  if (engine === 'mysql') {
    for (let k = 0; k < words.length - 1; k++) {
      if (words[k] === 'INTO' && (words[k + 1] === 'OUTFILE' || words[k + 1] === 'DUMPFILE')) {
        return { ok: false, reason: MESSAGES.outfile }
      }
    }
  }
  const blocked = blockedFunction(names, engine)
  if (blocked) return { ok: false, reason: MESSAGES.blockedFunction(blocked) }
  return { ok: true }
}

module.exports = { checkReadOnly, MESSAGES }
