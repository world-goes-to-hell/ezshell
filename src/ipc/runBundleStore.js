// Where run bundles are kept (part 3): a file of its own next to run-presets.json, by project key, so saving a
// preset or the start order never drops them. A bundle names presets by id; the ids of presets that are gone are
// left out when read (runBundles.js keepBundles), so deleting a preset needs nothing here.
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { keepBundles, saveBundle, findBundle } = require('./runBundles.js')

const MAX_BYTES = 512 * 1024
const MAX_PROJECTS = 200
const PROJECT_KEY = /^[^\x00-\x1f]{1,1024}$/

function createRunBundleStore(file) {
  let projects = new Map()
  try {
    if (file && fs.statSync(file).size <= MAX_BYTES) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data?.version === 1 && Array.isArray(data.projects)) {
        for (const project of data.projects.slice(0, MAX_PROJECTS)) {
          if (!project || typeof project.key !== 'string' || !PROJECT_KEY.test(project.key) || !Array.isArray(project.bundles)) continue
          if (!projects.has(project.key)) projects.set(project.key, project.bundles)
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[run bundles] 저장된 실행 묶음을 읽지 못했습니다.')
  }

  function write(next) {
    if (!file) throw new Error('실행 묶음을 저장할 곳이 없습니다.')
    const data = JSON.stringify({ version: 1, projects: [...next].map(([key, bundles]) => ({ key, bundles })) }) + '\n'
    if (next.size > MAX_PROJECTS || Buffer.byteLength(data) > MAX_BYTES) throw new Error('저장할 실행 묶음이 너무 많습니다.')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
      projects = next
    } finally { try { fs.unlinkSync(temporary) } catch {} }
  }

  /** The project's bundles that still make sense with its presets now */
  const list = (key, presetIds) => keepBundles(projects.get(key), new Set(presetIds))

  function save(key, input, presetIds) {
    const ids = new Set(presetIds)
    const bundles = saveBundle(list(key, ids), input, ids)
    const next = new Map(projects)
    next.set(key, bundles)
    write(next)
    return bundles
  }

  function remove(key, id, presetIds) {
    const bundles = list(key, presetIds)
    if (!bundles.some(bundle => bundle.id === id)) throw new Error('묶음을 찾지 못했습니다.')
    const next = new Map(projects)
    const left = bundles.filter(bundle => bundle.id !== id)
    if (left.length) next.set(key, left)
    else next.delete(key)
    write(next)
    return left
  }

  /** The presets a bundle (by id from the screen, by name from the MCP tools) starts; an error when there is none */
  function selection(key, presetIds, which) {
    const bundle = findBundle(list(key, presetIds), which)
    if (!bundle) throw new Error('실행 묶음을 찾지 못했습니다. 목록을 다시 열어 주세요.')
    return bundle.presetIds
  }

  return { list, save, remove, selection }
}

module.exports = { createRunBundleStore }
