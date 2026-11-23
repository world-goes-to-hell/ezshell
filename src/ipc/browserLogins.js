const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { encryptAsync, decryptAsync } = require('../crypto.js')

const MAX_CSV_BYTES = 8 * 1024 * 1024
const MAX_ACCOUNTS = 5000
const MAX_USERNAME = 1024
const MAX_PASSWORD = 4096
const INVALID_CSV = '브라우저에서 내보낸 UTF-8 비밀번호 CSV를 선택해 주세요.'

function loginOrigin(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value)
    if (url.username || url.password) return null
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.origin : null
  } catch { return null }
}

function credential(origin, username, password) {
  if (!origin || typeof username !== 'string' || username.length > MAX_USERNAME ||
    typeof password !== 'string' || !password.length || password.length > MAX_PASSWORD ||
    /[\r\n\0]/.test(username) || /[\r\n\0]/.test(password)) return null
  return { origin, username, password }
}

/** Browser exports share url/username/password columns. Keep commas, quotes and spaces in fields. */
function parseLoginCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let closedQuote = false
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else { quoted = false; closedQuote = true }
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field)
      field = ''
      closedQuote = false
      if (char !== ',') {
        if (char === '\r' && text[i + 1] === '\n') i++
        if (row.length > 1 || row[0]) rows.push(row)
        row = []
      }
    } else if (char === '"') {
      if (field || closedQuote) throw new Error(INVALID_CSV)
      quoted = true
    } else {
      if (closedQuote) throw new Error(INVALID_CSV)
      field += char
    }
  }
  if (quoted) throw new Error(INVALID_CSV)
  if (row.length || field || closedQuote) rows.push([...row, field])
  const headers = rows.shift()?.map(value => value.trim().toLowerCase()) ?? []
  const [url, username, password] = ['url', 'username', 'password'].map(name => headers.indexOf(name))
  if ([url, username, password].includes(-1)) throw new Error(INVALID_CSV)
  const entries = []
  let skipped = 0
  for (const fields of rows) {
    const entry = fields.length === headers.length && credential(loginOrigin(fields[url]?.trim()), fields[username], fields[password])
    if (entry) entries.push(entry)
    else skipped++
  }
  return { entries, skipped }
}

async function readImport(file) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_CSV_BYTES) throw new Error('8MiB 이하의 비밀번호 CSV를 선택해 주세요.')
    const buffer = Buffer.alloc(stat.size + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used !== stat.size) throw new Error('CSV 파일이 바뀌었습니다. 다시 선택해 주세요.')
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)) }
    catch { throw new Error(INVALID_CSV) }
    return parseLoginCsv(text)
  } finally {
    await handle.close()
  }
}

function createBrowserLogins(directory, getPassword) {
  const file = path.join(directory, 'browser-logins.json')
  let generation = 0
  let queue = Promise.resolve()
  const scope = () => generation
  const invalidate = () => { generation++ }
  const enqueue = work => {
    const next = queue.then(work)
    queue = next.catch(() => {})
    return next
  }

  function withVault(work, expected = scope(), current = () => true) {
    return enqueue(async () => {
      const password = getPassword()
      const check = () => {
        if (!password || expected !== scope() || getPassword() !== password) throw new Error('앱 잠금을 해제한 뒤 다시 시도해 주세요.')
        if (!current()) throw new Error('비밀번호 가져오기가 취소되었습니다.')
      }
      check()
      let raw
      try { raw = await fs.promises.readFile(file, 'utf8') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      let accounts = []
      if (raw !== undefined) {
        try {
          accounts = JSON.parse(await decryptAsync(JSON.parse(raw), password))
          if (!Array.isArray(accounts)) throw new Error('Invalid login vault')
        } catch { throw new Error('저장된 로그인 정보를 열 수 없습니다.') }
      }
      check()
      const save = async () => {
        const encrypted = await encryptAsync(JSON.stringify(accounts), password)
        check()
        const temp = `${file}.${randomUUID()}.tmp`
        try {
          // Complete the short commit while the same unlock is still current.
          fs.writeFileSync(temp, JSON.stringify(encrypted), { flag: 'wx', mode: 0o600 })
          fs.renameSync(temp, file)
        } finally {
          fs.rmSync(temp, { force: true })
        }
      }
      return work(accounts, save, check)
    })
  }

  const accountKey = ({ origin, username }) => JSON.stringify([origin, username])
  return {
    scope, invalidate,
    list: () => withVault(accounts => accounts.map(({ id, origin, username }) => ({ id, origin, username }))),
    get: (id, origin) => withVault(accounts => accounts.find(entry => entry.id === id && entry.origin === origin)),
    save(origin, username, password) {
      const entry = credential(loginOrigin(origin), username, password)
      if (!entry) throw new Error('아이디와 비밀번호를 확인해 주세요.')
      return withVault(async (accounts, save) => {
        const saved = accounts.find(item => accountKey(item) === accountKey(entry))
        if (saved) saved.password = entry.password
        else {
          if (accounts.length >= MAX_ACCOUNTS) throw new Error('최대 5,000개 계정까지 저장할 수 있습니다.')
          accounts.push({ id: randomUUID(), ...entry })
        }
        await save()
      })
    },
    remove: id => withVault(async (accounts, save) => {
      const at = accounts.findIndex(entry => entry.id === id)
      if (at < 0) return
      accounts.splice(at, 1)
      await save()
    }),
    import: (fileName, expected, current) => withVault(async (accounts, save, check) => {
      const { entries, skipped } = await readImport(fileName)
      check()
      const existing = new Set(accounts.map(accountKey))
      let imported = 0
      for (const entry of entries) {
        const key = accountKey(entry)
        if (existing.has(key) || accounts.length >= MAX_ACCOUNTS) continue
        accounts.push({ id: randomUUID(), ...entry })
        existing.add(key)
        imported++
      }
      if (imported) await save()
      return { imported, skipped: skipped + entries.length - imported }
    }, expected, current),
    reset() {
      invalidate()
      return enqueue(() => fs.promises.rm(file, { force: true }))
    }
  }
}

module.exports = { createBrowserLogins, loginOrigin, parseLoginCsv }
