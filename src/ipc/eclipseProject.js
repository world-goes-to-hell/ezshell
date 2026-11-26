const fs = require('node:fs/promises')
const path = require('node:path')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { parseXml } = require('../sessionImport/filezilla.js')

const MAX_SETTINGS_BYTES = 256 * 1024
const SETTINGS = '.settings/'
const CLASS_PATH = '.classpath'
const CONTROL = /[\x00-\x1f\x7f]/
const portable = value => value.split(path.sep).join('/') || '.'
const textChild = (parent, name) => parent?.children.find(item => item.name === name)

async function projectEntry(root, cwd, value) {
  if (typeof value !== 'string' || !value || CONTROL.test(value) || /^(?:[\\/]|[a-z]:)/i.test(value)) return null
  const absolute = path.resolve(cwd, value.replaceAll('\\', '/'))
  if (!sameOrInside(root, absolute)) return null
  const entry = await resolveLocalPreviewPath(absolute).catch(() => null)
  if (!entry || !sameOrInside(root, entry.path) || entry.path.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) return null
  return entry
}

async function readSettings(cwd, name) {
  const entry = await projectEntry(cwd, cwd, name)
  if (!entry) return ''
  if (!entry.stat.isFile() || entry.stat.size > MAX_SETTINGS_BYTES) throw new Error(`${name} 파일을 읽을 수 없거나 너무 큽니다.`)
  const handle = await fs.open(entry.path, 'r')
  try {
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_SETTINGS_BYTES) throw new Error(`${name} 파일이 너무 큽니다.`)
    return bytes.toString('utf8', 0, bytesRead).replace(/^\ufeff/, '')
  } finally { await handle.close() }
}

function parseSettingsXml(value, label) {
  if (!value) return null
  try { return parseXml(value) }
  catch { throw new Error(`${label}의 XML 설정을 읽을 수 없습니다.`) }
}

function preferences(value) {
  const output = new Map()
  for (const line of value.split(/\r?\n/)) {
    const property = /^\s*([^#!][^=]*?)\s*=\s*(.*?)\s*$/.exec(line)
    if (property) output.set(property[1].replace(/\\([ :=])/g, '$1'), property[2])
  }
  return output
}

function javaRelease(value) {
  if (!/^(?:1\.)?\d{1,2}$/.test(value ?? '')) return undefined
  const major = Number(value.replace(/^1\./, ''))
  return major >= 6 ? major : undefined
}

function eclipseTestSource(entry) {
  return entry.attrs.path?.split(/[\\/]/).some(part => /^tests?$/i.test(part)) ||
    textChild(entry, 'attributes')?.children.some(attribute => attribute.name === 'attribute' && attribute.attrs.name === 'test' && attribute.attrs.value === 'true')
}

async function projectEntries(worktree, cwd, names, accept) {
  const output = new Set()
  let skipped = 0
  for (const name of names) {
    const entry = await projectEntry(worktree, cwd, name)
    if (entry && accept(entry)) output.add(entry.path)
    else skipped++
  }
  return { paths: [...output], skipped }
}

async function loadEclipseProject(worktree, cwd) {
  const [classpathXml, componentXml, jdtText, resourcesText, facetXml] = await Promise.all([
    readSettings(cwd, CLASS_PATH),
    readSettings(cwd, `${SETTINGS}org.eclipse.wst.common.component`),
    readSettings(cwd, `${SETTINGS}org.eclipse.jdt.core.prefs`),
    readSettings(cwd, `${SETTINGS}org.eclipse.core.resources.prefs`),
    readSettings(cwd, `${SETTINGS}org.eclipse.wst.common.project.facet.core.xml`)
  ])
  const classpath = parseSettingsXml(classpathXml, CLASS_PATH)
  if (classpath?.name !== 'classpath') throw new Error('선택한 폴더에서 이클립스 .classpath를 찾을 수 없습니다.')
  const entries = classpath.children.filter(item => item.name === 'classpathentry')
  if (entries.length > 512) throw new Error('이클립스 클래스패스 항목이 너무 많습니다.')
  const sourceEntries = entries.filter(entry => entry.attrs.kind === 'src')
  const directories = list => projectEntries(worktree, cwd, list.map(entry => entry.attrs.path), item => item.stat.isDirectory())
  const [sourceSettings, ignoredTestSources, librarySettings, outputSettings] = await Promise.all([
    directories(sourceEntries.filter(entry => !eclipseTestSource(entry))),
    directories(sourceEntries.filter(eclipseTestSource)),
    projectEntries(worktree, cwd, entries.filter(entry => entry.attrs.kind === 'lib').map(entry => entry.attrs.path), item => item.stat.isFile() && /\.jar$/i.test(item.path)),
    projectEntries(worktree, cwd, [...entries.filter(entry => entry.attrs.kind === 'output').map(entry => entry.attrs.path),
      ...sourceEntries.map(entry => entry.attrs.output).filter(Boolean)], item => item.stat.isDirectory())
  ])
  const { paths: sources } = sourceSettings
  const excludedSources = [...new Set([...ignoredTestSources.paths, ...outputSettings.paths])]
  const { paths: libs } = librarySettings
  const component = textChild(parseSettingsXml(componentXml, '웹 구성'), 'wb-module')
  // WTP uses a leading slash for a path relative to this Eclipse project.
  const webPaths = (component?.children ?? []).filter(item => item.name === 'wb-resource' && item.attrs['deploy-path'] === '/')
    .map(item => item.attrs['source-path']?.replace(/^\//, '') || '.')
  let webapp
  for (const name of [...webPaths, 'WebContent', 'src/main/webapp', '.']) {
    const candidate = await projectEntry(worktree, cwd, name)
    if (candidate?.stat.isDirectory() && (await projectEntry(candidate.path, candidate.path, 'WEB-INF'))?.stat.isDirectory()) {
      webapp = candidate.path
      break
    }
  }
  const context = component?.children.find(item => item.name === 'property' && item.attrs.name === 'context-root')?.attrs.value ?? ''
  const contextPath = `/${context.replace(/^\/+/, '')}`
  const java = preferences(jdtText)
  const resources = preferences(resourcesText)
  const facets = parseSettingsXml(facetXml, '프로젝트 facet')?.children.filter(item => item.name === 'installed') ?? []
  const facet = name => facets.find(item => item.attrs.facet === name)?.attrs.version
  const release = javaRelease(java.get('org.eclipse.jdt.core.compiler.compliance')) ?? javaRelease(facet('java'))
  const configuredEncoding = resources.get('encoding/<project>') ??
    sources.map(source => resources.get(`encoding//${portable(path.relative(cwd, source))}`)).find(Boolean)
  const hasEncoding = /^[\w.-]{1,40}$/.test(configuredEncoding ?? '')
  const encoding = hasEncoding ? configuredEncoding : 'MS949'
  const notes = []
  if (release) notes.push(`Java ${release} 설정에 맞는 JDK를 선택해 주세요.`)
  const servlet = facet('jst.web')
  const tomcat = { '2.5': '7', '3.0': '7', '3.1': '8.5 또는 9', '4.0': '9', '5.0': '10.1', '6.0': '10.1', '6.1': '11' }[servlet]
  if (tomcat) notes.push(`웹 facet ${servlet}에 맞는 Tomcat ${tomcat}을 제안합니다.`)
  if (!hasEncoding) notes.push('소스 인코딩 설정이 없어 이클립스식 빌드에 MS949를 사용합니다.')
  if (!webapp) notes.push('WEB-INF가 있는 웹 폴더를 찾지 못했습니다.')
  const warnings = []
  if (sourceSettings.skipped) warnings.push(`워크트리에서 확인할 수 없는 이클립스 소스 폴더 ${sourceSettings.skipped}개를 건너뛰었습니다.`)
  if (librarySettings.skipped) warnings.push(`워크트리에서 확인할 수 없는 이클립스 라이브러리 ${librarySettings.skipped}개를 건너뛰었습니다.`)
  const containers = new Set(entries.filter(entry => entry.attrs.kind === 'con').flatMap(entry => {
    const setting = entry.attrs.path ?? ''
    const name = setting.split('/')[0]
    if (name === 'org.eclipse.jdt.launching.JRE_CONTAINER' || name === 'org.eclipse.jst.j2ee.internal.web.container' ||
        (name === 'org.eclipse.jst.server.core.container' && /tomcat/i.test(setting))) return []
    return /^[a-z0-9._-]{1,100}$/i.test(name) ? [name] : []
  }))
  if (containers.size) warnings.push(`이클립스에서만 해석하는 클래스패스 컨테이너를 건너뛰었습니다. ${[...containers].slice(0, 5).join(', ')}`)
  notes.push(...warnings)
  const relative = file => portable(path.relative(cwd, file))
  return { sources, excludedSources, libs, release, encoding, notes, warnings, draft: { webapp: webapp ? relative(webapp) : '', contextPath,
    ...(release && { release }), encoding, sources: sources.map(relative), libs: libs.map(relative) } }
}

module.exports = { loadEclipseProject, eclipseTestSource, projectEntry }
