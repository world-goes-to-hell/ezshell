const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')

const WAIT_MS = 10 * 60_000
const POLL_MS = 500
const EXPIRED = '가져오기 대기가 끝났습니다. 다시 시작해 주세요.'

function createBrowserPasswordImport({ openSource, copyPath, logins }) {
  const transfers = new Map()

  function cancel(tabId, id) {
    const transfer = transfers.get(tabId)
    if (!transfer || (id !== undefined && id !== transfer.id)) return
    transfers.delete(tabId)
    clearTimeout(transfer.timeout)
    // Only these app-created paths are eligible for cleanup.
    try { fs.unlinkSync(transfer.file) } catch {}
    try { fs.rmdirSync(transfer.directory) } catch {}
  }

  async function start(tabId, sourceId, allowed) {
    if (transfers.has(tabId)) throw new Error('이미 비밀번호 내보내기를 기다리고 있습니다.')
    const scope = logins.scope()
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'ezshell-password-import-'))
    const transfer = { id: randomUUID(), directory, file: path.join(directory, 'passwords.csv'), scope }
    transfer.current = () => transfers.get(tabId) === transfer && allowed()
    transfers.set(tabId, transfer)
    transfer.timeout = setTimeout(() => cancel(tabId, transfer.id), WAIT_MS).unref()
    try {
      if (!await openSource(sourceId)) throw new Error('브라우저 프로필을 찾을 수 없습니다. 가져오기 메뉴를 다시 열어 주세요.')
      if (!transfer.current()) throw new Error(EXPIRED)
      copyPath(transfer.file)
      return transfer.id
    } catch (error) {
      cancel(tabId, transfer.id)
      throw error
    }
  }

  function transferFor(tabId, id) {
    const transfer = transfers.get(tabId)
    if (!transfer || transfer.id !== id || !transfer.current()) throw new Error(EXPIRED)
    return transfer
  }

  async function finish(tabId, id) {
    const transfer = transferFor(tabId, id)
    if (transfer.waiting) throw new Error('이미 비밀번호 내보내기를 기다리고 있습니다.')
    transfer.waiting = true
    let previous
    try {
      while (transfer.current()) {
        const stat = await fs.promises.lstat(transfer.file).catch(error => {
          if (error.code !== 'ENOENT') throw error
        })
        if (!transfer.current()) break
        if (stat && !stat.isFile()) throw new Error('브라우저에서 내보낸 비밀번호 CSV가 필요합니다.')
        const stamp = stat && `${stat.size}:${stat.mtimeMs}:${stat.ino}`
        if (stamp && stamp === previous) return await logins.import(transfer.file, transfer.scope, transfer.current)
        previous = stamp
        await wait(POLL_MS, undefined, { ref: false })
      }
      throw new Error(EXPIRED)
    } finally {
      cancel(tabId, id)
    }
  }

  return { start, finish, cancel, copy: (tabId, id) => copyPath(transferFor(tabId, id).file) }
}

module.exports = { createBrowserPasswordImport }
