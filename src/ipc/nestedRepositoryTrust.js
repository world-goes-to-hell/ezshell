const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { isLocalFilePath } = require('../localKeyPath.js')

const MAX_BYTES = 1024 * 1024
const key = folder => process.platform === 'win32' ? path.normalize(folder).toLowerCase() : path.normalize(folder)
const defaultState = () => ({ autoFetchEnabled: true, trusted: [] })
const validEntry = entry => entry && isLocalFilePath(entry.folder) && typeof entry.identity === 'string'
  && /^-?\d+:-?\d+:-?\d+$/.test(entry.identity)

function createNestedRepositoryTrust(file) {
  let session = defaultState()
  function read() {
    if (!file) return session
    try {
      const info = fs.lstatSync(file)
      if (!info.isFile() || info.size > MAX_BYTES) return defaultState()
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof data?.autoFetchEnabled !== 'boolean' || !Array.isArray(data.trusted) || !data.trusted.every(validEntry)) {
        return defaultState()
      }
      return data
    } catch { return defaultState() }
  }
  function write(state) {
    if (!file) { session = state; return }
    const contents = JSON.stringify(state)
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('신뢰한 로컬 작업이 너무 많습니다.')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally {
      try { fs.unlinkSync(temporary) } catch { /* Renamed or absent. */ }
    }
  }
  async function identify(folder) {
    const info = await fs.promises.lstat(folder, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('로컬 작업의 실제 폴더를 찾을 수 없습니다.')
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`
  }
  function preferences(enabled) {
    const state = read()
    if (typeof enabled === 'boolean' && state.autoFetchEnabled !== enabled) write({ ...state, autoFetchEnabled: enabled })
    return { autoFetchEnabled: typeof enabled === 'boolean' ? enabled : state.autoFetchEnabled }
  }
  async function trusted(folder) {
    const entry = read().trusted.find(item => key(item.folder) === key(folder))
    return !!entry && entry.identity === await identify(folder).catch(() => null)
  }
  function update(folder, identity) {
    const state = read()
    const remaining = state.trusted.filter(entry => key(entry.folder) !== key(folder))
    write({ ...state, trusted: identity ? [...remaining, { folder, identity }] : remaining })
  }
  return { identify, preferences, trusted, update }
}

module.exports = { createNestedRepositoryTrust }
