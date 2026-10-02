// Stand-in for ssh2's Client, for tests only (not copied into the build).
const { EventEmitter } = require('events')

const HOME = '/home/app'

/**
 * Fake ssh2 Client. `respond(command)` returns { stdout?, stderr?, code?, hang? }; `pwd` answers HOME by default.
 * Options: pwdReply (reply for pwd), holdConnect (never becomes ready until the test emits 'ready'),
 * holdOpen(command) (channel-open callback is parked in `opens`), openError, execThrows.
 */
function fakeSsh({ respond = () => ({}), failWith, pwdReply, holdConnect, holdOpen, openError, execThrows, sftp } = {}) {
  const created = []
  const sftpOpens = []
  const commands = []
  const streams = []
  const opens = []
  const createClient = () => {
    const client = new EventEmitter()
    client.ended = false
    client.connect = (options) => {
      client.options = options
      if (holdConnect) return
      setImmediate(() => (failWith ? client.emit('error', failWith) : client.emit('ready')))
    }
    client.end = () => { client.ended = true; client.emit('close') }
    client.forwardOut = (srcIp, srcPort, host, port, cb) => setImmediate(() => cb(null, { tunnelTo: `${host}:${port}` }))
    // sftp: () => channel object, or a function that throws / returns an Error to fail the subsystem request
    client.sftp = (cb) => {
      sftpOpens.push(client)
      const channel = sftp ? sftp(sftpOpens.length) : { end() { this.ended = true } }
      setImmediate(() => (channel instanceof Error ? cb(channel) : cb(null, channel)))
    }
    client.exec = (command, cb) => {
      if (execThrows) throw new Error('Not connected')
      commands.push(command)
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signals = []
      stream.endCalls = 0
      // Like ssh2's Channel: once stdin is ended (EOF sent) the channel drops every later signal.
      stream.signal = (name) => { if (stream.endCalls === 0) stream.signals.push(name) }
      stream.end = () => { stream.endCalls++ }
      stream.close = () => setImmediate(() => stream.emit('close', null, 'KILL'))
      streams.push({ command, stream })
      if (openError) { setImmediate(() => cb(new Error('channel open failed'))); return }
      const reply = command === 'pwd' ? (pwdReply || { stdout: `${HOME}\n` }) : respond(command)
      const open = () => {
        cb(null, stream)
        if (reply.hang) return
        setImmediate(() => {
          // chunks: [['stdout' | 'stderr', data], ...] delivered one by one, in this order
          for (const [name, data] of reply.chunks || []) (name === 'stderr' ? stream.stderr : stream).emit('data', Buffer.from(data))
          if (reply.stdout) stream.emit('data', Buffer.isBuffer(reply.stdout) ? reply.stdout : Buffer.from(reply.stdout))
          if (reply.stderr) stream.stderr.emit('data', Buffer.from(reply.stderr))
          stream.emit('close', reply.code ?? 0, undefined)
        })
      }
      if (holdOpen && holdOpen(command)) { opens.push(open); return }
      setImmediate(open)
    }
    created.push(client)
    return client
  }
  return { createClient, created, commands, streams, opens, sftpOpens }
}

module.exports = { fakeSsh, HOME }
