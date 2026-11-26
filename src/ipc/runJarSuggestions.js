const { createHash } = require('node:crypto')
const { allowedJar, jarHasClass, jarClassName, normalizeJarReferences, searchJarClasses } = require('../runtimes/jarSearch.js')

const STALE_JAR = '최근 실행의 JAR 후보를 다시 확인해 주세요.'
const missingClass = item => item.kind === 'missingClass' && jarClassName(item.className)
const tomcatInvocation = preset => preset.kind === 'tomcat' ? JSON.stringify([
  preset.tomcat, preset.relative, preset.webapp, preset.contextPath, preset.contextXml, preset.prepare
]) : null
const canAttachJar = (preset, run) => run?.jarDiagnosis?.major >= 7 && run.jarDiagnosis.invocation === tomcatInvocation(preset)

async function findJarCandidates(suggestions, projectRoot, home, signal) {
  const classes = suggestions.filter(missingClass)
  if (!classes.length) return new Map()
  const { matches, incomplete } = await searchJarClasses({ projectRoot, home, classNames: classes.map(item => item.className), signal })
  const candidates = new Map()
  const resolved = new Map()
  for (const item of classes) {
    const found = matches.get(item.className)
    const jars = []
    for (const match of found.slice(0, 30)) {
      signal.throwIfAborted()
      if (!resolved.has(match.path)) resolved.set(match.path, await allowedJar({ projectRoot, home, reference: match.path }))
      const jar = resolved.get(match.path)
      if (!jar) continue
      const id = createHash('sha256').update(JSON.stringify([item.id, jar.reference])).digest('hex')
      jars.push({ id, path: jar.displayPath, reference: jar.reference, source: jar.source, coordinate: match.coordinate })
    }
    candidates.set(item.id, { jars, ...(incomplete || found.length > 30 ? { jarSearchIncomplete: true } : {}) })
  }
  return candidates
}

function jarSuggestion(item, candidates, preset, run) {
  const match = candidates.get(item.id)
  if (!match) return item
  const jars = match.jars.filter(jar => !preset.extraLibs?.includes(jar.reference))
    .map(({ reference: _reference, ...jar }) => jar)
  return { ...item, jars, ...(match.jarSearchIncomplete && { jarSearchIncomplete: true }),
    ...(jars.length && canAttachJar(preset, run) && { apply: 'tomcatJar' }) }
}

const visibleJars = (item, candidates, preset) => (candidates.get(item.id)?.jars ?? [])
  .filter(jar => !preset.extraLibs?.includes(jar.reference) && (jar.source === 'project' || jar.coordinate))

function mcpJarSuggestion(item, candidates, preset, run) {
  const { id, apply, ...diagnostic } = item
  const jars = visibleJars(item, candidates, preset)
    .map(jar => ({ ...(jar.source === 'project' && { path: jar.reference }), ...(jar.coordinate && { coordinate: jar.coordinate }) }))
  const proposalKind = apply === 'mavenMirror' || apply === 'mavenUserSettings' ? apply
    : jars.length && canAttachJar(preset, run) ? 'tomcatJar' : undefined
  return { ...diagnostic, ...(jars.length && { jars }), ...(candidates.get(id)?.jarSearchIncomplete && { jarSearchIncomplete: true }),
    ...(proposalKind && { suggestion: id, proposalKind }) }
}

function proposedJarId(item, candidates, preset, reference) {
  if (typeof reference !== 'string' || !reference || reference.length > 4096) throw new Error(STALE_JAR)
  const jars = visibleJars(item, candidates, preset)
  const projectJar = jars.find(jar => jar.source === 'project' && jar.reference === reference)
  if (projectJar) return projectJar.id
  const coordinates = jars.filter(jar => jar.coordinate === reference)
  if (coordinates.length > 1) throw new Error('같은 좌표의 JAR 후보가 여러 개 있습니다. 프로젝트 상대 경로로 구분할 수 있는 후보를 선택해 주세요.')
  if (coordinates.length !== 1) throw new Error(STALE_JAR)
  return coordinates[0].id
}

async function selectedJarReferences({ preset, run, suggestions, request, projectRoot, home, candidates = run?.jarOffered }) {
  const suggestion = suggestions.find(item => item.id === request.id && missingClass(item))
  const candidate = suggestion && candidates?.get(suggestion.id)?.jars.find(item => item.id === request.jarId)
  if (!candidate || !canAttachJar(preset, run) || preset.extraLibs?.includes(candidate.reference) || request.replacementUrl !== undefined) {
    throw new Error(STALE_JAR)
  }
  const extraLibs = normalizeJarReferences([...(preset.extraLibs ?? []), candidate.reference])
  const jar = await allowedJar({ projectRoot, home, reference: candidate.reference })
  if (!jar || jar.reference !== candidate.reference || !await jarHasClass(jar, suggestion.className)) throw new Error(STALE_JAR)
  return extraLibs
}

module.exports = { tomcatInvocation, findJarCandidates, jarSuggestion, mcpJarSuggestion, proposedJarId, selectedJarReferences, STALE_JAR }
