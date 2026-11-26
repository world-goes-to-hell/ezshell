// Run bundles of a project (docs/plan/2026-11-26-multi-repo-and-start-order.md, part 3): a saved choice of run
// presets to start and stop together ("주문 개발 = gateway + auth + order"). A bundle only picks presets; the
// order is the project's start order (part 2), and presets not in the bundle are skipped. The screen and the
// MCP tools send what they want; main keeps only what this file accepts.
const { randomUUID } = require('node:crypto')

const MAX_BUNDLES = 20
const MAX_NAME = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u

function bundleName(value) {
  if (typeof value !== 'string') throw new Error('묶음 이름을 입력해 주세요.')
  const name = value.trim()
  if (!name) throw new Error('묶음 이름을 입력해 주세요.')
  if ([...name].length > MAX_NAME) throw new Error(`묶음 이름은 ${MAX_NAME}자까지입니다.`)
  if (NAME_CONTROL.test(name)) throw new Error('묶음 이름에 쓸 수 없는 글자가 있습니다.')
  return name
}

/**
 * One bundle from outside (the screen's save): its id kept when it is one, a name, and the presets it picks among
 * the project's (unknown ids are an error here: the user picked from the list main gave)
 */
function validateBundle(input, presetIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('묶음을 확인해 주세요.')
  const id = input.id === undefined ? randomUUID() : input.id
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('묶음을 확인해 주세요.')
  const name = bundleName(input.name)
  if (!Array.isArray(input.presetIds) || input.presetIds.length > presetIds.size) throw new Error('묶음에 넣을 실행 구성을 확인해 주세요.')
  const picked = [...new Set(input.presetIds)]
  if (!picked.length) throw new Error('묶음에 넣을 실행 구성을 하나 이상 골라 주세요.')
  if (picked.some(presetId => typeof presetId !== 'string' || !presetIds.has(presetId))) throw new Error('없는 실행 구성이 묶음에 있습니다. 목록을 다시 열어 주세요.')
  return { id, name, presetIds: picked }
}

/**
 * The bundles kept with a project, as read from the file or after its presets changed: malformed ones and repeated
 * names are dropped, ids of presets that are gone are taken out, a bundle left with none goes
 */
function keepBundles(input, presetIds) {
  if (!Array.isArray(input)) return []
  const ids = new Set()
  const names = new Set()
  const kept = []
  for (const entry of input.slice(0, MAX_BUNDLES)) {
    try {
      if (!entry || typeof entry.id !== 'string' || !UUID.test(entry.id) || ids.has(entry.id)) continue
      const name = bundleName(entry.name)
      if (names.has(name) || !Array.isArray(entry.presetIds)) continue
      const picked = [...new Set(entry.presetIds.filter(presetId => typeof presetId === 'string' && presetIds.has(presetId)))]
      if (!picked.length) continue
      ids.add(entry.id)
      names.add(name)
      kept.push({ id: entry.id, name, presetIds: picked })
    } catch { /* Ignore a malformed bundle and keep the others. */ }
  }
  return kept
}

/** The bundles after saving one (a new one, or the same id replaced); a name used by another bundle is refused */
function saveBundle(bundles, input, presetIds) {
  const bundle = validateBundle(input, presetIds)
  if (bundles.some(item => item.name === bundle.name && item.id !== bundle.id)) throw new Error('같은 이름의 묶음이 있습니다.')
  const at = bundles.findIndex(item => item.id === bundle.id)
  if (at < 0 && bundles.length >= MAX_BUNDLES) throw new Error(`묶음은 ${MAX_BUNDLES}개까지 만들 수 있습니다.`)
  const next = [...bundles]
  if (at < 0) next.push(bundle)
  else next[at] = bundle
  return next
}

/** The bundle an id or (for the MCP tools) a name means; null when there is none */
function findBundle(bundles, { id, name } = {}) {
  if (typeof id === 'string') return bundles.find(item => item.id === id) ?? null
  if (typeof name === 'string') return bundles.find(item => item.name === name.trim()) ?? null
  return null
}

module.exports = { MAX_BUNDLES, MAX_NAME, validateBundle, keepBundles, saveBundle, findBundle, bundleName }
