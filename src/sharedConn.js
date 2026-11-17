// A split shell moved out to a tab of its own keeps running on the SSH connection it was opened
// on, so two (or more) tab sessions can hold the same connection object. Closing one of them must
// then close only its own channel: the connection ends with the last session that uses it.

/**
 * @param {Map<string, { conn: unknown }>} connections  tab session id -> its session
 * @param {unknown} conn
 * @param {string} exceptId  the session asking (not counted)
 * @returns {boolean} whether another session uses the same connection
 */
function isShared(connections, conn, exceptId) {
  if (!conn) return false
  for (const [id, session] of connections) {
    if (id !== exceptId && session && session.conn === conn) return true
  }
  return false
}

/**
 * Ends what a session holds: only its shell channel while others share the connection, the whole
 * connection (and its jump host) otherwise. The session must already be off the list or be
 * `sessionId` itself; errors of an already closed channel or connection are ignored.
 * @returns {'channel' | 'connection'} what was ended
 */
function release(connections, sessionId, session) {
  if (isShared(connections, session.conn, sessionId)) {
    // close(), not end(): a PTY shell ignores EOF and would stay on the server
    try { if (session.stream) session.stream.close() } catch { /* already closed */ }
    return 'channel'
  }
  try { session.conn.end() } catch { /* already closed */ }
  if (session.jumpConn) {
    try { session.jumpConn.end() } catch { /* already closed */ }
  }
  return 'connection'
}

/** A session id no tab uses yet (ids are the time the tab connected) */
function newSessionId(connections, now = Date.now()) {
  let id = now
  while (connections.has(String(id))) id += 1
  return String(id)
}

module.exports = { isShared, release, newSessionId }
