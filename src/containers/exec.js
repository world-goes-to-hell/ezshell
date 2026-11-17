// Runs one fixed command on a tab's SSH connection and collects its output, with limits: the
// channel is closed when the output passes `maxBytes` or the command takes longer than `timeoutMs`
// (the commands carry their own `timeout` too; this is for a server that does not honour it).

/**
 * @param {{ exec: Function }} conn  ssh2 client
 * @param {string} command
 * @param {{ maxBytes?: number, timeoutMs?: number }} limits
 * @returns {Promise<{ ok: true, stdout: string, stderr: string, exitCode: number | null, truncated: boolean }
 *   | { ok: false, error: string }>}
 */
function runCommand(conn, command, { maxBytes = 1024 * 1024, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let channel = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { if (channel) channel.close() } catch { /* already closed */ }
      finish({ ok: false, error: '서버가 제시간에 응답하지 않았습니다.' })
    }, timeoutMs)

    try {
      conn.exec(command, (err, stream) => {
        if (err) return finish({ ok: false, error: '서버에서 명령을 실행하지 못했습니다.' })
        channel = stream
        const out = []
        const errOut = []
        let size = 0
        let truncated = false
        let exitCode = null
        const take = (bucket) => (data) => {
          if (truncated) return
          size += data.length
          if (size > maxBytes) {
            truncated = true
            try { stream.close() } catch { /* already closed */ }
            return
          }
          bucket.push(data)
        }
        stream.on('data', take(out))
        stream.stderr.on('data', take(errOut))
        stream.on('exit', (code) => { exitCode = typeof code === 'number' ? code : null })
        stream.on('close', () => finish({
          ok: true,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
          exitCode,
          truncated
        }))
      })
    } catch {
      finish({ ok: false, error: '서버에서 명령을 실행하지 못했습니다.' })
    }
  })
}

module.exports = { runCommand }
