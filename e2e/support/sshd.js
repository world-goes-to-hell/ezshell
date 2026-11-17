// Test SSH server for the screen tests (specs named ssh-*): any login is accepted, the shell echoes
// what is typed and knows a few words (ls, ll, etc, home, exit, drop, refuse, halt N), and SFTP serves a small folder.
// Started by e2e/run.js with E2E_SSH_PORT (127.0.0.1 only) and E2E_SSH_DIR (a temp folder for the
// host key and the served files).
const path = require('path')
const fs = require('fs')
const net = require('net')
const { Server, utils } = require('ssh2')
const WORK_DIR = process.env.E2E_SSH_DIR
const PORT = Number(process.env.E2E_SSH_PORT) || 2222
if (!WORK_DIR) throw new Error('E2E_SSH_DIR is not set')

// SFTP backed by a folder in the work folder (sample files)
const { OPEN_MODE, STATUS_CODE } = utils.sftp
const disk = path.join(WORK_DIR, 'sftpdisk')
fs.mkdirSync(path.join(disk, 'var', 'log'), { recursive: true })
fs.mkdirSync(path.join(disk, 'etc'), { recursive: true })
fs.writeFileSync(path.join(disk, 'var', 'log', 'app.log'), '2026-11-10 09:00:00 INFO start\n2026-11-10 09:00:01 ERROR db down\n')
fs.writeFileSync(path.join(disk, 'etc', 'hosts'), '127.0.0.1 localhost\n')
fs.writeFileSync(path.join(disk, 'var', 'old.txt'), 'old\n')
// A one-page PDF and a 1x1 PNG, for the preview window
fs.writeFileSync(path.join(disk, 'var', 'doc.pdf'), ['%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj', '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF', ''].join('\n'))
fs.writeFileSync(path.join(disk, 'var', 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
// `~` is the login folder, which is the root here (the app uploads dropped files to `~/name`)
const local = (p) => path.join(disk, ...String(p).split('/').filter((part) => part && part !== '~'))
const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) })
const codeOf = (err) => (err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : (err.code === 'EPERM' || err.code === 'EACCES') ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE)

function serveSftp(sftp) {
  const handles = new Map()
  let next = 1
  const answer = (id, work) => { try { work() } catch (e) { sftp.status(id, codeOf(e)) } }
  const ok = (id) => sftp.status(id, STATUS_CODE.OK)
  sftp.on('REALPATH', (id, p) => answer(id, () => {
    const normal = path.posix.normalize(p === '.' || p === '' ? '/' : p.startsWith('/') ? p : '/' + p)
    fs.statSync(local(normal))
    sftp.name(id, [{ filename: normal, longname: normal, attrs: {} }])
  }))
  sftp.on('STAT', (id, p) => answer(id, () => sftp.attrs(id, attrsOf(fs.statSync(local(p))))))
  sftp.on('LSTAT', (id, p) => answer(id, () => sftp.attrs(id, attrsOf(fs.lstatSync(local(p))))))
  sftp.on('OPENDIR', (id, p) => answer(id, () => {
    const entries = fs.readdirSync(local(p)).map((name) => {
      const st = fs.statSync(path.join(local(p), name))
      return { filename: name, longname: `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 root root ${st.size} Nov 10 09:00 ${name}`, attrs: attrsOf(st) }
    })
    const handle = Buffer.from(`d${next++}`)
    handles.set(handle.toString(), { entries, sent: false })
    sftp.handle(id, handle)
  }))
  sftp.on('READDIR', (id, h) => {
    const dir = handles.get(h.toString())
    if (!dir) return sftp.status(id, STATUS_CODE.EOF)
    dir.at = dir.at || 0
    if (dir.at >= dir.entries.length) return sftp.status(id, STATUS_CODE.EOF)
    const part = dir.entries.slice(dir.at, dir.at + 100)
    dir.at += part.length
    sftp.name(id, part)
  })
  sftp.on('OPEN', (id, p, flags) => answer(id, () => {
    let mode = 'r'
    if ((flags & OPEN_MODE.WRITE) && (flags & OPEN_MODE.CREAT)) mode = (flags & OPEN_MODE.EXCL) ? 'wx' : 'w'
    else if (flags & OPEN_MODE.WRITE) mode = 'r+'
    const handle = Buffer.from(String(next++))
    handles.set(handle.toString(), fs.openSync(local(p), mode))
    sftp.handle(id, handle)
  }))
  sftp.on('FSTAT', (id, h) => answer(id, () => sftp.attrs(id, attrsOf(fs.fstatSync(handles.get(h.toString()))))))
  sftp.on('READ', (id, h, offset, length) => answer(id, () => {
    const buffer = Buffer.alloc(length)
    const n = fs.readSync(handles.get(h.toString()), buffer, 0, length, offset)
    if (n === 0) sftp.status(id, STATUS_CODE.EOF)
    else sftp.data(id, buffer.subarray(0, n))
  }))
  sftp.on('WRITE', (id, h, offset, data) => answer(id, () => { fs.writeSync(handles.get(h.toString()), data, 0, data.length, offset); ok(id) }))
  sftp.on('CLOSE', (id, h) => answer(id, () => {
    const value = handles.get(h.toString())
    if (typeof value === 'number') fs.closeSync(value)
    handles.delete(h.toString())
    ok(id)
  }))
  sftp.on('MKDIR', (id, p) => answer(id, () => { fs.mkdirSync(local(p)); ok(id) }))
  sftp.on('RENAME', (id, from, to) => answer(id, () => { fs.renameSync(local(from), local(to)); ok(id) }))
  sftp.on('REMOVE', (id, p) => answer(id, () => { fs.unlinkSync(local(p)); ok(id) }))
  sftp.on('RMDIR', (id, p) => answer(id, () => { fs.rmdirSync(local(p)); ok(id) }))
  sftp.on('READLINK', (id) => sftp.status(id, STATUS_CODE.FAILURE))
}

const keyFile = path.join(WORK_DIR, 'hostkey.pem')
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, utils.generateKeyPairSync('ed25519').private)

// `halt N` typed in a shell: every connection is dropped and new ones are refused for N seconds
// (a server that went down and came back)
const clients = new Set()
function haltFor(seconds) {
  server.close()
  for (const client of clients) client.end()
  setTimeout(() => server.listen(PORT, '127.0.0.1'), seconds * 1000)
}

const server = new Server({ hostKeys: [fs.readFileSync(keyFile)] }, (client) => {
  clients.add(client)
  client.on('close', () => clients.delete(client))
  client.on('authentication', (ctx) => ctx.accept())
  client.on('ready', () => {
    // `refuse` typed in a shell: the next two channels this connection asks for are rejected
    // (what a server at its channel limit does), then channels open again
    let refusals = 0
    client.on('session', (accept, reject) => {
      if (refusals > 0) { refusals--; reject(); return }
      const session = accept()
      session.on('sftp', (acceptSftp) => serveSftp(acceptSftp()))
      session.on('pty', (ok) => ok && ok())
      session.on('window-change', (ok) => ok && ok())
      session.on('env', (ok) => ok && ok())
      session.on('shell', (ok) => {
        const stream = ok()
        let where = '/var', line = ''
        const prompt = () => stream.write('tester@fake:' + where + '$ ')
        stream.write('fake shell\r\n'); prompt()
        stream.on('data', (d) => {
          for (const ch of d.toString()) {
            if (ch === '\r') {
              const cmd = line.trim(); line = ''
              stream.write('\r\n')
              if (cmd === 'exit') { stream.write('timed out waiting for input: auto-logout\r\n'); stream.exit(0); stream.end(); return }
              if (cmd === 'drop') { client.end(); return }
              if (cmd === 'refuse') refusals = 2
              const halt = /^halt (\d+)$/.exec(cmd)
              if (halt) { haltFor(Number(halt[1])); return }
              if (cmd === 'home') where = '~'
              if (cmd === 'etc') where = '/etc'
              if (cmd === 'ls') stream.write('log  newdir  old.txt  wide.conf  nothere.txt\r\n')
              if (cmd === 'll') stream.write('drwxr-xr-x 2 root root 4096 Nov 10 09:00 log\r\n-rw-r--r-- 1 root root    4 Nov 10 09:00 old.txt\r\n-rw-r--r-- 1 root root  110 Nov 10 09:00 /etc/hosts\r\n')
              prompt()
            } else { line += ch; stream.write(ch) }
          }
        })
      })
      session.on('exec', (ok) => {
        // Commands the app runs by itself (database discovery) get an empty answer
        const stream = ok()
        stream.exit(0)
        stream.end()
      })
    })
    client.on('tcpip', (accept, reject, info) => {
      const socket = net.connect(info.destPort, info.destIP)
      socket.once('error', () => reject())
      socket.once('connect', () => {
        const channel = accept()
        socket.pipe(channel).pipe(socket)
        channel.on('close', () => socket.destroy())
        socket.on('close', () => channel.close())
      })
    })
  })
  client.on('error', () => {})
})
server.listen(PORT, '127.0.0.1', () => console.log(`test sshd on ${PORT}`))
