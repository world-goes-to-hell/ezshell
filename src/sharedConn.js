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
  // A tab merged into another tab's pane: its shell still runs on this connection
  for (const guest of guests.values()) {
    if (guest.conn === conn) return true
  }
  return false
}

// Shells that became a pane of a tab on another connection (ssh-merge-tab): no tab session holds
// their connection any more, so it is kept here until the shell closes. stream -> { conn, jumpConn }
const guests = new Map()

const guestOf = (stream) => guests.get(stream)

function endTransport({ conn, jumpConn }) {
  try { conn.end() } catch { /* already closed */ }
  if (jumpConn) {
    try { jumpConn.end() } catch { /* already closed */ }
  }
}

/** The shell keeps `conn` (and its jump host) alive until `releaseGuest` */
function addGuest(stream, conn, jumpConn) {
  guests.set(stream, { conn, jumpConn: jumpConn || null })
}

/**
 * A guest shell closed: its connection ends unless a tab or another guest still uses it.
 * @returns {'none' | 'kept' | 'connection'} not a guest / still in use / ended
 */
function releaseGuest(connections, stream) {
  const guest = guests.get(stream)
  if (!guest) return 'none'
  guests.delete(stream)
  if (isShared(connections, guest.conn, null)) return 'kept'
  endTransport(guest)
  return 'connection'
}

/** Whether two tabs' logins reach the same account on the same server (through the same jump host) */
function sameServer(a, b) {
  if (!a || !b) return false
  const jumpOf = (config) => (config.useJumpHost && config.jumpHost ? `${String(config.jumpHost).trim()}:${Number(config.jumpPort) || 22}` : '')
  const key = (config) => JSON.stringify([config.host, Number(config.port) || 22, config.username, jumpOf(config)])
  return typeof a.host === 'string' && a.host !== '' && key(a) === key(b)
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
  // A promoted shell can use the connection it arrived on while the tab keeps its connection for SFTP.
  const guest = guestOf(session.stream)
  if (guest && guest.conn !== session.conn) {
    try { session.stream.close() } catch { /* already closed */ }
  }
  endTransport(session)
  return 'connection'
}

/** A session id no tab uses yet (ids are the time the tab connected) */
function newSessionId(connections, now = Date.now()) {
  let id = now
  while (connections.has(String(id))) id += 1
  return String(id)
}

module.exports = { isShared, release, newSessionId, addGuest, releaseGuest, guestOf, endTransport, sameServer }
