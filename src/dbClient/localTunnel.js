// A port on this PC for the one database driver that cannot take a stream (Oracle: it opens its
// own socket). Everything else in the DB client hands the SSH channel to the driver and opens no
// port here; this is the one exception, kept as small as it can be: the port is on 127.0.0.1 only,
// its number is picked by the OS, it takes ONE connection and stops listening at once. So it is
// open for the moment the driver connects, not while the DB tab is open, and no other program on
// this PC can come in after the driver did.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const net = require('net')

const DEFAULT_WAIT_MS = 15 * 1000

/**
 * Listens for one connection and joins it to `openStream()` (a channel through the tab's SSH
 * connection to the database). Resolves with { port, close }: `close()` ends the tunnel.
 */
function openOneShotTunnel({ openStream, waitMs = DEFAULT_WAIT_MS }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    let socket = null
    let channel = null
    let isClosed = false

    const stopListening = () => {
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        // Not listening any more
      }
    }
    const close = () => {
      isClosed = true
      stopListening()
      socket?.destroy()
      try {
        channel?.close?.()
        channel?.destroy?.()
      } catch {
        // Already closed
      }
    }
    // Nobody connected in time: the port does not stay open
    const timer = setTimeout(stopListening, waitMs)

    server.maxConnections = 1
    server.on('connection', (incoming) => {
      // The first connection is the driver's; whoever comes after it gets nothing
      if (socket || isClosed) {
        incoming.destroy()
        return
      }
      socket = incoming
      stopListening()
      incoming.pause()
      incoming.on('error', close)
      incoming.on('close', close)
      Promise.resolve()
        .then(openStream)
        .then((opened) => {
          channel = opened
          if (isClosed) return close()
          opened.on('error', close)
          opened.on('close', close)
          incoming.pipe(opened)
          opened.pipe(incoming)
          incoming.resume()
        })
        .catch(close)
    })
    server.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    // Port 0: the OS picks a free one. 127.0.0.1: not reachable from another machine.
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close }))
  })
}

module.exports = { openOneShotTunnel }
