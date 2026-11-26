const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { isUuid } = require('../agentHistory/common.js')

const DEFAULT_PROFILE = { id: 'default', name: '기본 계정' }
const MAX_PROFILES = 24
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 40 && !/[\x00-\x1f\x7f]/u.test(name)

function createClaudeProfiles(userData) {
  const file = path.join(userData, 'claude-profiles.json')
  const directory = path.join(userData, 'claude-profiles')
  let profiles

  function read() {
    if (profiles) return profiles
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(data) || data.length > MAX_PROFILES || data.some(({ id, name } = {}) => !isUuid(id) || id !== id.toLowerCase() || !validName(name)) ||
          new Set(data.map(profile => profile.id)).size !== data.length) throw new Error('Invalid profile list')
      profiles = data.map(({ id, name }) => ({ id, name }))
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Claude 계정 목록을 읽을 수 없습니다.')
      profiles = []
    }
    return profiles
  }

  function localDirectory(folder, create) {
    if (create) {
      try { fs.mkdirSync(folder, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Claude 계정의 설정 폴더를 사용할 수 없습니다.')
    return Boolean(stat)
  }

  function rootFor(id, create = false) {
    if (!id || id === DEFAULT_PROFILE.id || !read().some(profile => profile.id === id)) return undefined
    if (!localDirectory(directory, create)) return undefined
    const root = path.join(directory, id)
    return localDirectory(root, create) ? root : undefined
  }

  function list() { return [DEFAULT_PROFILE, ...read()] }

  function roots() {
    let configured
    try { configured = read() } catch { return [] }
    return configured.flatMap(profile => {
      try {
        const root = rootFor(profile.id)
        return root ? [{ ...profile, root }] : []
      } catch { return [] }
    })
  }

  return {
    list,
    rootFor,
    roots,
    save(request) {
      const name = typeof request?.name === 'string' ? request.name.trim() : ''
      if (!validName(name)) throw new Error('계정 이름을 1~40자로 입력해 주세요.')
      const current = read()
      const { id } = request
      if (id !== undefined && !current.some(profile => profile.id === id)) throw new Error('Claude 계정을 찾지 못했습니다.')
      if (list().some(profile => profile.id !== id && profile.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('이미 같은 이름의 Claude 계정이 있습니다.')
      }
      if (id === undefined && current.length >= MAX_PROFILES) throw new Error(`Claude 계정은 ${MAX_PROFILES}개까지 추가할 수 있습니다.`)
      const profile = { id: id ?? randomUUID(), name }
      const next = id ? current.map(item => item.id === id ? profile : item) : [...current, profile]
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx', flush: true })
        fs.renameSync(temporary, file)
      } finally {
        fs.rmSync(temporary, { force: true })
      }
      profiles = next
      return list()
    }
  }
}

module.exports = { createClaudeProfiles }
